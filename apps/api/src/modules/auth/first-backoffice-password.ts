import type { InMemoryStoreService } from "../../common/store/in-memory-store.service.js";
import { hashAdminPassword, verifyAdminPassword } from "./admin-password.utils.js";

export const FIRST_BACKOFFICE_USERNAME = "admin";
// 已由产品负责人明确授权：首个公网后台管理员允许使用 6 位密码。
// 密码仍只能通过服务器 VNC 本机的非回显终端输入，不能经参数、环境变量或网络接口传入。
export const MIN_FIRST_BACKOFFICE_PASSWORD_LENGTH = 6;

const DEFAULT_FIRST_BACKOFFICE_PASSWORD = "admin";

type FirstPasswordStore = Pick<
  InMemoryStoreService,
  | "users"
  | "findBackofficeCredentialByUsername"
  | "isUserValidForBackofficeRole"
  | "upsertBackofficeCredential"
  | "revokeSessionsForUser"
  | "logOperation"
>;

interface FirstBackofficePasswordTarget {
  user: InMemoryStoreService["users"][number];
  credential: NonNullable<ReturnType<InMemoryStoreService["findBackofficeCredentialByUsername"]>>;
}

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
    !credential.usesDefaultPassword ||
    !verifyAdminPassword(
      DEFAULT_FIRST_BACKOFFICE_PASSWORD,
      credential.passwordSalt,
      credential.passwordHash
    )
  ) {
    throw new Error("admin 账号不处于可初始化的默认密码状态，已拒绝覆盖。");
  }

  const user = store.users.find((entry) => entry.id === credential.userId);

  if (!user || !store.isUserValidForBackofficeRole(user, credential.role)) {
    throw new Error("admin 后台账号不存在、已停用或角色不匹配，已拒绝初始化。");
  }

  return { user, credential };
};

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
