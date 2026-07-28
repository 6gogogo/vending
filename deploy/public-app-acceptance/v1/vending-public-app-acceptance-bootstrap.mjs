import { createHash } from "node:crypto";
import { spawnSync as defaultSpawnSync } from "node:child_process";
import * as nativeFs from "node:fs";
import * as nativePath from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RUNTIME_VERSION = "v1";
export const RUNTIME_ROOT = "/usr/local/lib/vending-public-app-acceptance/v1";
export const BOOTSTRAP_FILE_NAME = "vending-public-app-acceptance-bootstrap.mjs";
export const MANIFEST_FILE_NAME = "manifest.json";
export const MANIFEST_DIGEST_FILE_NAME = "manifest.sha256";
export const RUNTIME_ENTRY_FILE_NAME = "run-public-app-acceptance.mjs";
export const REQUIRED_RUNTIME_FILES = Object.freeze([
  BOOTSTRAP_FILE_NAME,
  RUNTIME_ENTRY_FILE_NAME,
  "public-app-acceptance.mjs",
  "vnc-local-session.mjs",
  "first-backoffice-password-maintenance.mjs"
]);

const manifestSchema = "vending-public-app-acceptance-runtime/v1";
const rootFileMode = 0o600;
const rootRuntimeDirectoryMode = 0o700;
const rootDirectoryModeMask = 0o022;
const safeHashPattern = /^[a-f0-9]{64}$/u;
const safeCommitPattern = /^[a-f0-9]{40,64}$/u;
const serviceUserName = "fivegogogo";
const commandEnvironment = Object.freeze({ PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" });

export class SealedRuntimeError extends Error {
  constructor(code) {
    super(code);
    this.name = "SealedRuntimeError";
    this.code = code;
  }
}

const fail = (code) => {
  throw new SealedRuntimeError(code);
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const isExactFileSet = (value, expected) =>
  Array.isArray(value) &&
  value.length === expected.length &&
  value.every((entry, index) => entry === expected[index]);

const assertRootOwnedDirectory = (metadata) => {
  if (
    !metadata?.isDirectory?.() ||
    metadata.isSymbolicLink?.() === true ||
    metadata.uid !== 0 ||
    metadata.gid !== 0 ||
    (metadata.mode & rootDirectoryModeMask) !== 0
  ) {
    fail("root_controlled_directory_required");
  }
};

const assertRootPrivateRuntimeDirectory = (metadata) => {
  if (
    !metadata?.isDirectory?.() ||
    metadata.isSymbolicLink?.() === true ||
    metadata.uid !== 0 ||
    metadata.gid !== 0 ||
    (metadata.mode & 0o777) !== rootRuntimeDirectoryMode
  ) {
    fail("root_private_runtime_directory_required");
  }
};

const assertRootOwnedRegularFile = (metadata) => {
  if (
    !metadata?.isFile?.() ||
    metadata.isSymbolicLink?.() === true ||
    metadata.uid !== 0 ||
    metadata.gid !== 0 ||
    (metadata.mode & 0o777) !== rootFileMode
  ) {
    fail("root_controlled_file_required");
  }
};

const assertRootOwnedExecutable = (metadata) => {
  if (
    !metadata?.isFile?.() ||
    metadata.isSymbolicLink?.() === true ||
    metadata.uid !== 0 ||
    metadata.gid !== 0 ||
    (metadata.mode & 0o022) !== 0 ||
    (metadata.mode & 0o111) === 0
  ) {
    fail("root_controlled_executable_required");
  }
};

const assertTrustedNodeBinary = ({ fs, pathApi, execPath }) => {
  if (pathApi.resolve(String(execPath ?? "")) !== "/usr/bin/node") {
    fail("system_node_required");
  }

  assertRootOwnedExecutable(fs.lstatSync("/usr/bin/node"));
};

export const assertRootOwnedDirectoryChain = ({ fs = nativeFs, pathApi = nativePath, directoryPath }) => {
  let currentPath = pathApi.resolve(directoryPath);

  while (true) {
    assertRootOwnedDirectory(fs.lstatSync(currentPath));
    const parentPath = pathApi.dirname(currentPath);

    if (parentPath === currentPath) {
      return;
    }
    currentPath = parentPath;
  }
};

const parseManifest = ({ fs, manifestPath, manifestDigestPath }) => {
  const rawManifest = fs.readFileSync(manifestPath);
  const expectedDigest = String(fs.readFileSync(manifestDigestPath, "utf8") ?? "").trim();

  if (!safeHashPattern.test(expectedDigest) || sha256(rawManifest) !== expectedDigest) {
    fail("manifest_digest_mismatch");
  }

  try {
    return JSON.parse(String(rawManifest));
  } catch {
    fail("invalid_manifest");
  }
};

const assertManifestContract = ({ manifest, runtimeRoot }) => {
  if (
    !manifest ||
    manifest.schema !== manifestSchema ||
    manifest.version !== RUNTIME_VERSION ||
    !safeCommitPattern.test(String(manifest.sourceCommit ?? "")) ||
    manifest.runtimeRoot !== runtimeRoot ||
    manifest.entrypoint !== BOOTSTRAP_FILE_NAME ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  ) {
    fail("invalid_manifest");
  }

  const fileNames = Object.keys(manifest.files).sort();
  const expectedFileNames = [...REQUIRED_RUNTIME_FILES].sort();
  if (!isExactFileSet(fileNames, expectedFileNames)) {
    fail("invalid_manifest_file_set");
  }

  for (const fileName of REQUIRED_RUNTIME_FILES) {
    if (!safeHashPattern.test(String(manifest.files[fileName] ?? ""))) {
      fail("invalid_manifest_file_hash");
    }
  }
};

export const assertSealedRuntime = ({
  fs = nativeFs,
  pathApi = nativePath,
  runtimeRoot = RUNTIME_ROOT,
  currentFilePath = fileURLToPath(import.meta.url),
  execPath = process.execPath,
  platform = process.platform,
  uid = process.getuid(),
  environment = process.env
} = {}) => {
  if (platform !== "linux" || uid !== 0) {
    fail("root_bootstrap_linux_required");
  }

  const resolvedRuntimeRoot = fs.realpathSync(runtimeRoot);
  if (resolvedRuntimeRoot !== runtimeRoot) {
    fail("fixed_runtime_path_required");
  }

  const resolvedCurrentFile = fs.realpathSync(currentFilePath);
  const expectedBootstrapPath = pathApi.join(runtimeRoot, BOOTSTRAP_FILE_NAME);
  if (resolvedCurrentFile !== expectedBootstrapPath) {
    fail("fixed_entrypoint_path_required");
  }

  const environmentKeys = Object.keys(environment ?? {}).sort();
  if (!isExactFileSet(environmentKeys, ["LANG", "LC_ALL", "PATH"])) {
    fail("sanitized_environment_required");
  }

  assertTrustedNodeBinary({ fs, pathApi, execPath });
  assertRootPrivateRuntimeDirectory(fs.lstatSync(runtimeRoot));
  assertRootOwnedDirectoryChain({ fs, pathApi, directoryPath: runtimeRoot });

  const manifestPath = pathApi.join(runtimeRoot, MANIFEST_FILE_NAME);
  const manifestDigestPath = pathApi.join(runtimeRoot, MANIFEST_DIGEST_FILE_NAME);
  assertRootOwnedRegularFile(fs.lstatSync(manifestPath));
  assertRootOwnedRegularFile(fs.lstatSync(manifestDigestPath));
  const manifest = parseManifest({ fs, manifestPath, manifestDigestPath });
  assertManifestContract({ manifest, runtimeRoot });

  for (const fileName of REQUIRED_RUNTIME_FILES) {
    const filePath = pathApi.join(runtimeRoot, fileName);
    assertRootOwnedRegularFile(fs.lstatSync(filePath));
    if (sha256(fs.readFileSync(filePath)) !== manifest.files[fileName]) {
      fail("runtime_file_hash_mismatch");
    }
  }

  return {
    runtimeRoot,
    entryPath: pathApi.join(runtimeRoot, RUNTIME_ENTRY_FILE_NAME)
  };
};

export const resolveServiceUserIdentity = ({
  spawnSync = defaultSpawnSync,
  userName = serviceUserName
} = {}) => {
  const result = spawnSync("/usr/bin/getent", ["passwd", userName], {
    encoding: "utf8",
    env: commandEnvironment,
    stdio: ["ignore", "pipe", "pipe"]
  });
  const fields = String(result.stdout ?? "").trim().split(":");

  if (
    result.error ||
    result.status !== 0 ||
    fields.length !== 7 ||
    fields[0] !== userName ||
    !/^\d+$/u.test(fields[2]) ||
    !/^\d+$/u.test(fields[3]) ||
    Number(fields[2]) === 0
  ) {
    fail("service_user_identity_invalid");
  }

  return { userName, uid: Number(fields[2]), gid: Number(fields[3]) };
};

export const dropToServiceUser = ({ processRef = process, identity }) => {
  if (
    !identity ||
    typeof identity.userName !== "string" ||
    !Number.isSafeInteger(identity.uid) ||
    !Number.isSafeInteger(identity.gid) ||
    identity.uid <= 0 ||
    identity.gid < 0 ||
    processRef.getuid() !== 0 ||
    typeof processRef.initgroups !== "function" ||
    typeof processRef.setgid !== "function" ||
    typeof processRef.setuid !== "function"
  ) {
    fail("privilege_drop_unavailable");
  }

  try {
    processRef.initgroups(identity.userName, identity.gid);
    processRef.setgid(identity.gid);
    processRef.setuid(identity.uid);
  } catch {
    fail("privilege_drop_failed");
  }

  if (processRef.getuid() !== identity.uid || processRef.getgid?.() !== identity.gid) {
    fail("privilege_drop_failed");
  }
};

export const runSealedPublicAppAcceptance = async () => {
  if (process.argv.length !== 2) {
    fail("arguments_not_allowed");
  }

  const { entryPath } = assertSealedRuntime();
  const module = await import(pathToFileURL(entryPath).href);

  if (typeof module.executePublicAppAcceptance !== "function") {
    fail("runtime_entrypoint_invalid");
  }

  dropToServiceUser({ identity: resolveServiceUserIdentity() });

  try {
    await module.executePublicAppAcceptance();
    return true;
  } catch (error) {
    if (typeof module.printPublicAppAcceptanceFailure !== "function") {
      fail("runtime_entrypoint_invalid");
    }
    module.printPublicAppAcceptanceFailure(error);
    return false;
  }
};

const currentFilePath = fileURLToPath(import.meta.url);
const isDirectExecution =
  process.argv[1] && nativeFs.realpathSync(process.argv[1]) === nativeFs.realpathSync(currentFilePath);

if (isDirectExecution) {
  void runSealedPublicAppAcceptance()
    .then((completed) => {
      if (!completed) {
        process.exitCode = 1;
      }
    })
    .catch(() => {
      process.stderr.write("受控公网 App 验收未完成：已封存运行器完整性或前置校验未通过。\n");
      process.exitCode = 1;
    });
}
