/**
 * 唯一首个后台管理员的密码策略例外。
 *
 * 该例外只服务于已明确授权的 admin 账号；其他后台账号仍保持常规长度要求。
 */
export const PRIMARY_BACKOFFICE_ADMIN_USERNAME = "admin";
export const PRIMARY_BACKOFFICE_ADMIN_ROLE = "admin";
export const MIN_PRIMARY_BACKOFFICE_ADMIN_PASSWORD_LENGTH = 6;
export const MIN_STANDARD_BACKOFFICE_PASSWORD_LENGTH = 8;

export const getBackofficePasswordMinimumLength = (credential: {
  username: string;
  role: string;
}) =>
  credential.username === PRIMARY_BACKOFFICE_ADMIN_USERNAME &&
  credential.role === PRIMARY_BACKOFFICE_ADMIN_ROLE
    ? MIN_PRIMARY_BACKOFFICE_ADMIN_PASSWORD_LENGTH
    : MIN_STANDARD_BACKOFFICE_PASSWORD_LENGTH;
