import { timingSafeEqual, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as nativeFs from "node:fs";
import * as nativePath from "node:path";
import { pathToFileURL } from "node:url";

export const ACTION_VERSION = "v1";
export const ACTION_ROOT = "/usr/local/lib/vending-public-ingress-admin/v1";
export const PLAN_FILE_NAME = "vending-public-ingress.plan.json";
export const PLAN_DIGEST_FILE_NAME = "vending-public-ingress.plan.sha256";
export const ACTION_ENTRYPOINT_FILE_NAME = "vending-public-ingress-root-action.mjs";
export const PREPARATION_ENTRYPOINT_FILE_NAME = "vending-public-ingress-prepare-root-action.mjs";
export const ROLLBACK_ENTRYPOINT_FILE_NAME = "vending-public-ingress-rollback-root-action.mjs";
export const ROLLBACK_READINESS_ENTRYPOINT_FILE_NAME =
  "vending-public-ingress-rollback-readiness-root-action.mjs";
export const CONTRACT_VERIFIER_FILE_NAME = "verify-vnc-nginx-edge-contract.mjs";
export const PLAN_PATH = `${ACTION_ROOT}/${PLAN_FILE_NAME}`;
export const PLAN_DIGEST_PATH = `${ACTION_ROOT}/${PLAN_DIGEST_FILE_NAME}`;
export const FIXED_SECRET_SOURCE = "/etc/vending/secrets/vending-private-api-relay.token";
export const FIXED_TARGETS = Object.freeze({
  tmpfiles: "/etc/tmpfiles.d/vending-edge.conf",
  nginxFragment: "/etc/nginx/snippets/vending-api-edge-unix-socket.conf",
  nginxVhost: "/etc/nginx/conf.d/vending.5gogogo.top.conf",
  secretTarget: "/etc/vending/credentials/vnc/private-api-relay.token"
});
export const FIXED_COMMANDS = Object.freeze({
  tmpfiles: Object.freeze({
    command: "/usr/bin/systemd-tmpfiles",
    args: Object.freeze(["--create", "--prefix", "/run/vending"])
  }),
  nginxTest: Object.freeze({ command: "/usr/sbin/nginx", args: Object.freeze(["-t"]) }),
  nginxReload: Object.freeze({ command: "/usr/sbin/nginx", args: Object.freeze(["-s", "reload"]) })
});

const payloadIds = Object.freeze(["tmpfiles", "nginxFragment", "nginxVhost"]);
const activationPayloadIds = Object.freeze(["nginxFragment", "nginxVhost"]);
const activationSnapshotFiles = Object.freeze({
  nginxFragment: "nginx-fragment.backup",
  nginxVhost: "nginx-vhost.backup"
});
const activationSnapshotManifestFileName = "activation-snapshot-manifest.json";
const activationSnapshotManifestSchema = "vending-public-ingress-activation-snapshot/v1";
const fixedPayloadFiles = Object.freeze({
  tmpfiles: "payload/vending-edge.conf",
  nginxFragment: "payload/vending-api-edge-unix-socket.conf",
  nginxVhost: "payload/vending.5gogogo.top.conf"
});
const sha256Pattern = /^[a-f0-9]{64}$/u;
const rootFileMode = 0o644;
const rootSecretMode = 0o600;
const rootPrivateDirectoryMode = 0o700;
const rootCredentialDirectoryMode = 0o755;
const vncCredentialDirectoryMode = 0o710;
const vncSecretMode = 0o600;
const absentSnapshotSuffix = ".absent";
const apiSocketDirectoryPath = "/run/vending";
const apiSocketPath = "/run/vending/api-edge.sock";
const apiSocketDirectoryMode = 0o2710;
const apiSocketMode = 0o660;
const auditDirectoryPath = "/var/log/vending-public-ingress-admin";
const auditFilePath = `${auditDirectoryPath}/audit.log`;

const syncNativePath = (filePath) => {
  const descriptor = nativeFs.openSync(filePath, nativeFs.constants.O_RDONLY);
  try {
    nativeFs.fsyncSync(descriptor);
  } finally {
    nativeFs.closeSync(descriptor);
  }
};

export class RootActionFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

const fail = (code) => {
  throw new RootActionFailure(code);
};

const sha256 = (content) => createHash("sha256").update(content).digest("hex");

export const sha256File = (fs, filePath) => sha256(fs.readFileSync(filePath));

export const assertRootOwnedRegularFile = (metadata, expectedMode) => {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    metadata.gid !== 0 ||
    (metadata.mode & 0o777) !== expectedMode
  ) {
    fail("root_owned_file_required");
  }
};

export const assertRootOwnedDirectory = (metadata) => {
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    metadata.gid !== 0 ||
    (metadata.mode & 0o022) !== 0
  ) {
    fail("root_owned_directory_required");
  }
};

const isSha256 = (value) => typeof value === "string" && sha256Pattern.test(value);

const assertExpectedState = (value) => {
  if (value !== "absent-or-same" && !isSha256(value)) {
    fail("invalid_expected_state");
  }
};

const assertRelativePayloadPath = (value, expected, pathApi) => {
  if (
    typeof value !== "string" ||
    value !== expected ||
    pathApi.isAbsolute(value) ||
    value.split(/[\\/]/u).includes("..")
  ) {
    fail("invalid_payload_path");
  }
};

export const assertFixedPlan = ({
  plan,
  fixedTargets = FIXED_TARGETS,
  secretSource = FIXED_SECRET_SOURCE,
  pathApi = nativePath
}) => {
  if (
    !plan ||
    plan.schema !== "vending-public-ingress-root-action/v1" ||
    plan.status !== "sealed" ||
    plan.actionVersion !== ACTION_VERSION ||
    plan.secretSource !== secretSource ||
    plan.vncUser !== "vnc" ||
    !plan.targets ||
    !plan.payloads ||
    !plan.expectedCurrent
  ) {
    fail("unsealed_or_invalid_plan");
  }

  for (const [key, target] of Object.entries(fixedTargets)) {
    if (plan.targets[key] !== target) {
      fail("fixed_target_mismatch");
    }
  }

  for (const payloadId of payloadIds) {
    const payload = plan.payloads[payloadId];
    if (!payload || !isSha256(payload.sha256)) {
      fail("invalid_payload_hash");
    }
    assertRelativePayloadPath(payload.file, fixedPayloadFiles[payloadId], pathApi);
    assertExpectedState(plan.expectedCurrent[payloadId]);
  }

  if (plan.secretTargetState !== "absent-or-equal-source") {
    fail("invalid_secret_target_state");
  }
};

const resolveIdentity = (name) => {
  const uidResult = spawnSync("/usr/bin/id", ["-u", name], { encoding: "utf8", stdio: "pipe" });
  const gidResult = spawnSync("/usr/bin/id", ["-g", name], { encoding: "utf8", stdio: "pipe" });
  const uid = Number(uidResult.stdout?.trim());
  const gid = Number(gidResult.stdout?.trim());
  if (
    uidResult.status !== 0 ||
    gidResult.status !== 0 ||
    !Number.isSafeInteger(uid) ||
    !Number.isSafeInteger(gid) ||
    uid < 0 ||
    gid < 0
  ) {
    fail("system_identity_unavailable");
  }
  return { uid, gid };
};

