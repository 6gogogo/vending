import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as nativeFs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACTION_ENTRYPOINT_FILE_NAME,
  CONTRACT_VERIFIER_FILE_NAME,
  ACTION_VERSION,
  applySealedVendingPublicIngressAction,
  applySealedVendingPublicIngressPreparation,
  applySealedVendingPublicIngressRollback,
  assertFixedPlan,
  assertNoRuntimeArguments,
  assertRootOwnedDirectory,
  assertRootOwnedRegularFile,
  loadSealedPlan,
  PREPARATION_ENTRYPOINT_FILE_NAME,
  ROLLBACK_ENTRYPOINT_FILE_NAME,
  ROLLBACK_READINESS_ENTRYPOINT_FILE_NAME,
  RootActionFailure,
  verifySealedVendingPublicIngressRollbackReadiness
} from "./vending-public-ingress-root-action.mjs";

const TEST_TOKEN = "a".repeat(64);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const createFixture = (t, failures = [], auditFailures = []) => {
  const root = nativeFs.mkdtempSync(join(tmpdir(), "vm-root-action-"));
  const actionRoot = join(root, "action");
  const payloadDirectory = join(actionRoot, "payload");
  const etcDirectory = join(root, "etc");
  const targets = {
    tmpfiles: join(etcDirectory, "tmpfiles.d", "vending-edge.conf"),
    nginxFragment: join(etcDirectory, "nginx", "snippets", "vending-api-edge-unix-socket.conf"),
    nginxVhost: join(etcDirectory, "nginx", "conf.d", "vending.5gogogo.top.conf"),
    secretTarget: join(
      etcDirectory,
      "vending",
      "credentials",
      "vnc",
      "private-api-relay.token"
    )
  };
  const secretSource = join(etcDirectory, "vending", "secrets", "vending-private-api-relay.token");
  const rollbackRoot = join(root, "var", "lib", "vending-public-ingress-admin", "rollback");
  const oldVhost = "server { location ^~ /api/ { proxy_pass http://127.0.0.1:4000; } }\n";
  const newVhost = "server { include /etc/nginx/snippets/vending-api-edge-unix-socket.conf; }\n";
  const payloads = {
    tmpfiles: "d /run/vending 2710 vnc www-data -\n",
    nginxFragment:
      "location ^~ /api/ { proxy_pass http://unix:/run/vending/api-edge.sock:; }\n",
    nginxVhost: newVhost
  };

  nativeFs.mkdirSync(payloadDirectory, { recursive: true });
  nativeFs.mkdirSync(dirname(targets.nginxVhost), { recursive: true });
  nativeFs.mkdirSync(dirname(targets.tmpfiles), { recursive: true });
  nativeFs.mkdirSync(dirname(targets.nginxFragment), { recursive: true });
  nativeFs.mkdirSync(dirname(secretSource), { recursive: true });
  nativeFs.writeFileSync(targets.nginxVhost, oldVhost, "utf8");
  nativeFs.writeFileSync(secretSource, `${TEST_TOKEN}\n`, "utf8");
  nativeFs.writeFileSync(join(actionRoot, ACTION_ENTRYPOINT_FILE_NAME), "export {};\n", "utf8");
  nativeFs.writeFileSync(join(actionRoot, PREPARATION_ENTRYPOINT_FILE_NAME), "export {};\n", "utf8");
  nativeFs.writeFileSync(join(actionRoot, ROLLBACK_ENTRYPOINT_FILE_NAME), "export {};\n", "utf8");
  nativeFs.writeFileSync(
    join(actionRoot, ROLLBACK_READINESS_ENTRYPOINT_FILE_NAME),
    "export {};\n",
    "utf8"
  );
  nativeFs.writeFileSync(join(actionRoot, CONTRACT_VERIFIER_FILE_NAME), "export {};\n", "utf8");
  nativeFs.writeFileSync(join(payloadDirectory, "vending-edge.conf"), payloads.tmpfiles, "utf8");
  nativeFs.writeFileSync(
    join(payloadDirectory, "vending-api-edge-unix-socket.conf"),
    payloads.nginxFragment,
    "utf8"
  );
  nativeFs.writeFileSync(join(payloadDirectory, "vending.5gogogo.top.conf"), payloads.nginxVhost, "utf8");
  t.after(() => nativeFs.rmSync(root, { recursive: true, force: true }));

  const ownership = new Map();
  const modes = new Map([[resolve(secretSource), 0o600]]);
  const normalized = (value) => resolve(value);
  const virtualFs = {
    ...nativeFs,
    lstatSync: (filePath) => {
      const metadata = nativeFs.lstatSync(filePath);
      const entry = ownership.get(normalized(filePath)) ?? { uid: 0, gid: 0 };
      const defaultMode = metadata.isDirectory() ? 0o755 : 0o644;
      return {
        isFile: () => metadata.isFile(),
        isDirectory: () => metadata.isDirectory(),
        isSymbolicLink: () => metadata.isSymbolicLink(),
        mode: (metadata.mode & ~0o777) | (modes.get(normalized(filePath)) ?? defaultMode),
        uid: entry.uid,
        gid: entry.gid
      };
    },
    chmodSync: (filePath, mode) => {
      nativeFs.chmodSync(filePath, mode);
      modes.set(normalized(filePath), mode);
    },
    renameSync: (from, to) => {
      nativeFs.renameSync(from, to);
      const fromKey = normalized(from);
      const toKey = normalized(to);
      for (const entries of [ownership, modes]) {
        const replacements = [];
        for (const [key, value] of entries) {
          if (key === fromKey || key.startsWith(`${fromKey}\\`) || key.startsWith(`${fromKey}/`)) {
            replacements.push([key, `${toKey}${key.slice(fromKey.length)}`, value]);
          }
        }
        for (const [oldKey, newKey, value] of replacements) {
          entries.delete(oldKey);
          entries.set(newKey, value);
        }
      }
    },
    rmSync: (filePath, options) => {
      const prefix = normalized(filePath);
      nativeFs.rmSync(filePath, options);
      for (const key of ownership.keys()) {
        if (key === prefix || key.startsWith(`${prefix}\\`) || key.startsWith(`${prefix}/`)) {
          ownership.delete(key);
        }
      }
      for (const key of modes.keys()) {
        if (key === prefix || key.startsWith(`${prefix}\\`) || key.startsWith(`${prefix}/`)) {
          modes.delete(key);
        }
      }
    },
    rmdirSync: (directoryPath) => {
      nativeFs.rmdirSync(directoryPath);
      ownership.delete(normalized(directoryPath));
      modes.delete(normalized(directoryPath));
    }
  };
  const commands = [];
  const auditEvents = [];
  const pendingFailures = [...failures];
  const pendingAuditFailures = [...auditFailures];
  const runtime = {
    fs: virtualFs,
    path: { join, dirname, basename, isAbsolute, resolve },
    isRoot: () => true,
    setOwnership: (filePath, uid, gid) => ownership.set(normalized(filePath), { uid, gid }),
    resolveVncIdentity: () => ({ uid: 1001, gid: 1001 }),
    syncFile: () => {},
    syncDirectory: () => {},
    assertNginxWorkerBoundary: () => commands.push("nginxWorkersReady"),
    assertApiEdgeReady: () => commands.push("apiSocketReady"),
    snapshotApiSocketDirectory: () => ({ existed: false }),
    restoreApiSocketDirectory: () => commands.push("apiSocketDirectoryRestored"),
    ensureAuditLog: () => {},
    recordAuditEvent: (event) => {
      if (pendingAuditFailures[0] === event.stage) {
        pendingAuditFailures.shift();
        throw new Error(`${event.stage} simulated audit failure`);
      }
      auditEvents.push(event);
    },
    verifyNginxContract: () => commands.push("nginxContract"),
    runFixedCommand: (stage) => {
      commands.push(stage);
      if (pendingFailures[0] === stage) {
        pendingFailures.shift();
        throw new Error(`${stage} simulated failure`);
      }
    }
  };
  const plan = {
    schema: "vending-public-ingress-root-action/v1",
    status: "sealed",
    actionVersion: ACTION_VERSION,
    vncUser: "vnc",
    secretSource,
    secretTargetState: "absent-or-equal-source",
    targets,
    payloads: {
      tmpfiles: { file: "payload/vending-edge.conf", sha256: sha256(payloads.tmpfiles) },
      nginxFragment: {
        file: "payload/vending-api-edge-unix-socket.conf",
        sha256: sha256(payloads.nginxFragment)
      },
      nginxVhost: { file: "payload/vending.5gogogo.top.conf", sha256: sha256(payloads.nginxVhost) }
    },
    expectedCurrent: {
      tmpfiles: "absent-or-same",
      nginxFragment: "absent-or-same",
      nginxVhost: sha256(oldVhost)
    }
  };
  return {
    actionRoot,
    auditEvents,
    commands,
    oldVhost,
    payloads,
    plan,
    rollbackRoot,
    root,
    runtime,
    targets
  };
};

