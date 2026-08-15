export type PhoneLocationFailureKind = "permission-denied" | "unavailable";

const readFailureMessage = (error: unknown) => {
  if (typeof error === "string") {
    return error;
  }

  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    if (typeof record.errMsg === "string") {
      return record.errMsg;
    }
    if (typeof record.message === "string") {
      return record.message;
    }
  }

  return "";
};

export const classifyPhoneLocationFailure = (error: unknown): PhoneLocationFailureKind => {
  const message = readFailureMessage(error).toLowerCase();
  return /auth deny|authorize no response|authorization denied|permission denied|scope\.userlocation|user denied|用户拒绝|未授权/.test(
    message
  )
    ? "permission-denied"
    : "unavailable";
};