const createNativeRuntime = () => {
  const runtime = {
    fs: nativeFs,
    path: nativePath,
    isRoot: () => typeof process.getuid === "function" && process.getuid() === 0,
    setOwnership: (filePath, uid, gid) => nativeFs.chownSync(filePath, uid, gid),
    syncFile: (filePath) => syncNativePath(filePath),
    syncDirectory: (directoryPath) => syncNativePath(directoryPath),
    resolveVncIdentity: () => resolveIdentity("vnc"),
    resolveNginxIdentity: () => resolveIdentity("www-data"),
    runFixedCommand: (stage) => {
      const definition = FIXED_COMMANDS[stage];
      if (!definition) {
        fail("unknown_fixed_command");
      }
      const result = spawnSync(definition.command, definition.args, { stdio: "ignore" });
      if (result.error || result.status !== 0) {
        fail(`${stage}_failed`);
      }
    }
  };
  runtime.assertNginxWorkerBoundary = () => assertNginxWorkerBoundary();
  runtime.assertApiEdgeReady = (identity) => assertApiEdgeReady({ runtime, identity });
  runtime.snapshotApiSocketDirectory = (identity) =>
    snapshotApiSocketDirectory({ runtime, identity });
  runtime.restoreApiSocketDirectory = (snapshot, identity) =>
    restoreApiSocketDirectory({ runtime, snapshot, identity });
  runtime.ensureAuditLog = () => ensureAuditLog({ runtime });
  runtime.recordAuditEvent = (event) => recordAuditEvent({ runtime, event });
  runtime.verifyNginxContract = (actionRoot) => verifyNginxContract({ runtime, actionRoot });
  return runtime;
};

const assertRootDirectoryChain = ({ runtime, directoryPath }) => {
  let currentPath = runtime.path.resolve(directoryPath);
  for (;;) {
    assertRootOwnedDirectory(runtime.fs.lstatSync(currentPath));
    const parentPath = runtime.path.dirname(currentPath);
    if (parentPath === currentPath) {
      return;
    }
    currentPath = parentPath;
  }
};

const assertRootOwnedExecutable = (metadata) => {
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    metadata.gid !== 0 ||
    (metadata.mode & 0o022) !== 0 ||
    (metadata.mode & 0o100) === 0
  ) {
    fail("trusted_executable_required");
  }
};

const assertTrustedExecutable = ({ runtime, executablePath }) => {
  const resolvedPath = runtime.fs.realpathSync(executablePath);
  assertRootDirectoryChain({ runtime, directoryPath: runtime.path.dirname(resolvedPath) });
  assertRootOwnedExecutable(runtime.fs.lstatSync(resolvedPath));
  return resolvedPath;
};

const assertNginxWorkerBoundary = () => {
  const workers = spawnSync("/usr/bin/ps", ["-eo", "user=,group=,comm="], {
    encoding: "utf8",
    stdio: "pipe"
  });
  if (workers.status !== 0) {
    fail("nginx_worker_check_failed");
  }
  const nginxWorkers = workers.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim().split(/\s+/u))
    .filter((parts) => parts.length >= 3 && parts.at(-1) === "nginx" && parts[0] !== "root");
  if (
    nginxWorkers.length === 0 ||
    nginxWorkers.some((parts) => parts[0] !== "www-data" || parts[1] !== "www-data")
  ) {
    fail("nginx_worker_identity_invalid");
  }

  const adminGroups = spawnSync("/usr/bin/id", ["-nG", "admin"], {
    encoding: "utf8",
    stdio: "pipe"
  });
  if (
    adminGroups.status !== 0 ||
    adminGroups.stdout
      .trim()
      .split(/\s+/u)
      .includes("www-data")
  ) {
    fail("admin_socket_group_invalid");
  }
};

const assertApiEdgeReady = ({ runtime, identity }) => {
  const nginxIdentity = runtime.resolveNginxIdentity();
  const socketDirectory = runtime.fs.lstatSync(apiSocketDirectoryPath);
  if (
    !socketDirectory.isDirectory() ||
    socketDirectory.isSymbolicLink() ||
    socketDirectory.uid !== identity.uid ||
    socketDirectory.gid !== nginxIdentity.gid ||
    (socketDirectory.mode & 0o7777) !== apiSocketDirectoryMode
  ) {
    fail("api_socket_directory_invalid");
  }

  const socket = runtime.fs.lstatSync(apiSocketPath);
  if (
    !socket.isSocket() ||
    socket.isSymbolicLink() ||
    socket.uid !== identity.uid ||
    socket.gid !== nginxIdentity.gid ||
    (socket.mode & 0o777) !== apiSocketMode
  ) {
    fail("api_socket_invalid");
  }

  runtime.assertNginxWorkerBoundary();
  const positiveProbe = spawnSync(
    "/usr/sbin/runuser",
    [
      "-u",
      "www-data",
      "--",
      "/usr/bin/curl",
      "--max-time",
      "10",
      "--unix-socket",
      apiSocketPath,
      "-fsS",
      "-o",
      "/dev/null",
      "-H",
      "Host: vending.5gogogo.top",
      "-H",
      "X-Real-IP: 198.51.100.1",
      "-H",
      "X-Forwarded-Proto: https",
      "http://vending.5gogogo.top/api/health"
    ],
    { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } }
  );
  if (positiveProbe.status !== 0) {
    fail("api_socket_positive_probe_failed");
  }

  const negativeProbe = spawnSync(
    "/usr/sbin/runuser",
    [
      "-u",
      "admin",
      "--",
      "/usr/bin/curl",
      "--max-time",
      "3",
      "--unix-socket",
      apiSocketPath,
      "-sS",
      "-o",
      "/dev/null",
      "http://vending.5gogogo.top/api/health"
    ],
    { stdio: "ignore", env: { PATH: "/usr/bin:/bin" } }
  );
  if (negativeProbe.status === 0) {
    fail("api_socket_negative_probe_failed");
  }
};

const assertExpectedApiSocketDirectory = ({ runtime, identity }) => {
  const nginxIdentity = runtime.resolveNginxIdentity();
  const metadata = runtime.fs.lstatSync(apiSocketDirectoryPath);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== identity.uid ||
    metadata.gid !== nginxIdentity.gid ||
    (metadata.mode & 0o7777) !== apiSocketDirectoryMode
  ) {
    fail("api_socket_directory_invalid");
  }
};

const snapshotApiSocketDirectory = ({ runtime, identity }) => {
  if (!runtime.fs.existsSync(apiSocketDirectoryPath)) {
    return { existed: false };
  }
  assertExpectedApiSocketDirectory({ runtime, identity });
  return { existed: true };
};