test("准备与切流均为固定顺序，且切流前不会改动现有 vhost 或输出令牌", (t) => {
  const fixture = createFixture(t);
  const events = [];

  const preparation = applySealedVendingPublicIngressPreparation({
    plan: fixture.plan,
    runtime: fixture.runtime,
    actionRoot: fixture.actionRoot,
    fixedTargets: fixture.targets,
    secretSource: fixture.plan.secretSource,
    rollbackRoot: fixture.rollbackRoot,
    emit: (event) => events.push(event)
  });

  assert.equal(preparation.rolledBack, false);
  assert.deepEqual(fixture.commands, ["tmpfiles", "nginxTest"]);
  assert.equal(nativeFs.readFileSync(fixture.targets.tmpfiles, "utf8"), fixture.payloads.tmpfiles);
  assert.equal(nativeFs.existsSync(fixture.targets.nginxFragment), false);
  assert.equal(nativeFs.readFileSync(fixture.targets.nginxVhost, "utf8"), fixture.oldVhost);
  assert.equal(nativeFs.readFileSync(fixture.targets.secretTarget, "utf8").trim(), TEST_TOKEN);
  assert.deepEqual(events.map((event) => event.stage), [
    "preflight",
    "tmpfiles_created",
    "nginx_tested",
    "secret_installed",
    "prepared"
  ]);

  const result = applySealedVendingPublicIngressAction({
    plan: fixture.plan,
    runtime: fixture.runtime,
    actionRoot: fixture.actionRoot,
    fixedTargets: fixture.targets,
    secretSource: fixture.plan.secretSource,
    rollbackRoot: fixture.rollbackRoot,
    emit: (event) => events.push(event)
  });

  assert.equal(result.rolledBack, false);
  assert.deepEqual(fixture.commands, [
    "tmpfiles",
    "nginxTest",
    "apiSocketReady",
    "nginxTest",
    "nginxContract",
    "nginxReload"
  ]);
  assert.equal(
    nativeFs.readFileSync(fixture.targets.nginxFragment, "utf8"),
    fixture.payloads.nginxFragment
  );
  assert.equal(nativeFs.readFileSync(fixture.targets.nginxVhost, "utf8"), fixture.payloads.nginxVhost);
  assert.deepEqual(events.map((event) => event.stage), [
    "preflight",
    "tmpfiles_created",
    "nginx_tested",
    "secret_installed",
    "prepared",
    "preflight",
    "nginx_tested",
    "nginx_contract_verified",
    "nginx_reloaded",
    "completed"
  ]);
  assert.equal(JSON.stringify(events).includes(TEST_TOKEN), false);
  assert.deepEqual(
    fixture.auditEvents.map((event) => event.stage),
    events.map((event) => event.stage)
  );
  assert.equal(JSON.stringify(fixture.auditEvents).includes(TEST_TOKEN), false);
});

