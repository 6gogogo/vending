import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { posix as path } from "node:path";
import test from "node:test";

import {
  BOOTSTRAP_FILE_NAME,
  MANIFEST_DIGEST_FILE_NAME,
  MANIFEST_FILE_NAME,
  REQUIRED_RUNTIME_FILES,
  RUNTIME_ROOT,
  RUNTIME_VERSION,
  SealedRuntimeError,
  assertSealedRuntime,
  dropToServiceUser,
  resolveRuntimeConfiguration
} from "../deploy/public-app-acceptance/v1/vending-public-app-acceptance-bootstrap.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const createSealedRuntimeFixture = ({
  runtimeRoot = RUNTIME_ROOT,
  runtimeVersion = RUNTIME_VERSION
} = {}) => {
  const fileContents = new Map(
    REQUIRED_RUNTIME_FILES.map((fileName) => [
      path.join(runtimeRoot, fileName),
      Buffer.from(`sealed:${fileName}`, "utf8")
    ])
  );
  const manifest = {
    schema: `vending-public-app-acceptance-runtime/${runtimeVersion}`,
    version: runtimeVersion,
    sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    runtimeRoot,
    entrypoint: BOOTSTRAP_FILE_NAME,
    files: Object.fromEntries(
      REQUIRED_RUNTIME_FILES.map((fileName) => {
        const filePath = path.join(runtimeRoot, fileName);
        return [fileName, sha256(fileContents.get(filePath))];
      })
    )
  };
  const rawManifest = Buffer.from(JSON.stringify(manifest), "utf8");
  fileContents.set(path.join(runtimeRoot, MANIFEST_FILE_NAME), rawManifest);
  fileContents.set(
    path.join(runtimeRoot, MANIFEST_DIGEST_FILE_NAME),
    Buffer.from(`${sha256(rawManifest)}\n`, "utf8")
  );

  const directoryMetadata = {
    isDirectory: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    gid: 0,
    mode: 0o40755
  };
  const runtimeDirectoryMetadata = {
    ...directoryMetadata,
    mode: 0o40700
  };
  const rootFileMetadata = {
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    gid: 0,
    mode: 0o100600
  };
  const nodeMetadata = {
    isFile: () => true,
    isSymbolicLink: () => false,
    uid: 0,
    gid: 0,
    mode: 0o100755
  };
  const fs = {
    realpathSync(targetPath) {
      return targetPath;
    },
    lstatSync(targetPath) {
      if (targetPath === "/usr/bin/node") {
        return nodeMetadata;
      }
      if (fileContents.has(targetPath)) {
        return rootFileMetadata;
      }
      if (targetPath === runtimeRoot) {
        return runtimeDirectoryMetadata;
      }
      return directoryMetadata;
    },
    readFileSync(targetPath, encoding = undefined) {
      const value = fileContents.get(targetPath);
      if (!value) {
        throw new Error(`fixture file missing: ${targetPath}`);
      }
      return encoding ? value.toString(encoding) : value;
    }
  };

  return { fs, fileContents };
};

const assertFixture = (fixture, overrides = {}) => {
  const runtimeRoot = overrides.runtimeRoot ?? RUNTIME_ROOT;
  const runtimeVersion = overrides.runtimeVersion ?? RUNTIME_VERSION;

  return assertSealedRuntime({
    fs: fixture.fs,
    pathApi: path,
    runtimeRoot,
    runtimeVersion,
    currentFilePath: path.join(runtimeRoot, BOOTSTRAP_FILE_NAME),
    execPath: "/usr/bin/node",
    platform: "linux",
    uid: 0,
    environment: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
    ...overrides
  });
};

test("已封存运行器在固定路径、root 文件链和完整 SHA-256 清单通过后才放行", () => {
  const fixture = createSealedRuntimeFixture();

  assert.deepEqual(assertFixture(fixture), {
    runtimeRoot: RUNTIME_ROOT,
    entryPath: path.join(RUNTIME_ROOT, "run-public-app-acceptance.mjs")
  });
});

test("v2 只从固定 root 私有路径解析，并核验 v2 清单", () => {
  const v2Root = "/usr/local/lib/vending-public-app-acceptance/v2";
  assert.deepEqual(
    resolveRuntimeConfiguration({
      currentFilePath: path.join(v2Root, BOOTSTRAP_FILE_NAME),
      platform: "linux",
      pathApi: path
    }),
    { runtimeVersion: "v2", runtimeRoot: v2Root }
  );
  assert.deepEqual(
    resolveRuntimeConfiguration({
      currentFilePath: "/tmp/v2/vending-public-app-acceptance-bootstrap.mjs",
      platform: "linux",
      pathApi: path
    }),
    { runtimeVersion: "v1", runtimeRoot: RUNTIME_ROOT }
  );

  const fixture = createSealedRuntimeFixture({ runtimeRoot: v2Root, runtimeVersion: "v2" });
  assert.deepEqual(assertFixture(fixture, { runtimeRoot: v2Root, runtimeVersion: "v2" }), {
    runtimeRoot: v2Root,
    entryPath: path.join(v2Root, "run-public-app-acceptance.mjs")
  });
});

test("已封存运行器拒绝模块哈希漂移和未净化运行环境", () => {
  const fixture = createSealedRuntimeFixture();
  const flowPath = path.join(RUNTIME_ROOT, "public-app-acceptance.mjs");
  fixture.fileContents.set(flowPath, Buffer.from("tampered", "utf8"));

  assert.throws(
    () => assertFixture(fixture),
    (error) => error instanceof SealedRuntimeError && error.code === "runtime_file_hash_mismatch"
  );

  const cleanFixture = createSealedRuntimeFixture();
  assert.throws(
    () => assertFixture(cleanFixture, { environment: { PATH: "/usr/bin:/bin", NODE_OPTIONS: "x" } }),
    (error) => error instanceof SealedRuntimeError && error.code === "sanitized_environment_required"
  );
});

test("root bootstrap 在加载模块后只能降权为固定服务身份", () => {
  const calls = [];
  let uid = 0;
  let gid = 0;
  const processRef = {
    getuid: () => uid,
    getgid: () => gid,
    initgroups: (userName, groupId) => calls.push(["initgroups", userName, groupId]),
    setgid: (groupId) => {
      calls.push(["setgid", groupId]);
      gid = groupId;
    },
    setuid: (userId) => {
      calls.push(["setuid", userId]);
      uid = userId;
    }
  };

  dropToServiceUser({
    processRef,
    identity: { userName: "fivegogogo", uid: 1000, gid: 1000 }
  });

  assert.deepEqual(calls, [
    ["initgroups", "fivegogogo", 1000],
    ["setgid", 1000],
    ["setuid", 1000]
  ]);
  assert.equal(uid, 1000);
  assert.equal(gid, 1000);
});