const restoreApiSocketDirectory = ({ runtime, snapshot, identity }) => {
  if (snapshot.existed || !runtime.fs.existsSync(apiSocketDirectoryPath)) {
    return;
  }
  assertExpectedApiSocketDirectory({ runtime, identity });
  if (runtime.fs.readdirSync(apiSocketDirectoryPath).length !== 0) {
    fail("api_socket_directory_rollback_not_empty");
  }
  runtime.fs.rmdirSync(apiSocketDirectoryPath);
};

const verifyNginxContract = ({ runtime, actionRoot }) => {
  const nodePath = assertTrustedExecutable({ runtime, executablePath: "/usr/bin/node" });
  const verifierPath = runtime.path.join(actionRoot, CONTRACT_VERIFIER_FILE_NAME);
  assertRootOwnedRegularFile(runtime.fs.lstatSync(verifierPath), rootFileMode);
  const nginxConfig = spawnSync("/usr/sbin/nginx", ["-T"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (nginxConfig.status !== 0) {
    fail("nginx_contract_dump_failed");
  }
  const verifier = spawnSync(nodePath, [verifierPath], {
    encoding: "utf8",
    input: `${nginxConfig.stdout}${nginxConfig.stderr}`,
    stdio: ["pipe", "ignore", "ignore"],
    env: { PATH: "/usr/bin:/bin" }
  });
  if (verifier.status !== 0) {
    fail("nginx_contract_failed");
  }
};

const assertExactRootPrivateDirectory = ({ runtime, directoryPath, mode }) => {
  const metadata = runtime.fs.lstatSync(directoryPath);
  assertRootOwnedDirectory(metadata);
  if ((metadata.mode & 0o777) !== mode) {
    fail("root_private_directory_required");
  }
};

const ensureRootPrivateDirectoryTree = ({ runtime, directoryPath, mode }) => {
  const missingDirectories = [];
  let currentPath = runtime.path.resolve(directoryPath);
  while (!runtime.fs.existsSync(currentPath)) {
    missingDirectories.push(currentPath);
    const parentPath = runtime.path.dirname(currentPath);
    if (parentPath === currentPath) {
      fail("root_directory_parent_missing");
    }
    currentPath = parentPath;
  }

  assertRootDirectoryChain({ runtime, directoryPath: currentPath });
  for (const missingDirectory of missingDirectories.reverse()) {
    const parentPath = runtime.path.dirname(missingDirectory);
    runtime.fs.mkdirSync(missingDirectory, { mode });
    runtime.fs.chmodSync(missingDirectory, mode);
    runtime.setOwnership(missingDirectory, 0, 0);
    assertExactRootPrivateDirectory({ runtime, directoryPath: missingDirectory, mode });
    runtime.syncDirectory(missingDirectory);
    runtime.syncDirectory(parentPath);
  }
  assertExactRootPrivateDirectory({ runtime, directoryPath, mode });
};

const ensureAuditLog = ({ runtime }) => {
  ensureRootPrivateDirectoryTree({
    runtime,
    directoryPath: auditDirectoryPath,
    mode: rootPrivateDirectoryMode
  });
  if (!runtime.fs.existsSync(auditFilePath)) {
    const descriptor = runtime.fs.openSync(
      auditFilePath,
      nativeFs.constants.O_CREAT | nativeFs.constants.O_EXCL | nativeFs.constants.O_WRONLY,
      rootSecretMode
    );
    runtime.fs.closeSync(descriptor);
    runtime.fs.chmodSync(auditFilePath, rootSecretMode);
    runtime.setOwnership(auditFilePath, 0, 0);
    runtime.syncFile(auditFilePath);
    runtime.syncDirectory(auditDirectoryPath);
  }
  assertRootOwnedRegularFile(runtime.fs.lstatSync(auditFilePath), rootSecretMode);
};

const recordAuditEvent = ({ runtime, event }) => {
  runtime.fs.appendFileSync(
    auditFilePath,
    `${new Date().toISOString()} action=${ACTION_VERSION} plan=${event.planSha256} stage=${event.stage} result=${event.result}\n`,
    { encoding: "utf8", mode: rootSecretMode }
  );
  runtime.syncFile(auditFilePath);
};

const ensureRootCredentialDirectory = ({ runtime, directoryPath }) => {
  if (!runtime.fs.existsSync(directoryPath)) {
    const parentPath = runtime.path.dirname(directoryPath);
    assertRootDirectoryChain({ runtime, directoryPath: parentPath });
    runtime.fs.mkdirSync(directoryPath, { mode: rootCredentialDirectoryMode });
    runtime.fs.chmodSync(directoryPath, rootCredentialDirectoryMode);
    runtime.setOwnership(directoryPath, 0, 0);
    assertRootOwnedDirectory(runtime.fs.lstatSync(directoryPath));
    runtime.syncDirectory(directoryPath);
    runtime.syncDirectory(parentPath);
    return true;
  }

  assertRootOwnedDirectory(runtime.fs.lstatSync(directoryPath));
  return false;
};

const assertRootVncCredentialDirectory = ({ runtime, directoryPath, identity }) => {
  const metadata = runtime.fs.lstatSync(directoryPath);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== 0 ||
    metadata.gid !== identity.gid ||
    (metadata.mode & 0o777) !== vncCredentialDirectoryMode
  ) {
    fail("root_vnc_credential_directory_required");
  }
};

const ensureRootVncCredentialDirectory = ({ runtime, directoryPath, identity }) => {
  if (runtime.fs.existsSync(directoryPath)) {
    assertRootVncCredentialDirectory({ runtime, directoryPath, identity });
    return false;
  }

  const parentPath = runtime.path.dirname(directoryPath);
  assertRootDirectoryChain({ runtime, directoryPath: parentPath });
  runtime.fs.mkdirSync(directoryPath, { mode: vncCredentialDirectoryMode });
  runtime.fs.chmodSync(directoryPath, vncCredentialDirectoryMode);
  runtime.setOwnership(directoryPath, 0, identity.gid);
  assertRootVncCredentialDirectory({ runtime, directoryPath, identity });
  runtime.syncDirectory(directoryPath);
  runtime.syncDirectory(parentPath);
  return true;
};

const removeCreatedDirectory = ({ runtime, directoryPath, expected }) => {
  if (!expected) {
    return;
  }
  if (runtime.fs.readdirSync(directoryPath).length !== 0) {
    fail("created_directory_not_empty");
  }
  runtime.fs.rmdirSync(directoryPath);
};

const assertPayload = ({ runtime, actionRoot, payload }) => {
  const sourcePath = runtime.path.join(actionRoot, payload.file);
  assertRootOwnedRegularFile(runtime.fs.lstatSync(sourcePath), rootFileMode);
  if (sha256File(runtime.fs, sourcePath) !== payload.sha256) {
    fail("payload_hash_mismatch");
  }
  return sourcePath;
};

const assertConfigTargetState = ({ runtime, targetPath, expectedHash, payloadHash }) => {
  const exists = runtime.fs.existsSync(targetPath);
  if (!exists) {
    if (expectedHash !== "absent-or-same") {
      fail("config_target_missing");
    }
    return;
  }

  assertRootOwnedRegularFile(runtime.fs.lstatSync(targetPath), rootFileMode);
  const currentHash = sha256File(runtime.fs, targetPath);
  if (
    (expectedHash === "absent-or-same" && currentHash !== payloadHash) ||
    (expectedHash !== "absent-or-same" && currentHash !== expectedHash)
  ) {
    fail("config_target_hash_mismatch");
  }
};

const assertCurrentPayloadTarget = ({ runtime, targetPath, payloadHash }) => {
  assertRootOwnedRegularFile(runtime.fs.lstatSync(targetPath), rootFileMode);
  if (sha256File(runtime.fs, targetPath) !== payloadHash) {
    fail("rollback_target_hash_mismatch");
  }
};

const assertPrivateToken = ({ runtime, filePath, expectedOwner }) => {
  const metadata = runtime.fs.lstatSync(filePath);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== expectedOwner.uid ||
    metadata.gid !== expectedOwner.gid ||
    (metadata.mode & 0o777) !== vncSecretMode
  ) {
    fail("vnc_private_token_required");
  }

  const value = runtime.fs.readFileSync(filePath, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(value)) {
    fail("invalid_private_token");
  }
  return Buffer.from(value, "utf8");
};