test("准备阶段 nginx -t 失败时恢复 tmpfiles 且不写入令牌", (t) => {
  const fixture = createFixture(t, ["nginxTest"]);
  const events = [];

  assert.throws(
    () =>
      applySealedVendingPublicIngressPreparation({
        plan: fixture.plan,
        runtime: fixture.runtime,
        actionRoot: fixture.actionRoot,
        fixedTargets: fixture.targets,
        secretSource: fixture.plan.secretSource,
        rollbackRoot: fixture.rollbackRoot,
        emit: (event) => events.push(event)
      }),
    (error) => error.code === "apply_failed"
  );

  assert.deepEqual(fixture.commands, [
    "tmpfiles",
    "nginxTest",
    "tmpfiles",
    "apiSocketDirectoryRestored",
    "nginxTest"
  ]);
  assert.equal(nativeFs.existsSync(fixture.targets.tmpfiles), false);
  assert.equal(nativeFs.existsSync(fixture.targets.nginxFragment), false);
  assert.equal(nativeFs.readFileSync(fixture.targets.nginxVhost, "utf8"), fixture.oldVhost);
  assert.equal(nativeFs.existsSync(fixture.targets.secretTarget), false);
  assert.equal(events.at(-1)?.stage, "rolled_back");
});

test("未完成准备或 socket 检查时，切流 action 不触碰 vhost", (t) => {
  const fixture = createFixture(t);

  assert.throws(
    () =>
      applySealedVendingPublicIngressAction({
        plan: fixture.plan,
        runtime: fixture.runtime,
        actionRoot: fixture.actionRoot,
        fixedTargets: fixture.targets,
        secretSource: fixture.plan.secretSource,
        rollbackRoot: fixture.rollbackRoot
      }),
    (error) => error.code === "preparation_required"
  );
  assert.equal(nativeFs.readFileSync(fixture.targets.nginxVhost, "utf8"), fixture.oldVhost);
  assert.equal(nativeFs.existsSync(fixture.targets.nginxFragment), false);
  assert.deepEqual(fixture.commands, []);
});

