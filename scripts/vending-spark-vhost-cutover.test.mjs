import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const cutoverDirectory = resolve(root, "deploy", "simple-vnc-spark-cutover");
const pythonInvocation = process.env.VENDING_CUTOVER_TEST_PYTHON
  ? { command: process.env.VENDING_CUTOVER_TEST_PYTHON, arguments: [] }
  : process.platform === "win32"
    ? { command: "py", arguments: ["-3"] }
    : { command: "python3", arguments: [] };

test("fixed Python fixture verifies the two-location rewrite and rejection cases", () => {
  const result = spawnSync(
    pythonInvocation.command,
    [...pythonInvocation.arguments, "test_vending_spark_vhost_cutover.py"],
    {
    cwd: cutoverDirectory,
    encoding: "utf8"
    }
  );

  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("root wrappers accept no user parameters and use the fixed installed program", () => {
  for (const filename of ["vending-spark-vhost-cutover", "vending-spark-vhost-rollback"]) {
    const path = resolve(cutoverDirectory, filename);
    assert.equal(existsSync(path), true, filename);
    const source = readFileSync(path, "utf8");
    assert.match(source, /if \[ "\$#" -ne 0 \]/u);
    assert.match(
      source,
      /\/usr\/local\/lib\/vending-spark-vhost-cutover\/vending_spark_vhost_cutover\.py/u
    );
  }
});