const assertSecretSource = ({ runtime, filePath }) => {
  assertRootDirectoryChain({ runtime, directoryPath: runtime.path.dirname(filePath) });
  assertRootOwnedRegularFile(runtime.fs.lstatSync(filePath), rootSecretMode);
  const value = runtime.fs.readFileSync(filePath, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,256}$/u.test(value)) {
    fail("invalid_secret_source");
  }
  return Buffer.from(value, "utf8");
};

const copyAtomically = ({ runtime, sourcePath, targetPath, mode, owner }) => {
  const targetDirectory = runtime.path.dirname(targetPath);
  const temporaryPath = runtime.path.join(
    targetDirectory,
    `.${runtime.path.basename(targetPath)}.new-${process.pid}`
  );
  if (runtime.fs.existsSync(temporaryPath)) {
    fail("atomic_target_collision");
  }

  try {
    runtime.fs.copyFileSync(sourcePath, temporaryPath, nativeFs.constants.COPYFILE_EXCL);
    runtime.fs.chmodSync(temporaryPath, mode);
    runtime.setOwnership(temporaryPath, owner.uid, owner.gid);
    runtime.syncFile(temporaryPath);
    runtime.fs.renameSync(temporaryPath, targetPath);
    runtime.syncDirectory(targetDirectory);
  } finally {
    if (runtime.fs.existsSync(temporaryPath)) {
      runtime.fs.rmSync(temporaryPath, { force: true });
    }
  }
};

const writeRootPrivateFileAtomically = ({ runtime, targetPath, content }) => {
  const targetDirectory = runtime.path.dirname(targetPath);
  const temporaryPath = runtime.path.join(
    targetDirectory,
    `.${runtime.path.basename(targetPath)}.new-${process.pid}`
  );
  if (runtime.fs.existsSync(temporaryPath)) {
    fail("atomic_target_collision");
  }

  try {
    runtime.fs.writeFileSync(temporaryPath, content, {
      encoding: "utf8",
      flag: "wx",
      mode: rootSecretMode
    });
    runtime.fs.chmodSync(temporaryPath, rootSecretMode);
    runtime.setOwnership(temporaryPath, 0, 0);
    runtime.syncFile(temporaryPath);
    runtime.fs.renameSync(temporaryPath, targetPath);
    runtime.syncDirectory(targetDirectory);
  } finally {
    if (runtime.fs.existsSync(temporaryPath)) {
      runtime.fs.rmSync(temporaryPath, { force: true });
    }
  }
};

const createSnapshot = ({ runtime, targetPath, backupPath }) => {
  if (!runtime.fs.existsSync(targetPath)) {
    const absentMarkerPath = `${backupPath}${absentSnapshotSuffix}`;
    runtime.fs.writeFileSync(absentMarkerPath, "", { encoding: "utf8", flag: "wx", mode: rootSecretMode });
    runtime.fs.chmodSync(absentMarkerPath, rootSecretMode);
    runtime.setOwnership(absentMarkerPath, 0, 0);
    runtime.syncFile(absentMarkerPath);
    runtime.syncDirectory(runtime.path.dirname(absentMarkerPath));
    return { exists: false, targetPath, backupPath, absentMarkerPath };
  }

  const metadata = runtime.fs.lstatSync(targetPath);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail("snapshot_target_not_regular_file");
  }
  runtime.fs.copyFileSync(targetPath, backupPath, nativeFs.constants.COPYFILE_EXCL);
  runtime.fs.chmodSync(backupPath, rootSecretMode);
  runtime.setOwnership(backupPath, 0, 0);
  runtime.syncFile(backupPath);
  runtime.syncDirectory(runtime.path.dirname(backupPath));
  return {
    exists: true,
    targetPath,
    backupPath,
    mode: metadata.mode & 0o777,
    owner: { uid: metadata.uid, gid: metadata.gid }
  };
};

const restoreSnapshot = ({ runtime, snapshot }) => {
  if (!snapshot.exists) {
    assertRootOwnedRegularFile(runtime.fs.lstatSync(snapshot.absentMarkerPath), rootSecretMode);
    if (runtime.fs.existsSync(snapshot.targetPath)) {
      runtime.fs.rmSync(snapshot.targetPath, { force: true });
      runtime.syncDirectory(runtime.path.dirname(snapshot.targetPath));
    }
    return;
  }

  copyAtomically({
    runtime,
    sourcePath: snapshot.backupPath,
    targetPath: snapshot.targetPath,
    mode: snapshot.mode,
    owner: snapshot.owner
  });
};

const createActivationSnapshotManifest = ({ runtime, backupDirectory, plan, planSha256, snapshots }) => {
  const entries = Object.fromEntries(
    activationPayloadIds.map((payloadId, index) => {
      const snapshot = snapshots[index];
      const snapshotPath = snapshot.exists ? snapshot.backupPath : snapshot.absentMarkerPath;
      const snapshotHash = sha256File(runtime.fs, snapshotPath);
      const expectedCurrent = plan.expectedCurrent[payloadId];

      if (isSha256(expectedCurrent) && (!snapshot.exists || snapshotHash !== expectedCurrent)) {
        fail("activation_snapshot_hash_mismatch");
      }

      return [
        payloadId,
        {
          state: snapshot.exists ? "present" : "absent",
          file: runtime.path.basename(snapshotPath),
          sha256: snapshotHash
        }
      ];
    })
  );
  const manifestPath = runtime.path.join(backupDirectory, activationSnapshotManifestFileName);
  writeRootPrivateFileAtomically({
    runtime,
    targetPath: manifestPath,
    content: `${JSON.stringify({
      schema: activationSnapshotManifestSchema,
      actionVersion: ACTION_VERSION,
      planSha256,
      snapshots: entries
    })}\n`
  });
  return manifestPath;
};