test("准备完成但 socket 正向检查失败时，切流 action 不触碰 vhost", (t) => {
  const fixture = createFixture(t);
  applySealedVendingPublicIngressPreparation({
    plan: fixture.plan,
    runtime: fixture.runtime,
    actionRoot: fixture.actionRoot,
    fixedTargets: fixture.targets,
    secretSource: fixture.plan.secretSource,
    rollbackRoot: fixture.rollbackRoot
  });
  fixture.runtime.assertApiEdgeReady = () => {
    throw new RootActionFailure("api_socket_positive_probe_failed");
  };

  assert.throws(
    () =>
      applySealedVendingPublicIngressAction({
        plan: fixture.plan,
        runtime: fixture.runtime,
        actionRoot: fixture.actionRoot,
        fixedTargets: fixture.targets,
        secretSource: fixture.plan.secretSource,
        rollbackRoot: fixture.rollbackRoot
      }),
    (error) => error.code === "api_socket_positive_probe_failed"
  );
  assert.equal(nativeFs.readFileSync(fixture.targets.nginxVhost, "utf8"), fixture.oldVhost);
  assert.equal(nativeFs.existsSync(fixture.targets.nginxFragment), false);
  assert.deepEqual(fixture.commands, ["tmpfiles", "nginxTest"]);
});

test("reload 失败时 action 恢复 vhost 与令牌并重载已恢复配置", (t) => {
  const fixture = createFixture(t, ["nginxReload"]);
  const events = [];

  applySealedVendingPublicIngressPreparation({
    plan: fixture.plan,
    runtime: fixture.runtime,
    actionRoot: fixture.actionRoot,
    fixedTargets: fixture.targets,
    secretSource: fixture.plan.secretSource,
    rollbackRoot: fixture.rollbackRoot
  });

  assert.throws(
    () =>
      applySealedVendingPublicIngressAction({
        plan: fixture.plan,
        runtime: fixture.runtime,
        actionRoot: fixture.actionRoot,
        fixedTargets: fixture.targets,
        secretSource: fixture.plan.secretSource,
        rollbackRoot: fixture.rollbackRoot,
        emit: (event) => events.push(event)
      }),
    (error) => error.code === "apply_failed"
  );

  assert.deepEqual(fixture.commands, [
    "tmpfiles",
    "nginxTest",
    "apiSocketReady",
    "nginxTest",
    "nginxContract",
    "nginxReload",
    "nginxTest",
    "nginxReload"
  ]);
  assert.equal(nativeFs.readFileSync(fixture.targets.nginxVhost, "utf8"), fixture.oldVhost);
  assert.equal(nativeFs.readFileSync(fixture.targets.secretTarget, "utf8").trim(), TEST_TOKEN);
  assert.equal(events.at(-1)?.stage, "rolled_back");
});

