import assert from "node:assert/strict";
import test from "node:test";

import {
  buildPickupDeviceUrl,
  buildPickupLoginUrl,
  parseWechatCabinetQr,
  resolveCabinetEntry,
  resolvePickupLoginTarget,
  resolvePickupPostLoginUrl
} from "./cabinet-entry";

test("微信普通链接二维码解析出柜机编号", () => {
  assert.equal(
    parseWechatCabinetQr("https%3A%2F%2Fvending.5gogogo.top%2Fcabinet%2F91110265"),
    "91110265"
  );
  assert.equal(
    parseWechatCabinetQr("https://vending.5gogogo.top/cabinet/SIM-APP-ACCEPTANCE-001/"),
    "SIM-APP-ACCEPTANCE-001"
  );
});

test("微信二维码只解码一次并拒绝非专用前缀", () => {
  const rejected = [
    "https%253A%252F%252Fvending.5gogogo.top%252Fcabinet%252F91110265",
    "http://vending.5gogogo.top/cabinet/91110265",
    "https://5gogogo.top/cabinet/91110265",
    "https://vending.5gogogo.top/cabinet/",
    "https://vending.5gogogo.top/cabinet/91110265/extra",
    "https://vending.5gogogo.top/cabinet/91110265?source=test",
    "%E0%A4%A"
  ];

  for (const value of rejected) {
    assert.equal(parseWechatCabinetQr(value), "");
  }
});

test("微信 q 和小程序内扫码都进入即时领取，普通入口进入预约", () => {
  assert.deepEqual(
    resolveCabinetEntry({
      q: "https%3A%2F%2Fvending.5gogogo.top%2Fcabinet%2F91110265"
    }),
    { deviceCode: "91110265", mode: "pickup" }
  );
  assert.deepEqual(resolveCabinetEntry({ deviceCode: "CAB-1001", scan: "1" }), {
    deviceCode: "CAB-1001",
    mode: "pickup"
  });
  assert.deepEqual(resolveCabinetEntry({ deviceCode: "CAB-1001" }), {
    deviceCode: "CAB-1001",
    mode: "reservation"
  });
});

test("存在无效 q 时关闭式拒绝，不回退到客户端柜机编号", () => {
  assert.equal(
    resolveCabinetEntry({
      q: "https://example.com/cabinet/CAB-1001",
      deviceCode: "CAB-1001",
      scan: "1"
    }),
    undefined
  );
  assert.equal(resolveCabinetEntry({ deviceCode: "../CAB-1001", scan: "1" }), undefined);
});

test("登录回跳 URL 只携带规范柜机编号和即时领取模式", () => {
  assert.equal(
    buildPickupLoginUrl("SIM-APP-ACCEPTANCE-001"),
    "/pages/common/app-login?entry=pickup&deviceCode=SIM-APP-ACCEPTANCE-001"
  );
  assert.equal(
    buildPickupDeviceUrl("SIM-APP-ACCEPTANCE-001"),
    "/pages/special/device-detail?deviceCode=SIM-APP-ACCEPTANCE-001&scan=1"
  );
});

test("登录页只恢复有效的扫码领取目标", () => {
  assert.deepEqual(
    resolvePickupLoginTarget({ entry: "pickup", deviceCode: "CAB-1001" }),
    { deviceCode: "CAB-1001" }
  );
  assert.equal(
    resolvePickupLoginTarget({ entry: "pickup", deviceCode: "../CAB-1001" }),
    undefined
  );
  assert.equal(
    resolvePickupLoginTarget({ entry: "reservation", deviceCode: "CAB-1001" }),
    undefined
  );
});

test("只有特殊群体账号登录后恢复扫码领取，其他角色回各自首页", () => {
  assert.equal(
    resolvePickupPostLoginUrl("special", { deviceCode: "CAB-1001" }),
    "/pages/special/device-detail?deviceCode=CAB-1001&scan=1"
  );
  assert.equal(resolvePickupPostLoginUrl("merchant", { deviceCode: "CAB-1001" }), undefined);
  assert.equal(resolvePickupPostLoginUrl("restocker", { deviceCode: "CAB-1001" }), undefined);
  assert.equal(resolvePickupPostLoginUrl("admin", { deviceCode: "CAB-1001" }), undefined);
  assert.equal(resolvePickupPostLoginUrl("special", undefined), undefined);
});