const loadActivationSnapshotManifest = ({ runtime, archiveDirectory, planSha256 }) => {
  const manifestPath = runtime.path.join(archiveDirectory, activationSnapshotManifestFileName);
  assertRootOwnedRegularFile(runtime.fs.lstatSync(manifestPath), rootSecretMode);
  let manifest;
  try {
    manifest = JSON.parse(runtime.fs.readFileSync(manifestPath, "utf8"));
  } catch {
    fail("activation_snapshot_manifest_invalid");
  }
  if (
    !manifest ||
    manifest.schema !== activationSnapshotManifestSchema ||
    manifest.actionVersion !== ACTION_VERSION ||
    manifest.planSha256 !== planSha256 ||
    !manifest.snapshots ||
    typeof manifest.snapshots !== "object" ||
    Array.isArray(manifest.snapshots)
  ) {
    fail("activation_snapshot_manifest_invalid");
  }

  return manifest;
};

const emitStage = (runtime, emit, stage, planSha256, result = "ok") => {
  const event = { stage, planSha256, result };
  runtime.recordAuditEvent(event);
  emit(event);
};

const emitBestEffortStage = (runtime, emit, stage, planSha256, result = "ok") => {
  try {
    emitStage(runtime, emit, stage, planSha256, result);
  } catch {
    // 回滚已完成后，审计介质故障不得伪装成配置未恢复。
  }
};

const prepareRollback = ({ runtime, rollbackRoot, planSha256 }) => {
  ensureRootPrivateDirectoryTree({
    runtime,
    directoryPath: rollbackRoot,
    mode: rootPrivateDirectoryMode
  });
  const backupDirectory = runtime.path.join(rollbackRoot, planSha256);
  if (runtime.fs.existsSync(backupDirectory)) {
    fail("rollback_snapshot_already_exists");
  }
  runtime.fs.mkdirSync(backupDirectory, { mode: rootPrivateDirectoryMode });
  runtime.fs.chmodSync(backupDirectory, rootPrivateDirectoryMode);
  runtime.setOwnership(backupDirectory, 0, 0);
  assertExactRootPrivateDirectory({
    runtime,
    directoryPath: backupDirectory,
    mode: rootPrivateDirectoryMode
  });
  return backupDirectory;
};

const retainActivationBackup = ({ runtime, rollbackRoot, backupDirectory, planSha256 }) => {
  const archiveRoot = runtime.path.join(runtime.path.dirname(rollbackRoot), "previous");
  ensureRootPrivateDirectoryTree({
    runtime,
    directoryPath: archiveRoot,
    mode: rootPrivateDirectoryMode
  });
  const archiveDirectory = runtime.path.join(archiveRoot, planSha256);
  if (runtime.fs.existsSync(archiveDirectory)) {
    fail("previous_activation_backup_exists");
  }
  runtime.fs.renameSync(backupDirectory, archiveDirectory);
  return archiveDirectory;
};

const remapSnapshotsToBackupDirectory = ({ runtime, snapshots, backupDirectory }) =>
  snapshots.map((snapshot) => {
    const backupPath = runtime.path.join(backupDirectory, runtime.path.basename(snapshot.backupPath));
    return {
      ...snapshot,
      backupPath,
      ...(snapshot.absentMarkerPath ? { absentMarkerPath: `${backupPath}${absentSnapshotSuffix}` } : {})
    };
  });

const assertRetainedActivationBackup = ({ runtime, archiveDirectory }) => {
  assertExactRootPrivateDirectory({
    runtime,
    directoryPath: archiveDirectory,
    mode: rootPrivateDirectoryMode
  });
};

const assertSealedActionRoot = ({ runtime, actionRoot }) => {
  assertRootDirectoryChain({ runtime, directoryPath: actionRoot });
  assertRootOwnedDirectory(runtime.fs.lstatSync(runtime.path.join(actionRoot, "payload")));
  for (const entrypoint of [
    ACTION_ENTRYPOINT_FILE_NAME,
    PREPARATION_ENTRYPOINT_FILE_NAME,
    ROLLBACK_ENTRYPOINT_FILE_NAME,
    ROLLBACK_READINESS_ENTRYPOINT_FILE_NAME,
    CONTRACT_VERIFIER_FILE_NAME
  ]) {
    assertRootOwnedRegularFile(runtime.fs.lstatSync(runtime.path.join(actionRoot, entrypoint)), rootFileMode);
  }
};

const getCredentialDirectories = (pathApi, secretTarget) => {
  const vncCredentialDirectory = pathApi.dirname(secretTarget);
  const credentialDirectory = pathApi.dirname(vncCredentialDirectory);
  const vendingDirectory = pathApi.dirname(credentialDirectory);
  return { credentialDirectory, vendingDirectory, vncCredentialDirectory };
};

const preflightSealedAction = ({
  plan,
  planSha256,
  runtime,
  actionRoot,
  fixedTargets,
  secretSource
}) => {
  assertFixedPlan({ plan, fixedTargets, secretSource, pathApi: runtime.path });
  if (!isSha256(planSha256)) {
    fail("invalid_plan_digest");
  }
  if (!runtime.isRoot()) {
    fail("root_required");
  }
  assertSealedActionRoot({ runtime, actionRoot });
  runtime.ensureAuditLog();

  const payloadSources = Object.fromEntries(
    payloadIds.map((payloadId) => [
      payloadId,
      assertPayload({ runtime, actionRoot, payload: plan.payloads[payloadId] })
    ])
  );

  for (const payloadId of payloadIds) {
    const targetPath = fixedTargets[payloadId];
    assertRootDirectoryChain({ runtime, directoryPath: runtime.path.dirname(targetPath) });
    assertConfigTargetState({
      runtime,
      targetPath,
      expectedHash: plan.expectedCurrent[payloadId],
      payloadHash: plan.payloads[payloadId].sha256
    });
  }

  const sourceToken = assertSecretSource({ runtime, filePath: secretSource });
  const vncIdentity = runtime.resolveVncIdentity();
  const expectedVncOwner = { uid: vncIdentity.uid, gid: vncIdentity.gid };
  const credentialDirectories = getCredentialDirectories(runtime.path, fixedTargets.secretTarget);
  assertRootDirectoryChain({ runtime, directoryPath: credentialDirectories.vendingDirectory });
  if (runtime.fs.existsSync(credentialDirectories.credentialDirectory)) {
    assertRootOwnedDirectory(runtime.fs.lstatSync(credentialDirectories.credentialDirectory));
  }
  if (runtime.fs.existsSync(credentialDirectories.vncCredentialDirectory)) {
    assertRootVncCredentialDirectory({
      runtime,
      directoryPath: credentialDirectories.vncCredentialDirectory,
      identity: vncIdentity
    });
  }
  const existingToken = runtime.fs.existsSync(fixedTargets.secretTarget)
    ? assertPrivateToken({
        runtime,
        filePath: fixedTargets.secretTarget,
        expectedOwner: expectedVncOwner
      })
    : undefined;

  if (
    existingToken &&
    (existingToken.length !== sourceToken.length || !timingSafeEqual(existingToken, sourceToken))
  ) {
    fail("secret_target_mismatch");
  }

  return {
    credentialDirectories,
    existingToken,
    expectedVncOwner,
    payloadSources,
    sourceToken,
    vncIdentity
  };
};

