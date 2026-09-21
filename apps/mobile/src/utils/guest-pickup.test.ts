import assert from "node:assert/strict";
import test from "node:test";
import { resolveGuestPickupLoginUrl } from "./guest-pickup";
import { scanDeviceCode } from "./scan-device";

test("普通商品浏览必须扫码，不能把查询参数当作现场扫码结果", async () => {
  let scans = 0;
  const url = await resolveGuestPickupLoginUrl({ deviceCode: "QUERY-ONLY" }, async () => {
    scans += 1;
    return "SCANNED-001";
  });
  assert.equal(scans, 1);
  assert.equal(url, "/pages/common/app-login?entry=pickup&deviceCode=SCANNED-001");
});

test("已从二维码进入的游客沿用扫码目标，登录前不重复扫描或发出开门请求", async () => {
  const url = await resolveGuestPickupLoginUrl({ deviceCode: "91110265", scanned: true }, async () => {
    assert.fail("已扫码目标不应重复调用相机");
  });
  assert.equal(url, "/pages/common/app-login?entry=pickup&deviceCode=91110265");
});

test("取消扫码继续浏览，非法柜机目标不能进入登录续接", async () => {
  assert.equal(await resolveGuestPickupLoginUrl({}, async () => ""), undefined);
  assert.equal(await resolveGuestPickupLoginUrl({}, async () => { throw { errMsg: "scanCode:fail cancel" }; }), undefined);
  await assert.rejects(resolveGuestPickupLoginUrl({}, async () => "../admin"));
  await assert.rejects(resolveGuestPickupLoginUrl({}, async () => { throw new Error("相机不可用"); }));
});

test("扫码提示取消不申请相机，同意后只接收相机二维码并返回登录目标", async () => {
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
    assert.equal(await resolveGuestPickupLoginUrl({}, scanDeviceCode), undefined);
    assert.equal(cameraCalls, 0);
    confirmed = true;
    assert.equal(await resolveGuestPickupLoginUrl({}, scanDeviceCode), "/pages/common/app-login?entry=pickup&deviceCode=91110265");
    assert.equal(cameraCalls, 1);
  } finally { runtime.uni = previous; }
});