test("准备终态审计失败时仍从快照恢复 tmpfiles 与令牌", (t) => {
  const fixture = createFixture(t, [], ["prepared"]);

  assert.throws(
    () =>
      applySealedVendingPublicIngressPreparation({
        plan: fixture.plan,
        runtime: fixture.runtime,
        actionRoot: fixture.actionRoot,
        fixedTargets: fixture.targets,
        secretSource: fixture.plan.secretSource,
        rollbackRoot: fixture.rollbackRoot
      }),
    (error) => error.code === "apply_failed"
  );

  assert.deepEqual(fixture.commands, [
    "tmpfiles",
    "nginxTest",
    "tmpfiles",
    "apiSocketDirectoryRestored",
    "nginxTest"
  ]);
  assert.equal(nativeFs.existsSync(fixture.targets.tmpfiles), false);
  assert.equal(nativeFs.existsSync(fixture.targets.secretTarget), false);
  assert.equal(nativeFs.readFileSync(fixture.targets.nginxVhost, "utf8"), fixture.oldVhost);
  assert.equal(fixture.auditEvents.at(-1)?.stage, "rolled_back");
});

test("切流终态审计失败时从已归档快照恢复旧 vhost", (t) => {
  const fixture = createFixture(t, [], ["completed"]);
  applySealedVendingPublicIngressPreparation({
    plan: fixture.plan,
    runtime: fixture.runtime,
    actionRoot: fixture.actionRoot,
    fixedTargets: fixture.targets,
    secretSource: fixture.plan.secretSource,
    rollbackRoot: fixture.rollbackRoot
  });

  assert.throws(
    () =>
      applySealedVendingPublicIngressAction({
        plan: fixture.plan,
        runtime: fixture.runtime,
        actionRoot: fixture.actionRoot,
        fixedTargets: fixture.targets,
        secretSource: fixture.plan.secretSource,
        rollbackRoot: fixture.rollbackRoot
      }),
    (error) => error.code === "apply_failed"
  );

  assert.deepEqual(fixture.commands, [
    "tmpfiles",
    "nginxTest",
    "apiSocketReady",
    "nginxTest",
    "nginxContract",
    "nginxReload",
    "nginxTest",
    "nginxReload"
  ]);
  assert.equal(nativeFs.readFileSync(fixture.targets.nginxVhost, "utf8"), fixture.oldVhost);
  assert.equal(nativeFs.existsSync(fixture.targets.nginxFragment), false);
  assert.equal(fixture.auditEvents.at(-1)?.stage, "rolled_back");
});

test("固定回退只恢复同一密封计划的 root-only 旧 Nginx 快照", (t) => {
  const fixture = createFixture(t);
  applySealedVendingPublicIngressPreparation({
    plan: fixture.plan,
    runtime: fixture.runtime,
    actionRoot: fixture.actionRoot,
    fixedTargets: fixture.targets,
    secretSource: fixture.plan.secretSource,
    rollbackRoot: fixture.rollbackRoot
  });
  applySealedVendingPublicIngressAction({
    plan: fixture.plan,
    runtime: fixture.runtime,
    actionRoot: fixture.actionRoot,
    fixedTargets: fixture.targets,
    secretSource: fixture.plan.secretSource,
    rollbackRoot: fixture.rollbackRoot
  });

  const result = applySealedVendingPublicIngressRollback({
    plan: fixture.plan,
    runtime: fixture.runtime,
    actionRoot: fixture.actionRoot,
    fixedTargets: fixture.targets,
    secretSource: fixture.plan.secretSource,
    rollbackRoot: join(fixture.root, "var", "lib", "vending-public-ingress-admin", "restore")
  });

  assert.equal(result.rolledBack, true);
  assert.equal(nativeFs.readFileSync(fixture.targets.nginxVhost, "utf8"), fixture.oldVhost);
  assert.equal(nativeFs.existsSync(fixture.targets.nginxFragment), false);
  assert.deepEqual(fixture.commands, [
    "tmpfiles",
    "nginxTest",
    "apiSocketReady",
    "nginxTest",
    "nginxContract",
    "nginxReload",
    "nginxTest",
    "nginxReload"
  ]);
});