const rollbackPreparation = ({
  runtime,
  snapshots,
  createdCredentialDirectories,
  runtimeDirectorySnapshot,
  vncIdentity,
  backupDirectory,
  planSha256,
  emit
}) => {
  for (const snapshot of [...snapshots].reverse()) {
    restoreSnapshot({ runtime, snapshot });
  }
  for (const createdDirectory of [...createdCredentialDirectories].reverse()) {
    removeCreatedDirectory({ runtime, ...createdDirectory });
  }
  runtime.runFixedCommand("tmpfiles");
  runtime.restoreApiSocketDirectory(runtimeDirectorySnapshot, vncIdentity);
  runtime.runFixedCommand("nginxTest");
  runtime.fs.rmSync(backupDirectory, { recursive: true, force: true });
  runtime.syncDirectory(runtime.path.dirname(backupDirectory));
  emitBestEffortStage(runtime, emit, "rolled_back", planSha256, "ok");
};

const rollbackActivation = ({ runtime, snapshots, backupDirectory, planSha256, emit, reloadAttempted }) => {
  for (const snapshot of [...snapshots].reverse()) {
    restoreSnapshot({ runtime, snapshot });
  }
  runtime.runFixedCommand("nginxTest");
  if (reloadAttempted) {
    runtime.runFixedCommand("nginxReload");
  }
  runtime.fs.rmSync(backupDirectory, { recursive: true, force: true });
  runtime.syncDirectory(runtime.path.dirname(backupDirectory));
  emitBestEffortStage(runtime, emit, "rolled_back", planSha256, "ok");
};

export const applySealedVendingPublicIngressPreparation = ({
  plan,
  planSha256 = sha256(JSON.stringify(plan)),
  runtime = createNativeRuntime(),
  actionRoot = ACTION_ROOT,
  fixedTargets = FIXED_TARGETS,
  secretSource = FIXED_SECRET_SOURCE,
  rollbackRoot = "/var/lib/vending-public-ingress-admin/rollback",
  emit = () => {}
}) => {
  const preflight = preflightSealedAction({
    plan,
    planSha256,
    runtime,
    actionRoot,
    fixedTargets,
    secretSource
  });
  const runtimeDirectorySnapshot = runtime.snapshotApiSocketDirectory(preflight.vncIdentity);

  emitStage(runtime, emit, "preflight", planSha256);
  const backupDirectory = prepareRollback({ runtime, rollbackRoot, planSha256 });
  const snapshots = [
    createSnapshot({
      runtime,
      targetPath: fixedTargets.tmpfiles,
      backupPath: runtime.path.join(backupDirectory, "tmpfiles.backup")
    }),
    createSnapshot({
      runtime,
      targetPath: fixedTargets.secretTarget,
      backupPath: runtime.path.join(backupDirectory, "secret-target.backup")
    })
  ];
  const createdCredentialDirectories = [];

  try {
    const rootOwner = { uid: 0, gid: 0 };
    copyAtomically({
      runtime,
      sourcePath: preflight.payloadSources.tmpfiles,
      targetPath: fixedTargets.tmpfiles,
      mode: rootFileMode,
      owner: rootOwner
    });
    runtime.runFixedCommand("tmpfiles");
    emitStage(runtime, emit, "tmpfiles_created", planSha256);
    runtime.runFixedCommand("nginxTest");
    emitStage(runtime, emit, "nginx_tested", planSha256);

    const credentialDirectoryCreated = ensureRootCredentialDirectory({
      runtime,
      directoryPath: preflight.credentialDirectories.credentialDirectory
    });
    createdCredentialDirectories.push({
      directoryPath: preflight.credentialDirectories.credentialDirectory,
      created: credentialDirectoryCreated
    });
    const vncCredentialDirectoryCreated = ensureRootVncCredentialDirectory({
      runtime,
      directoryPath: preflight.credentialDirectories.vncCredentialDirectory,
      identity: preflight.vncIdentity
    });
    createdCredentialDirectories.push({
      directoryPath: preflight.credentialDirectories.vncCredentialDirectory,
      created: vncCredentialDirectoryCreated
    });
    copyAtomically({
      runtime,
      sourcePath: secretSource,
      targetPath: fixedTargets.secretTarget,
      mode: vncSecretMode,
      owner: preflight.expectedVncOwner
    });
    assertPrivateToken({
      runtime,
      filePath: fixedTargets.secretTarget,
      expectedOwner: preflight.expectedVncOwner
    });
    emitStage(runtime, emit, "secret_installed", planSha256);
    emitStage(runtime, emit, "prepared", planSha256);
    runtime.fs.rmSync(backupDirectory, { recursive: true, force: true });
    runtime.syncDirectory(runtime.path.dirname(backupDirectory));
    return { planSha256, rolledBack: false };
  } catch (error) {
    try {
      rollbackPreparation({
        runtime,
        snapshots,
        createdCredentialDirectories,
        runtimeDirectorySnapshot,
        vncIdentity: preflight.vncIdentity,
        backupDirectory,
        planSha256,
        emit
      });
    } catch {
      emitBestEffortStage(runtime, emit, "rollback_failed", planSha256, "failed");
      fail("rollback_failed");
    }
    if (error instanceof RootActionFailure) {
      throw error;
    }
    fail("apply_failed");
  }
};

