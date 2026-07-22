export {};

const [workspaceRoot, resolverName] = process.argv.slice(2);

if (!workspaceRoot || !resolverName) {
  throw new Error("缺少用于解析运行数据文件的临时工作区。");
}

process.chdir(workspaceRoot);

const persistence = await import(
  "../../src/common/store/persistence.js"
);

const resolvedPath = (() => {
  switch (resolverName) {
    case "data":
      return persistence.resolveApiDataFile();
    case "uploads":
      return persistence.resolveUploadDir();
    case "system-log":
      return persistence.resolveSystemLogFile();
    case "backups":
      return persistence.resolveApiBackupDir();
    case "writer-lease":
      return persistence.resolveFinancialSingleWriterLeaseFile();
    default:
      throw new Error(`未知的运行时路径解析器：${resolverName}`);
  }
})();

process.stdout.write(resolvedPath);
