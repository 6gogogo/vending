export const assertInteractiveLocalPasswordTerminal = (operation: string) => {
  if (
    !process.stdin.isTTY ||
    !process.stdout.isTTY ||
    typeof process.stdin.setRawMode !== "function"
  ) {
    throw new Error(
      `${operation}只能在服务器 VNC 本机交互终端中输入，不能经 SSH、管道或命令参数传入。`
    );
  }
};

export const readHiddenLine = (prompt: string) =>
  new Promise<string>((resolve, reject) => {
    const previousRawMode = process.stdin.isRaw;
    let value = "";

    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(previousRawMode);
      process.stdin.pause();
    };

    const finish = (result: string) => {
      cleanup();
      process.stdout.write("\n");
      resolve(result);
    };

    const fail = (error: Error) => {
      cleanup();
      process.stdout.write("\n");
      reject(error);
    };

    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          fail(new Error("已取消本机后台密码维护。"));
          return;
        }

        if (character === "\r" || character === "\n") {
          finish(value);
          return;
        }

        if (character === "\b" || character === "\u007f") {
          value = value.slice(0, -1);
          continue;
        }

        if (character >= " ") {
          value += character;
        }
      }
    };

    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });

export const readConfirmedPassword = async ({
  prompt,
  confirmationPrompt
}: {
  prompt: string;
  confirmationPrompt: string;
}) => {
  const password = await readHiddenLine(prompt);
  const confirmation = await readHiddenLine(confirmationPrompt);

  if (password !== confirmation) {
    throw new Error("两次输入的密码不一致，未修改任何数据。");
  }

  return password;
};