test("退役前 rollback readiness 只核验同一密封快照与当前 Nginx，不改配置", (t) => {
  const fixture = createFixture(t);
  applySealedVendingPublicIngressPreparation({
    plan: fixture.plan,
    runtime: fixture.runtime,
    actionRoot: fixture.actionRoot,
    fixedTargets: fixture.targets,
    secretSource: fixture.plan.secretSource,
    rollbackRoot: fixture.rollbackRoot
  });
  applySealedVendingPublicIngressAction({
    plan: fixture.plan,
    runtime: fixture.runtime,
    actionRoot: fixture.actionRoot,
    fixedTargets: fixture.targets,
    secretSource: fixture.plan.secretSource,
    rollbackRoot: fixture.rollbackRoot
  });
  const events = [];
  const commandsBeforeReadiness = [...fixture.commands];

  const result = verifySealedVendingPublicIngressRollbackReadiness({
    plan: fixture.plan,
    runtime: fixture.runtime,
    actionRoot: fixture.actionRoot,
    fixedTargets: fixture.targets,
    secretSource: fixture.plan.secretSource,
    rollbackRoot: fixture.rollbackRoot,
    emit: (event) => events.push(event)
  });

  assert.equal(result.rollbackReady, true);
  assert.equal(nativeFs.readFileSync(fixture.targets.nginxVhost, "utf8"), fixture.payloads.nginxVhost);
  assert.equal(
    nativeFs.readFileSync(fixture.targets.nginxFragment, "utf8"),
    fixture.payloads.nginxFragment
  );
  assert.deepEqual(fixture.commands, [
    ...commandsBeforeReadiness,
    "nginxWorkersReady",
    "nginxTest",
    "nginxContract"
  ]);
  assert.deepEqual(events.map((event) => event.stage), [
    "rollback_nginx_tested",
    "rollback_contract_verified",
    "rollback_ready"
  ]);

  fixture.runtime.assertNginxWorkerBoundary = () => {
    throw new RootActionFailure("nginx_worker_identity_invalid");
  };
  assert.throws(
    () =>
      verifySealedVendingPublicIngressRollbackReadiness({
        plan: fixture.plan,
        runtime: fixture.runtime,
        actionRoot: fixture.actionRoot,
        fixedTargets: fixture.targets,
        secretSource: fixture.plan.secretSource,
        rollbackRoot: fixture.rollbackRoot
      }),
    (error) => error.code === "nginx_worker_identity_invalid"
  );

  fixture.runtime.assertNginxWorkerBoundary = () => {};
  nativeFs.writeFileSync(fixture.targets.nginxVhost, "drifted\n", "utf8");
  assert.throws(
    () =>
      verifySealedVendingPublicIngressRollbackReadiness({
        plan: fixture.plan,
        runtime: fixture.runtime,
        actionRoot: fixture.actionRoot,
        fixedTargets: fixture.targets,
        secretSource: fixture.plan.secretSource,
        rollbackRoot: fixture.rollbackRoot
      }),
    (error) => error.code === "rollback_target_hash_mismatch"
  );

  nativeFs.writeFileSync(fixture.targets.nginxVhost, fixture.payloads.nginxVhost, "utf8");
  const archiveDirectory = join(
    fixture.root,
    "var",
    "lib",
    "vending-public-ingress-admin",
    "previous",
    sha256(JSON.stringify(fixture.plan))
  );
  nativeFs.rmSync(archiveDirectory, { recursive: true, force: true });
  assert.throws(
    () =>
      verifySealedVendingPublicIngressRollbackReadiness({
        plan: fixture.plan,
        runtime: fixture.runtime,
        actionRoot: fixture.actionRoot,
        fixedTargets: fixture.targets,
        secretSource: fixture.plan.secretSource,
        rollbackRoot: fixture.rollbackRoot
      }),
    (error) => error.code === "activation_backup_missing"
  );
  assert.equal(nativeFs.readFileSync(fixture.targets.nginxVhost, "utf8"), fixture.payloads.nginxVhost);
});

