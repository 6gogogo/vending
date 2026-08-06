import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const pagesDirectory = fileURLToPath(new URL("../pages/", import.meta.url));

test("后台浮层只能通过明确按钮关闭，点击外部遮罩不会丢失当前操作", () => {
  const violations: string[] = [];

  for (const fileName of readdirSync(pagesDirectory).filter((entry) =>
    entry.endsWith(".vue")
  )) {
    const source = readFileSync(`${pagesDirectory}/${fileName}`, "utf8");
    const backdropElements = source.match(
      /<div\b[^>]*class="[^"]*backdrop[^"]*"[^>]*>/gu
    ) ?? [];

    if (backdropElements.some((element) => element.includes("@click.self"))) {
      violations.push(fileName);
    }
  }

  assert.deepEqual(violations, []);
});
