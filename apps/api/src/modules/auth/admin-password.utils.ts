import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

const ADMIN_PASSWORD_KEY_LENGTH = 64;

export const hashAdminPassword = (password: string, salt = randomBytes(16).toString("hex")) => ({
  salt,
  hash: scryptSync(password, salt, ADMIN_PASSWORD_KEY_LENGTH).toString("hex")
});

export const verifyAdminPassword = (password: string, salt: string, expectedHash: string) => {
  const expected = Buffer.from(expectedHash, "hex");
  const actual = scryptSync(password, salt, ADMIN_PASSWORD_KEY_LENGTH);

  return expected.length === actual.length && timingSafeEqual(expected, actual);
};
