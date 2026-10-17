import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";

/**
 * flock 使用继承的同一 open file description；辅助进程退出后，父进程的 fd
 * 继续持锁。关闭 fd 或进程退出（包括 SIGKILL/重启）时由内核释放。
 * 这个锚点文件必须永久保留，不能 unlink/rename，否则会分裂为两把锁。
 */
export const withLinuxFileMutex = <T>(path: string, operation: () => T): T => {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW,
    0o600
  );
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1) {
      throw new Error("金融生命周期系统锁必须是独立普通文件。");
    }
    const result = spawnSync("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], {
      stdio: ["ignore", "ignore", "pipe", descriptor],
      timeout: 5_000,
      env: { PATH: "/usr/bin:/bin", LANG: "C" }
    });
    if (result.error || result.status !== 0) {
      throw new Error("金融生命周期系统锁不可用或正在被占用，已停止本次写入。");
    }
    const current = lstatSync(path);
    if (current.dev !== opened.dev || current.ino !== opened.ino || current.isSymbolicLink()) {
      throw new Error("金融生命周期系统锁路径已被替换，已停止本次写入。");
    }
    return operation();
  } finally {
    closeSync(descriptor);
  }
};
