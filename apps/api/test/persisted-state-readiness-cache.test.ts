import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { InMemoryStoreService } from "../src/common/store/in-memory-store.service.js";
import { createSeededPersistedState } from "../src/common/store/persistence.js";

const withEnvironment = (
  values: Record<string, string | undefined>,
  action: () => void
) => {
  const previous = new Map(
    Object.keys(values).map((key) => [key, process.env[key]])
  );

  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    action();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
};

test("Store 在启动时缓存持久化完整性结论", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "vm-persisted-state-readiness-"));
  const dataFile = join(directory, "store.json");
  const invalidState = createSeededPersistedState() as unknown as Record<string, unknown>;
  ((invalidState.goodsCatalog as Array<Record<string, unknown>>)[0]!).name = "";
  writeFileSync(dataFile, `${JSON.stringify(invalidState, null, 2)}\n`, "utf8");
  t.after(() => rmSync(directory, { recursive: true, force: true }));

  withEnvironment(
    {
      API_DATA_FILE: dataFile,
      NODE_ENV: "test",
      APP_ENV: undefined,
      ENABLE_TEST_DEVICE_BOOTSTRAP: "false"
    },
    () => {
      const store = new InMemoryStoreService();
      assert.equal(store.isPersistedStateIntegrityReady(), false);
    }
  );
});
