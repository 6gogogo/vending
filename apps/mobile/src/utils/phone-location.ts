export type PhoneLocationFailureKind = "permission-denied" | "unavailable";

export type PhoneLocationRequestCallbacks<T> = {
  success: (value: T) => void;
  fail: (error: unknown) => void;
};

export const requestPhoneLocationWithTimeout = <T>(
  request: (callbacks: PhoneLocationRequestCallbacks<T>) => void,
  timeoutMs = 8_000
) =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(
      () => settle(() => reject(new Error("getLocation:fail timeout"))),
      timeoutMs
    );

    try {
      request({
        success: (value) => settle(() => resolve(value)),
        fail: (error) => settle(() => reject(error))
      });
    } catch (error) {
      settle(() => reject(error));
    }
  });

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