export const applySealedVendingPublicIngressAction = ({
  plan,
  planSha256 = sha256(JSON.stringify(plan)),
  runtime = createNativeRuntime(),
  actionRoot = ACTION_ROOT,
  fixedTargets = FIXED_TARGETS,
  secretSource = FIXED_SECRET_SOURCE,
  rollbackRoot = "/var/lib/vending-public-ingress-admin/rollback",
  emit = () => {}
}) => {
  const preflight = preflightSealedAction({
    plan,
    planSha256,
    runtime,
    actionRoot,
    fixedTargets,
    secretSource
  });
  if (
    !runtime.fs.existsSync(fixedTargets.tmpfiles) ||
    !preflight.existingToken ||
    !runtime.fs.existsSync(preflight.credentialDirectories.credentialDirectory) ||
    !runtime.fs.existsSync(preflight.credentialDirectories.vncCredentialDirectory)
  ) {
    fail("preparation_required");
  }
  runtime.assertApiEdgeReady(preflight.vncIdentity);

  emitStage(runtime, emit, "preflight", planSha256);
  const backupDirectory = prepareRollback({ runtime, rollbackRoot, planSha256 });
  const snapshots = [
    createSnapshot({
      runtime,
      targetPath: fixedTargets.nginxFragment,
      backupPath: runtime.path.join(backupDirectory, activationSnapshotFiles.nginxFragment)
    }),
    createSnapshot({
      runtime,
      targetPath: fixedTargets.nginxVhost,
      backupPath: runtime.path.join(backupDirectory, activationSnapshotFiles.nginxVhost)
    })
  ];
  let reloadAttempted = false;
  let retainedBackupDirectory;

  try {
    const rootOwner = { uid: 0, gid: 0 };
    for (const payloadId of ["nginxFragment", "nginxVhost"]) {
      copyAtomically({
        runtime,
        sourcePath: preflight.payloadSources[payloadId],
        targetPath: fixedTargets[payloadId],
        mode: rootFileMode,
        owner: rootOwner
      });
    }
    runtime.runFixedCommand("nginxTest");
    emitStage(runtime, emit, "nginx_tested", planSha256);
    runtime.verifyNginxContract(actionRoot);
    emitStage(runtime, emit, "nginx_contract_verified", planSha256);
    reloadAttempted = true;
    runtime.runFixedCommand("nginxReload");
    emitStage(runtime, emit, "nginx_reloaded", planSha256);
    createActivationSnapshotManifest({ runtime, backupDirectory, plan, planSha256, snapshots });
    retainedBackupDirectory = retainActivationBackup({ runtime, rollbackRoot, backupDirectory, planSha256 });
    assertRetainedActivationBackup({ runtime, archiveDirectory: retainedBackupDirectory });
    runtime.syncDirectory(runtime.path.dirname(backupDirectory));
    runtime.syncDirectory(runtime.path.dirname(retainedBackupDirectory));
    emitStage(runtime, emit, "completed", planSha256);
    return { planSha256, rolledBack: false };
  } catch (error) {
    try {
      rollbackActivation({
        runtime,
        snapshots: retainedBackupDirectory
          ? remapSnapshotsToBackupDirectory({
              runtime,
              snapshots,
              backupDirectory: retainedBackupDirectory
            })
          : snapshots,
        backupDirectory: retainedBackupDirectory ?? backupDirectory,
        planSha256,
        emit,
        reloadAttempted
      });
    } catch {
      emitBestEffortStage(runtime, emit, "rollback_failed", planSha256, "failed");
      fail("rollback_failed");
    }
    if (error instanceof RootActionFailure) {
      throw error;
    }
    fail("apply_failed");
  }
};

const loadArchivedActivationSnapshots = ({
  runtime,
  archiveDirectory,
  fixedTargets,
  plan,
  planSha256
}) => {
  const manifest = loadActivationSnapshotManifest({ runtime, archiveDirectory, planSha256 });
  const manifestPayloadIds = Object.keys(manifest.snapshots).sort();
  if (manifestPayloadIds.join("\n") !== [...activationPayloadIds].sort().join("\n")) {
    fail("activation_snapshot_manifest_invalid");
  }

  return activationPayloadIds.map((payloadId) => {
    const record = manifest.snapshots[payloadId];
    const targetPath = fixedTargets[payloadId];
    const backupPath = runtime.path.join(archiveDirectory, activationSnapshotFiles[payloadId]);
    const absentMarkerPath = `${backupPath}${absentSnapshotSuffix}`;
    const hasBackup = runtime.fs.existsSync(backupPath);
    const hasAbsentMarker = runtime.fs.existsSync(absentMarkerPath);

    if (
      !record ||
      typeof record !== "object" ||
      Array.isArray(record) ||
      !isSha256(record.sha256) ||
      (record.state !== "present" && record.state !== "absent") ||
      (hasBackup === hasAbsentMarker)
    ) {
      fail("activation_backup_incomplete");
    }
    if (hasBackup) {
      if (record.state !== "present" || record.file !== activationSnapshotFiles[payloadId]) {
        fail("activation_snapshot_manifest_invalid");
      }
      assertRootOwnedRegularFile(runtime.fs.lstatSync(backupPath), rootSecretMode);
      const snapshotHash = sha256File(runtime.fs, backupPath);
      if (
        snapshotHash !== record.sha256 ||
        (isSha256(plan.expectedCurrent[payloadId]) &&
          snapshotHash !== plan.expectedCurrent[payloadId])
      ) {
        fail("activation_snapshot_hash_mismatch");
      }
      return {
        exists: true,
        targetPath,
        backupPath,
        mode: rootFileMode,
        owner: { uid: 0, gid: 0 }
      };
    }
    if (
      record.state !== "absent" ||
      record.file !== `${activationSnapshotFiles[payloadId]}${absentSnapshotSuffix}`
    ) {
      fail("activation_snapshot_manifest_invalid");
    }
    assertRootOwnedRegularFile(runtime.fs.lstatSync(absentMarkerPath), rootSecretMode);
    const markerHash = sha256File(runtime.fs, absentMarkerPath);
    if (markerHash !== record.sha256 || isSha256(plan.expectedCurrent[payloadId])) {
      fail("activation_snapshot_hash_mismatch");
    }
    return { exists: false, targetPath, backupPath, absentMarkerPath };
  });
};

const preflightSealedRollback = ({ plan, planSha256, runtime, actionRoot, fixedTargets, secretSource }) => {
  assertFixedPlan({ plan, fixedTargets, secretSource, pathApi: runtime.path });
  if (!isSha256(planSha256)) {
    fail("invalid_plan_digest");
  }
  if (!runtime.isRoot()) {
    fail("root_required");
  }
  assertSealedActionRoot({ runtime, actionRoot });
  runtime.ensureAuditLog();

  for (const payloadId of activationPayloadIds) {
    const payload = plan.payloads[payloadId];
    const targetPath = fixedTargets[payloadId];
    assertRootDirectoryChain({ runtime, directoryPath: runtime.path.dirname(targetPath) });
    assertPayload({ runtime, actionRoot, payload });
    assertCurrentPayloadTarget({ runtime, targetPath, payloadHash: payload.sha256 });
  }
};

/**
 * 退役旧本地回退服务前的零参数门禁：只核对当前 sealed Nginx、根归档快照与
 * 有效配置合同，不替换文件、不 reload、也不触碰 Spark 或 VNC user service。
 */
