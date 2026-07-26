export const normalizeVerificationCode = (value: string) => value.trim();

export const isVerificationCode = (value: string) =>
  /^\d{4,8}$/u.test(normalizeVerificationCode(value));
