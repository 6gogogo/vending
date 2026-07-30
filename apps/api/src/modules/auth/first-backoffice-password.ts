import type { InMemoryStoreService } from "../../common/store/in-memory-store.service.js";
import { hashAdminPassword, verifyAdminPassword } from "./admin-password.utils.js";
import {
  MIN_PRIMARY_BACKOFFICE_ADMIN_PASSWORD_LENGTH,
  PRIMARY_BACKOFFICE_ADMIN_USERNAME
} from "./backoffice-password-policy.js";

export const FIRST_BACKOFFICE_USERNAME = PRIMARY_BACKOFFICE_ADMIN_USERNAME;
// 已由产品负责人明确授权：首个公网后台管理员允许使用 6 位密码。
// 密码仍只能通过服务器 VNC 本机的非回显终端输入，不能经参数、环境变量或网络接口传入。
export const MIN_FIRST_BACKOFFICE_PASSWORD_LENGTH = MIN_PRIMARY_BACKOFFICE_ADMIN_PASSWORD_LENGTH;
export const MIN_ADMIN_BACKOFFICE_PASSWORD_RECOVERY_LENGTH = MIN_PRIMARY_BACKOFFICE_ADMIN_PASSWORD_LENGTH;

const DEFAULT_FIRST_BACKOFFICE_PASSWORD = "admin";

type FirstPasswordStore = Pick<
  InMemoryStoreService,
  | "users"
  | "findBackofficeCredentialByUsername"
  | "isBackofficeCredentialValidForUser"
  | "upsertBackofficeCredential"
  | "revokeSessionsForUser"
  | "logOperation"
>;

interface FirstBackofficePasswordTarget {
  user: InMemoryStoreService["users"][number];
  credential: NonNullable<ReturnType<InMemoryStoreService["findBackofficeCredentialByUsername"]>>;
}

const isDefaultFirstBackofficePassword = (
  credential: FirstBackofficePasswordTarget["credential"]
) =>
  credential.usesDefaultPassword &&
  verifyAdminPassword(
    DEFAULT_FIRST_BACKOFFICE_PASSWORD,
    credential.passwordSalt,
    credential.passwordHash
  );

/**
 * 仅为已经部署过、但仍保留默认 admin 密码的后台提供一次受控初始化。
 * 密码本身由调用方从本机 TTY 获取；本模块不读取 argv、环境变量或配置文件中的密码。
 */
export const assertFirstBackofficePasswordTarget = (
  store: FirstPasswordStore
): FirstBackofficePasswordTarget => {
  const credential = store.findBackofficeCredentialByUsername(FIRST_BACKOFFICE_USERNAME);

  if (
    !credential ||
    credential.username !== FIRST_BACKOFFICE_USERNAME ||
    credential.role !== "admin" ||
    !isDefaultFirstBackofficePassword(credential)
  ) {
    throw new Error("admin 账号不处于可初始化的默认密码状态，已拒绝覆盖。");
  }

  const user = store.users.find((entry) => entry.id === credential.userId);

  if (!user || !store.isBackofficeCredentialValidForUser(user, credential)) {
    throw new Error("admin 后台账号不存在、已停用或角色不匹配，已拒绝初始化。");
  }

  return { user, credential };
};

/**
 * 返回唯一 admin 的可维护目标，不要求它仍处于默认密码状态。
 * 已知当前密码时，VNC 本机维护入口应走此分支进行验证后改密；只有遗忘当前密码
 * 才需要走单独的恢复入口。
 */
export const assertAdminBackofficePasswordMaintenanceTarget = (
  store: FirstPasswordStore
): FirstBackofficePasswordTarget => {
  const credential = store.findBackofficeCredentialByUsername(FIRST_BACKOFFICE_USERNAME);

  if (
    !credential ||
    credential.username !== FIRST_BACKOFFICE_USERNAME ||
    credential.role !== "admin"
  ) {
    throw new Error("唯一 admin 后台账号不存在或角色不匹配，已拒绝维护。");
  }

  const user = store.users.find((entry) => entry.id === credential.userId);

  if (!user || !store.isBackofficeCredentialValidForUser(user, credential)) {
    throw new Error("admin 后台账号不存在、已停用或角色不匹配，已拒绝维护。");
  }

  return { user, credential };
};

export const isAdminBackofficePasswordAwaitingInitialization = (
  target: FirstBackofficePasswordTarget
) => isDefaultFirstBackofficePassword(target.credential);

export const assertCurrentAdminBackofficePassword = (
  store: FirstPasswordStore,
  currentPassword: string
): FirstBackofficePasswordTarget => {
  const target = assertAdminBackofficePasswordMaintenanceTarget(store);

  if (
    !verifyAdminPassword(
      currentPassword,
      target.credential.passwordSalt,
      target.credential.passwordHash
    )
  ) {
    throw new Error("当前 admin 密码不正确，未修改任何数据。");
  }

  return target;
};

/**
 * 只供服务器 VNC 本机受控维护器恢复唯一的 admin 后台账号。
 * 这不是通用找回能力：不接受用户名参数，也不能由 HTTP、环境变量或命令行调用。
 */