test("固定回退拒绝与 root-only manifest 哈希不一致的归档快照", (t) => {
  const fixture = createFixture(t);
  applySealedVendingPublicIngressPreparation({
    plan: fixture.plan,
    runtime: fixture.runtime,
    actionRoot: fixture.actionRoot,
    fixedTargets: fixture.targets,
    secretSource: fixture.plan.secretSource,
    rollbackRoot: fixture.rollbackRoot
  });
  applySealedVendingPublicIngressAction({
    plan: fixture.plan,
    runtime: fixture.runtime,
    actionRoot: fixture.actionRoot,
    fixedTargets: fixture.targets,
    secretSource: fixture.plan.secretSource,
    rollbackRoot: fixture.rollbackRoot
  });

  const planSha256 = sha256(JSON.stringify(fixture.plan));
  const archivedVhost = join(
    fixture.root,
    "var",
    "lib",
    "vending-public-ingress-admin",
    "previous",
    planSha256,
    "nginx-vhost.backup"
  );
  nativeFs.writeFileSync(archivedVhost, "tampered\n", "utf8");

  assert.throws(
    () =>
      applySealedVendingPublicIngressRollback({
        plan: fixture.plan,
        runtime: fixture.runtime,
        actionRoot: fixture.actionRoot,
        fixedTargets: fixture.targets,
        secretSource: fixture.plan.secretSource,
        rollbackRoot: join(fixture.root, "var", "lib", "vending-public-ingress-admin", "restore")
      }),
    (error) => error.code === "activation_snapshot_hash_mismatch"
  );
  assert.equal(nativeFs.readFileSync(fixture.targets.nginxVhost, "utf8"), fixture.payloads.nginxVhost);
});

test("已有未知 tmpfiles 内容、未密封计划或任意运行参数均被拒绝且不改配置", (t) => {
  const fixture = createFixture(t);
  const candidate = structuredClone(fixture.plan);
  candidate.status = "candidate";
  nativeFs.writeFileSync(fixture.targets.tmpfiles, "unexpected\n", "utf8");

  assert.throws(
    () =>
      assertFixedPlan({
        plan: candidate,
        fixedTargets: fixture.targets,
        secretSource: fixture.plan.secretSource
      }),
    (error) => error.code === "unsealed_or_invalid_plan"
  );
  assert.throws(
    () => assertNoRuntimeArguments(["node", "action", "--anything"]),
    (error) => error.code === "runtime_arguments_forbidden"
  );
  assert.throws(
    () =>
      applySealedVendingPublicIngressAction({
        plan: fixture.plan,
        runtime: fixture.runtime,
        actionRoot: fixture.actionRoot,
        fixedTargets: fixture.targets,
        secretSource: fixture.plan.secretSource,
        rollbackRoot: fixture.rollbackRoot
      }),
    (error) => error.code === "config_target_hash_mismatch"
  );
  assert.equal(nativeFs.readFileSync(fixture.targets.tmpfiles, "utf8"), "unexpected\n");
  assert.deepEqual(fixture.commands, []);
});

test("非 root-owned metadata 与不安全的 VNC 令牌目录均被拒绝", (t) => {
  const fixture = createFixture(t);
  nativeFs.mkdirSync(dirname(fixture.targets.secretTarget), { recursive: true });
  fixture.runtime.setOwnership(dirname(fixture.targets.secretTarget), 1001, 1001);

  assert.throws(
    () =>
      assertRootOwnedRegularFile(
        {
          isFile: () => true,
          isSymbolicLink: () => false,
          uid: 1001,
          gid: 0,
          mode: 0o100644
        },
        0o644
      ),
    (error) => error.code === "root_owned_file_required"
  );
  assert.throws(
    () =>
      assertRootOwnedDirectory({
        isDirectory: () => true,
        isSymbolicLink: () => false,
        uid: 0,
        gid: 0,
        mode: 0o40775
      }),
    (error) => error.code === "root_owned_directory_required"
  );
  assert.throws(
    () =>
      applySealedVendingPublicIngressAction({
        plan: fixture.plan,
        runtime: fixture.runtime,
        actionRoot: fixture.actionRoot,
        fixedTargets: fixture.targets,
        secretSource: fixture.plan.secretSource,
        rollbackRoot: fixture.rollbackRoot
      }),
    (error) => error.code === "root_vnc_credential_directory_required"
  );
  assert.deepEqual(fixture.commands, []);
});

