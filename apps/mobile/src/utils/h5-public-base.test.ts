import assert from "node:assert/strict";
import test from "node:test";
import { resolveMobileH5PublicBase } from "../config/h5-public-base";

test("移动 H5 默认继续发布在根路径", () => {
  assert.equal(resolveMobileH5PublicBase(), "/");
  assert.equal(resolveMobileH5PublicBase("  "), "/");
});

test("移动 H5 公网部署可显式发布到 /mobile/", () => {
  assert.equal(resolveMobileH5PublicBase("/mobile/"), "/mobile/");
});

test("移动 H5 拒绝相对路径、协议相对地址和缺失尾斜杠", () => {
  for (const invalidBase of ["mobile/", "//example.com/mobile/", "/mobile", "/mobile/?v=1"]) {
    assert.throws(() => resolveMobileH5PublicBase(invalidBase));
  }
});