export const assertAdminBackofficePasswordRecoveryTarget = (
  store: FirstPasswordStore
): FirstBackofficePasswordTarget => assertAdminBackofficePasswordMaintenanceTarget(store);

export const initializeFirstBackofficePassword = (
  store: FirstPasswordStore,
  rawPassword: string
) => {
  const password = rawPassword.trim();

  if (password.length < MIN_FIRST_BACKOFFICE_PASSWORD_LENGTH) {
    throw new Error(`首次后台密码至少需要 ${MIN_FIRST_BACKOFFICE_PASSWORD_LENGTH} 位。`);
  }

  const { user, credential } = assertFirstBackofficePasswordTarget(store);
  const passwordHash = hashAdminPassword(password);
  const updatedCredential = store.upsertBackofficeCredential({
    ...credential,
    passwordSalt: passwordHash.salt,
    passwordHash: passwordHash.hash,
    usesDefaultPassword: false,
    passwordUpdatedAt: new Date().toISOString()
  });

  const revokedSessionCount = store.revokeSessionsForUser(user.id);
  store.logOperation({
    category: "admin",
    type: "initialize-first-backoffice-password",
    status: "success",
    actor: {
      type: "system",
      id: "local-tty-maintenance",
      name: "本机首次密码初始化"
    },
    primarySubject: {
      type: "user",
      id: user.id,
      label: user.name
    },
    metadata: {
      username: updatedCredential.username,
      backofficeRole: updatedCredential.role,
      initializationMethod: "local-tty",
      revokedSessionCount,
      undoState: "not_undoable"
    }
  });

  return {
    user,
    credential: updatedCredential,
    revokedSessionCount
  };
};

export const recoverAdminBackofficePassword = (
  store: FirstPasswordStore,
  rawPassword: string
) => {
  const password = rawPassword.trim();

  if (password.length < MIN_ADMIN_BACKOFFICE_PASSWORD_RECOVERY_LENGTH) {
    throw new Error(
      `admin 恢复密码至少需要 ${MIN_ADMIN_BACKOFFICE_PASSWORD_RECOVERY_LENGTH} 位。`
    );
  }

  const { user, credential } = assertAdminBackofficePasswordRecoveryTarget(store);
  const passwordHash = hashAdminPassword(password);
  const updatedCredential = store.upsertBackofficeCredential({
    ...credential,
    passwordSalt: passwordHash.salt,
    passwordHash: passwordHash.hash,
    usesDefaultPassword: false,
    passwordUpdatedAt: new Date().toISOString()
  });

  const revokedSessionCount = store.revokeSessionsForUser(user.id);
  store.logOperation({
    category: "admin",
    type: "recover-admin-backoffice-password",
    status: "success",
    actor: {
      type: "system",
      id: "local-tty-maintenance",
      name: "本机 admin 密码恢复"
    },
    primarySubject: {
      type: "user",
      id: user.id,
      label: user.name
    },
    metadata: {
      username: updatedCredential.username,
      backofficeRole: updatedCredential.role,
      recoveryMethod: "local-tty",
      revokedSessionCount,
      undoState: "not_undoable"
    }
  });

  return {
    user,
    credential: updatedCredential,
    revokedSessionCount
  };
};

/**
 * 已知当前密码的本机维护改密。它不能绕过当前密码验证，也不接受用户名、租户或角色参数。
 */
export const changeAdminBackofficePasswordWithCurrentPassword = (
  store: FirstPasswordStore,
  currentPassword: string,
  rawPassword: string
) => {
  const password = rawPassword.trim();
  const { user, credential } = assertCurrentAdminBackofficePassword(store, currentPassword);

  if (password.length < MIN_FIRST_BACKOFFICE_PASSWORD_LENGTH) {
    throw new Error(`admin 新密码至少需要 ${MIN_FIRST_BACKOFFICE_PASSWORD_LENGTH} 位。`);
  }

  if (verifyAdminPassword(password, credential.passwordSalt, credential.passwordHash)) {
    throw new Error("新密码不能与当前密码相同。");
  }

  const passwordHash = hashAdminPassword(password);
  const updatedCredential = store.upsertBackofficeCredential({
    ...credential,
    passwordSalt: passwordHash.salt,
    passwordHash: passwordHash.hash,
    usesDefaultPassword: false,
    passwordUpdatedAt: new Date().toISOString()
  });

  const revokedSessionCount = store.revokeSessionsForUser(user.id);
  store.logOperation({
    category: "admin",
    type: "change-admin-backoffice-password-with-current-password",
    status: "success",
    actor: {
      type: "system",
      id: "local-tty-maintenance",
      name: "本机 admin 当前密码验证"
    },
    primarySubject: {
      type: "user",
      id: user.id,
      label: user.name
    },
    metadata: {
      username: updatedCredential.username,
      backofficeRole: updatedCredential.role,
      passwordChangeMethod: "local-tty-current-password",
      revokedSessionCount,
      undoState: "not_undoable"
    }
  });

  return {
    user,
    credential: updatedCredential,
    revokedSessionCount
  };
};