test("加载计划时必须同时通过 root-owned 文件与固定 SHA-256", (t) => {
  const fixture = createFixture(t);
  const planPath = join(fixture.actionRoot, "vending-public-ingress.plan.json");
  const digestPath = join(fixture.actionRoot, "vending-public-ingress.plan.sha256");
  const rawPlan = `${JSON.stringify(fixture.plan)}\n`;
  nativeFs.writeFileSync(planPath, rawPlan, "utf8");
  nativeFs.writeFileSync(digestPath, `${sha256(rawPlan)}\n`, "utf8");

  const loaded = loadSealedPlan({ runtime: fixture.runtime, actionRoot: fixture.actionRoot });
  assert.deepEqual(loaded.plan, fixture.plan);
  assert.equal(loaded.planSha256, sha256(rawPlan));

  nativeFs.writeFileSync(digestPath, `${"0".repeat(64)}\n`, "utf8");
  assert.throws(
    () => loadSealedPlan({ runtime: fixture.runtime, actionRoot: fixture.actionRoot }),
    (error) => error.code === "plan_digest_mismatch"
  );
});

test("受限 root action 工件与受管服务使用同一固定令牌和 payload 合同", () => {
  const adminActionRoot = join(repositoryRoot, "deploy", "admin-actions");
  const planTemplate = JSON.parse(
    nativeFs.readFileSync(join(adminActionRoot, "vending-public-ingress.plan.template.json"), "utf8")
  );
  const prepareWrapper = nativeFs.readFileSync(
    join(adminActionRoot, "vending-public-ingress-prepare"),
    "utf8"
  );
  const activateWrapper = nativeFs.readFileSync(
    join(adminActionRoot, "vending-public-ingress-activate"),
    "utf8"
  );
  const rollbackWrapper = nativeFs.readFileSync(
    join(adminActionRoot, "vending-public-ingress-rollback"),
    "utf8"
  );
  const rollbackReadinessWrapper = nativeFs.readFileSync(
    join(adminActionRoot, "vending-public-ingress-rollback-readiness"),
    "utf8"
  );
  const sudoers = nativeFs.readFileSync(join(adminActionRoot, "vending-public-ingress.sudoers"), "utf8");
  const service = nativeFs.readFileSync(
    join(repositoryRoot, "deploy", "systemd", "vending-public-api-edge-relay.service"),
    "utf8"
  );

  assert.equal(
    nativeFs.readFileSync(join(adminActionRoot, "payload", "vending-edge.conf"), "utf8"),
    nativeFs.readFileSync(join(repositoryRoot, "deploy", "tmpfiles.d", "vending-edge.conf"), "utf8")
  );
  assert.equal(
    nativeFs.readFileSync(
      join(adminActionRoot, "payload", "vending-api-edge-unix-socket.conf"),
      "utf8"
    ),
    nativeFs.readFileSync(
      join(repositoryRoot, "deploy", "nginx", "vending-api-edge-unix-socket.conf"),
      "utf8"
    )
  );
  assert.equal(planTemplate.status, "candidate");
  assert.equal(planTemplate.targets.secretTarget, "/etc/vending/credentials/vnc/private-api-relay.token");
  assert.match(service, /PUBLIC_EDGE_RELAY_SHARED_TOKEN_FILE=\/etc\/vending\/credentials\/vnc\/private-api-relay\.token/u);
  for (const wrapper of [prepareWrapper, activateWrapper, rollbackReadinessWrapper, rollbackWrapper]) {
    assert.match(wrapper, /\[ "\$#" -ne 0 \]/u);
    assert.match(wrapper, /\ncd \/\n/u);
    assert.match(wrapper, /\/usr\/bin\/env -i PATH=\/usr\/bin:\/bin HOME=\/root/u);
    assert.doesNotMatch(wrapper, /\$@|\$\*/u);
  }
  assert.match(sudoers, /NOSETENV: NOPASSWD:/u);
  assert.equal(sudoers.includes("*"), false);
  assert.equal((sudoers.match(/""/gu) ?? []).length, 4);
});
