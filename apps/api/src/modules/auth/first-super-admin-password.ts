import type { InMemoryStoreService } from "../../common/store/in-memory-store.service.js";
import { hashAdminPassword } from "./admin-password.utils.js";
import { MIN_STANDARD_BACKOFFICE_PASSWORD_LENGTH } from "./backoffice-password-policy.js";

export const MIN_FIRST_SUPER_ADMIN_PASSWORD_LENGTH =
  MIN_STANDARD_BACKOFFICE_PASSWORD_LENGTH;

type FirstSuperAdminPasswordStore = Pick<
  InMemoryStoreService,
  | "users"
  | "backofficeCredentials"
  | "isDefaultSuperAdminBootstrapCredential"
  | "isUserValidForBackofficeRole"
  | "upsertBackofficeCredential"
  | "revokeSessionsForUser"
  | "logOperation"
>;

interface FirstSuperAdminPasswordTarget {
  user: InMemoryStoreService["users"][number];
  credential: InMemoryStoreService["backofficeCredentials"][number];
}

/**
 * 只识别当前模拟平面中唯一的内建服务商账号；调用方不能选择任意用户、角色或租户。
 */
export const assertFirstSuperAdminPasswordTarget = (
  store: FirstSuperAdminPasswordStore
): FirstSuperAdminPasswordTarget => {
  const candidates = store.backofficeCredentials.filter((credential) =>
    store.isDefaultSuperAdminBootstrapCredential(credential)
  );

  if (candidates.length !== 1) {
    throw new Error("服务商超级管理员账号不处于可首次改密的默认状态，已拒绝覆盖。");
  }

  const [credential] = candidates;
  const user = store.users.find((entry) => entry.id === credential.userId);

  if (
    !user ||
    credential.role !== "super_admin" ||
    !store.isUserValidForBackofficeRole(user, credential.role)
  ) {
    throw new Error("服务商超级管理员账号不存在、已停用或角色不匹配，已拒绝维护。");
  }

  return { user, credential };
};

/**
 * 仅供服务器 VNC 本机受控维护器执行服务商账号的首次默认密码轮换。
 * 密码由调用方从本机 TTY 获取；本模块不读取 argv、环境变量或配置文件中的密码。
 */
export const initializeFirstSuperAdminPassword = (
  store: FirstSuperAdminPasswordStore,
  rawPassword: string
) => {
  const password = rawPassword.trim();

  if (password.length < MIN_FIRST_SUPER_ADMIN_PASSWORD_LENGTH) {
    throw new Error(
      `服务商超级管理员首次密码至少需要 ${MIN_FIRST_SUPER_ADMIN_PASSWORD_LENGTH} 位。`
    );
  }

  const { user, credential } = assertFirstSuperAdminPasswordTarget(store);
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
    type: "initialize-first-super-admin-password",
    status: "success",
    actor: {
      type: "system",
      id: "local-tty-maintenance",
      name: "本机服务商首次密码初始化"
    },
    primarySubject: {
      type: "user",
      id: user.id,
      label: user.name
    },
    metadata: {
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