export const verifySealedVendingPublicIngressRollbackReadiness = ({
  plan,
  planSha256 = sha256(JSON.stringify(plan)),
  runtime = createNativeRuntime(),
  actionRoot = ACTION_ROOT,
  fixedTargets = FIXED_TARGETS,
  secretSource = FIXED_SECRET_SOURCE,
  rollbackRoot = "/var/lib/vending-public-ingress-admin/restore",
  emit = () => {}
}) => {
  preflightSealedRollback({
    plan,
    planSha256,
    runtime,
    actionRoot,
    fixedTargets,
    secretSource
  });
  const archiveDirectory = runtime.path.join(
    runtime.path.dirname(rollbackRoot),
    "previous",
    planSha256
  );
  if (!runtime.fs.existsSync(archiveDirectory)) {
    fail("activation_backup_missing");
  }
  assertRootDirectoryChain({ runtime, directoryPath: archiveDirectory });
  assertExactRootPrivateDirectory({
    runtime,
    directoryPath: archiveDirectory,
    mode: rootPrivateDirectoryMode
  });
  loadArchivedActivationSnapshots({
    runtime,
    archiveDirectory,
    fixedTargets,
    plan,
    planSha256
  });
  runtime.assertNginxWorkerBoundary();
  runtime.runFixedCommand("nginxTest");
  emitStage(runtime, emit, "rollback_nginx_tested", planSha256);
  runtime.verifyNginxContract(actionRoot);
  emitStage(runtime, emit, "rollback_contract_verified", planSha256);
  emitStage(runtime, emit, "rollback_ready", planSha256);
  return { planSha256, rollbackReady: true };
};

export const applySealedVendingPublicIngressRollback = ({
  plan,
  planSha256 = sha256(JSON.stringify(plan)),
  runtime = createNativeRuntime(),
  actionRoot = ACTION_ROOT,
  fixedTargets = FIXED_TARGETS,
  secretSource = FIXED_SECRET_SOURCE,
  rollbackRoot = "/var/lib/vending-public-ingress-admin/restore",
  emit = () => {}
}) => {
  preflightSealedRollback({
    plan,
    planSha256,
    runtime,
    actionRoot,
    fixedTargets,
    secretSource
  });
  const archiveDirectory = runtime.path.join(
    runtime.path.dirname(rollbackRoot),
    "previous",
    planSha256
  );
  assertRootDirectoryChain({ runtime, directoryPath: archiveDirectory });
  assertExactRootPrivateDirectory({
    runtime,
    directoryPath: archiveDirectory,
    mode: rootPrivateDirectoryMode
  });
  const archivedSnapshots = loadArchivedActivationSnapshots({
    runtime,
    archiveDirectory,
    fixedTargets,
    plan,
    planSha256
  });

  emitStage(runtime, emit, "rollback_preflight", planSha256);
  const backupDirectory = prepareRollback({ runtime, rollbackRoot, planSha256 });
  const currentSnapshots = activationPayloadIds.map((payloadId) =>
    createSnapshot({
      runtime,
      targetPath: fixedTargets[payloadId],
      backupPath: runtime.path.join(backupDirectory, activationSnapshotFiles[payloadId])
    })
  );
  let reloadAttempted = false;

  try {
    for (const snapshot of archivedSnapshots) {
      restoreSnapshot({ runtime, snapshot });
    }
    runtime.runFixedCommand("nginxTest");
    emitStage(runtime, emit, "rollback_nginx_tested", planSha256);
    reloadAttempted = true;
    runtime.runFixedCommand("nginxReload");
    emitStage(runtime, emit, "rollback_nginx_reloaded", planSha256);
    emitStage(runtime, emit, "restored", planSha256);
    return { planSha256, rolledBack: true };
  } catch (error) {
    try {
      rollbackActivation({
        runtime,
        snapshots: currentSnapshots,
        backupDirectory,
        planSha256,
        emit,
        reloadAttempted
      });
    } catch {
      emitBestEffortStage(runtime, emit, "rollback_failed", planSha256, "failed");
      fail("rollback_failed");
    }
    if (error instanceof RootActionFailure) {
      throw error;
    }
    fail("apply_failed");
  }
};

export const loadSealedPlan = ({ runtime = createNativeRuntime(), actionRoot = ACTION_ROOT } = {}) => {
  assertSealedActionRoot({ runtime, actionRoot });
  const planPath = runtime.path.join(actionRoot, PLAN_FILE_NAME);
  const digestPath = runtime.path.join(actionRoot, PLAN_DIGEST_FILE_NAME);
  assertRootOwnedRegularFile(runtime.fs.lstatSync(planPath), rootFileMode);
  assertRootOwnedRegularFile(runtime.fs.lstatSync(digestPath), rootFileMode);
  const planSha256 = runtime.fs.readFileSync(digestPath, "utf8").trim();
  if (!isSha256(planSha256)) {
    fail("invalid_plan_digest");
  }
  const rawPlan = runtime.fs.readFileSync(planPath, "utf8");
  if (sha256(rawPlan) !== planSha256) {
    fail("plan_digest_mismatch");
  }
  try {
    return { plan: JSON.parse(rawPlan), planSha256 };
  } catch {
    fail("invalid_plan_json");
  }
};

export const assertNoRuntimeArguments = (argv) => {
  if (!Array.isArray(argv) || argv.length !== 2) {
    fail("runtime_arguments_forbidden");
  }
};

export const runCli = () => {
  try {
    assertNoRuntimeArguments(process.argv);
    const runtime = createNativeRuntime();
    const { plan, planSha256 } = loadSealedPlan({ runtime });
    applySealedVendingPublicIngressAction({ plan, planSha256, runtime, emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`) });
  } catch (error) {
    const code = error instanceof RootActionFailure ? error.code : "unexpected_failure";
    process.stdout.write(`${JSON.stringify({ stage: "failed", result: code })}\n`);
    process.exitCode = 1;
  }
};

export const runPreparationCli = () => {
  try {
    assertNoRuntimeArguments(process.argv);
    const runtime = createNativeRuntime();
    const { plan, planSha256 } = loadSealedPlan({ runtime });
    applySealedVendingPublicIngressPreparation({
      plan,
      planSha256,
      runtime,
      emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
    });
  } catch (error) {
    const code = error instanceof RootActionFailure ? error.code : "unexpected_failure";
    process.stdout.write(`${JSON.stringify({ stage: "failed", result: code })}\n`);
    process.exitCode = 1;
  }
};

export const runRollbackCli = () => {
  try {
    assertNoRuntimeArguments(process.argv);
    const runtime = createNativeRuntime();
    const { plan, planSha256 } = loadSealedPlan({ runtime });
    applySealedVendingPublicIngressRollback({
      plan,
      planSha256,
      runtime,
      emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
    });
  } catch (error) {
    const code = error instanceof RootActionFailure ? error.code : "unexpected_failure";
    process.stdout.write(`${JSON.stringify({ stage: "failed", result: code })}\n`);
    process.exitCode = 1;
  }
};

export const runRollbackReadinessCli = () => {
  try {
    assertNoRuntimeArguments(process.argv);
    const runtime = createNativeRuntime();
    const { plan, planSha256 } = loadSealedPlan({ runtime });
    verifySealedVendingPublicIngressRollbackReadiness({
      plan,
      planSha256,
      runtime,
      emit: (event) => process.stdout.write(`${JSON.stringify(event)}\n`)
    });
  } catch (error) {
    const code = error instanceof RootActionFailure ? error.code : "unexpected_failure";
    process.stdout.write(`${JSON.stringify({ stage: "failed", result: code })}\n`);
    process.exitCode = 1;
  }
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
