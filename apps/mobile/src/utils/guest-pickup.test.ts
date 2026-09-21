import assert from "node:assert/strict";
import test from "node:test";
import { resolveGuestPrimaryActionUrl } from "./guest-pickup";
import { scanDeviceCode } from "./scan-device";

test("游客扫码只进入浏览，不能把普通查询参数当作已扫码开门", async () => {
  let scans = 0;
  const url = await resolveGuestPrimaryActionUrl({ deviceCode: "QUERY-ONLY" }, async () => {
    scans += 1;
    return "SCANNED-001";
  });
  assert.equal(scans, 1);
  assert.equal(url, "/pages/special/device-detail?deviceCode=SCANNED-001&scan=1");
});

test("已扫码游客主动点击开门才进入登录，不重复扫描或发出开门请求", async () => {
  const url = await resolveGuestPrimaryActionUrl({ deviceCode: "91110265", scanned: true }, async () => {
    assert.fail("已扫码目标不应重复调用相机");
  });
  assert.equal(url, "/pages/common/app-login?entry=pickup&deviceCode=91110265");
});

test("取消扫码继续浏览，非法柜机目标不能进入登录续接", async () => {
  assert.equal(await resolveGuestPrimaryActionUrl({}, async () => ""), undefined);
  assert.equal(await resolveGuestPrimaryActionUrl({}, async () => { throw { errMsg: "scanCode:fail cancel" }; }), undefined);
  await assert.rejects(resolveGuestPrimaryActionUrl({}, async () => "../admin"));
  await assert.rejects(resolveGuestPrimaryActionUrl({}, async () => { throw new Error("相机不可用"); }));
});

test("扫码提示取消不申请相机，同意后只接收相机二维码并返回浏览目标", async () => {
  const runtime = globalThis as typeof globalThis & { uni?: unknown };
  const previous = runtime.uni;
  let confirmed = false;
  let cameraCalls = 0;
  runtime.uni = {
    showModal: (options: { success: (result: { confirm: boolean }) => void }) => options.success({ confirm: confirmed }),
    scanCode: (options: { onlyFromCamera: boolean; success: (result: { result: string }) => void }) => {
      cameraCalls += 1;
      assert.equal(options.onlyFromCamera, true);
      options.success({ result: "https://vending.example/cabinet?deviceCode=91110265" });
    }
  };
  try {
    assert.equal(await resolveGuestPrimaryActionUrl({}, scanDeviceCode), undefined);
    assert.equal(cameraCalls, 0);
    confirmed = true;
    assert.equal(await resolveGuestPrimaryActionUrl({}, scanDeviceCode), "/pages/special/device-detail?deviceCode=91110265&scan=1");
    assert.equal(cameraCalls, 1);
  } finally { runtime.uni = previous; }
});
