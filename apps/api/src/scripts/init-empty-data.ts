import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  createEmptyPersistedState,
  resolveApiDataFile,
  resolveSystemLogFile,
  resolveUploadDir,
  writePersistedState
} from "../common/store/persistence.js";

const keepUploads = process.argv.includes("--keep-uploads");

const dataFile = writePersistedState(createEmptyPersistedState());
const systemLogFile = resolveSystemLogFile();
mkdirSync(dirname(systemLogFile), { recursive: true });
writeFileSync(systemLogFile, "", "utf8");

const uploadDir = resolveUploadDir();

if (!keepUploads && existsSync(uploadDir)) {
  rmSync(uploadDir, { recursive: true, force: true });
}

mkdirSync(uploadDir, { recursive: true });

console.log(`后端业务数据已完全清空并初始化为空库：${dataFile}`);
console.log("API 服务重新启动后，会自动补建默认超级管理员账号：admin / admin");
console.log(`系统审计日志已清空：${systemLogFile}`);
console.log(keepUploads ? `上传目录已保留：${uploadDir}` : `上传目录已清空并重建：${uploadDir}`);
console.log(`当前 API_DATA_FILE：${resolveApiDataFile()}`);
