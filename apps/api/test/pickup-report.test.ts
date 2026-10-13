import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { unzipSync, strFromU8 } from "fflate";
import type { InMemoryStoreService } from "../src/common/store/in-memory-store.service";
import { collectPickupReport, validatePickupReportQuery } from "../src/modules/analytics/pickup-report.model";
import { buildPickupWorkbook } from "../src/modules/analytics/pickup-report.workbook";
import { AnalyticsController } from "../src/modules/analytics/analytics.controller";
import { ALLOWED_BACKOFFICE_ALL_PERMISSIONS_KEY, TENANT_SCOPED_BACKOFFICE_ROUTE_KEY } from "../src/common/guards/allowed-roles.decorator";

function fixture() {
  const users = [
    { id: "u1", tenantId: "a", role: "special", name: "=1+1", phone: "13812345678", regionName: "街道甲", neighborhood: "社区甲" },
    { id: "u2", tenantId: "a", role: "special", name: "测试乙", phone: "13912345678" },
    { id: "foreign", tenantId: "b", role: "special", name: "其他实例", phone: "13712345678" }
  ];
  const devices = [{ deviceCode: "d1", tenantId: "a", name: "公益柜甲" }, { deviceCode: "d2", tenantId: "b", name: "其他实例柜" }];
  const events = [
    { eventId: "late", userId: "u1", deviceCode: "d1", role: "special", status: "settled" },
    { eventId: "early", userId: "u2", deviceCode: "d1", role: "special", status: "settled" },
    { eventId: "missing", userId: "u1", deviceCode: "d1", role: "special", status: "settled" },
    { eventId: "foreign", userId: "foreign", deviceCode: "d2", role: "special", status: "settled" },
    { eventId: "failed", userId: "u1", deviceCode: "d1", role: "special", status: "failed" }
  ];
  const callbackLog = events.filter(e => e.eventId !== "missing").map(e => ({ type: "door-status", payload: { eventId: e.eventId, status: "SUCCESS", deviceCode: e.deviceCode }, receivedAt: `2026-10-03T${e.eventId === "early" ? "02" : "07"}:00:00Z` }));
  const inventory = events.map(e => ({ id: `m-${e.eventId}`, eventId: e.eventId, orderNo: e.eventId, userId: e.userId, deviceCode: e.deviceCode, goodsId: "g1", goodsName: "面包", quantity: 2, type: "pickup", happenedAt: "2026-10-04T00:00:00Z" }));
  inventory.push({ ...inventory[0], id: "refund", type: "refund", quantity: 1, happenedAt: "2026-10-05T10:00:00Z" });
  return { users, devices, events, callbackLog, inventory, goodsCatalog: [{ goodsId: "g1", name: "面包" }], platformTenants: [{ id: "a", name: "甲实例" }], getUserTenantId: (u: { tenantId: string }) => u.tenantId, getDeviceTenantId: (d: { tenantId: string }) => d.tenantId };
}
const query = { startDate: "2026-10-03", endDate: "2026-10-09" };
const collect = (data = fixture(), extra = {}) => collectPickupReport(data as unknown as InMemoryStoreService, "a", { ...query, ...extra }, new Date("2026-10-10T00:00:00Z"));

test("按原开门日统计迟到结算和退回，日期正序、日内时间正序，隔离其他实例和失败记录", () => {
  const data = fixture(); data.inventory.push(data.inventory[0]);
  const report = collect(data);
  assert.deepEqual(report.rows.map(r => [r.date, r.time, r.quantity]), [["2026-10-03", "10:00:00", 2], ["2026-10-03", "15:00:00", 1]]);
  assert.equal(report.omittedEvents, 1);
  assert.equal(report.rows[1].phone, "138****5678");
  assert.equal(report.rows[1].region, "街道甲 / 社区甲");
  assert.throws(() => collectPickupReport(data as unknown as InMemoryStoreService, undefined, query), /进入客户实例/);
  data.inventory.push({ ...data.inventory[0], id: "forged", userId: "foreign" });
  assert.equal(collect(data).rows.reduce((n, r) => n + r.quantity, 0), 3);
});

test("过滤起止业务日、拒绝异常日期范围和未授权字段，不信任客户端租户", () => {
  for (const bad of [{ startDate: "2026-02-30" }, { endDate: "2026-10-02" }, { endDate: "2030-01-01" }, { fields: "password" }, { sections: "" }]) {
    assert.throws(() => validatePickupReportQuery({ ...query, ...bad }));
  }
  assert.equal(collect(fixture(), { startDate: "2026-10-04" }).rows.length, 0);
  assert.equal(collect(fixture(), { tenantId: "b" }).rows[0].deviceCode, "d1");
  const report = collect(fixture(), { fields: "date,time", sections: "people" });
  assert.deepEqual(report.sections, ["people"]);
});

test("默认工作簿只有明细与概览，不包含未勾选的手机号、柜机和人员编号，文字不执行成公式", async () => {
  const report = collect();
  const data = await buildPickupWorkbook(report), wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ExcelJS.Buffer);
  assert.deepEqual(wb.worksheets.map(s => s.name), ["领取明细", "领取概览"]);
  const detail = wb.worksheets[0];
  assert.equal(detail.getCell("C8").value, "=1+1");
  assert.equal(detail.getCell("C8").type, ExcelJS.ValueType.String);
  assert.equal(detail.getColumn(1).width, 8);
  assert.equal(detail.getCell("E6").value, "派发出的物资");
  assert.equal(detail.getCell("F8").value, 1);
  const summary = wb.worksheets[1];
  assert.deepEqual(["B7", "G7", "L7", "Q7"].map(c => summary.getCell(c).value), [2, 2, 3, 1]);
  const zip = unzipSync(data), text = Object.values(zip).map(value => strFromU8(value)).join("");
  assert.ok(zip["xl/charts/pickup.xml"]);
  assert.ok(!text.includes("13812345678") && !text.includes("138****5678") && !text.includes("社区甲"));
  assert.ok(!text.includes("关门时间") && !text.includes("结算时间") && !text.includes("领取小时"));
});

test("可选列与人员/柜机独立工作表，空范围和超过七天的概览均可导出", async () => {
  const report = collect(fixture(), { fields: "date,person,time,goods,quantity,device,region,phone", sections: "detail,overview,people,devices", endDate: "2026-11-03" });
  const data = await buildPickupWorkbook(report), wb = new ExcelJS.Workbook();
  await wb.xlsx.load(data as unknown as ExcelJS.Buffer);
  assert.deepEqual(wb.worksheets.map(s => s.name), ["领取明细", "领取概览", "按人员汇总", "按柜机汇总"]);
  assert.equal(wb.worksheets[0].getCell("I8").value, "138****5678");
  assert.equal(wb.worksheets[3].getCell("F7").value, 3);
  assert.equal(wb.worksheets[2].getCell("E7").value, 2);
  const empty = collect(fixture(), { startDate: "2026-10-09" });
  const emptyWb = new ExcelJS.Workbook(); await emptyWb.xlsx.load(await buildPickupWorkbook(empty) as unknown as ExcelJS.Buffer);
  assert.equal(emptyWb.worksheets[1].getCell("L7").value, 0);
  const subset = collect(fixture(), { fields: "time", sections: "detail" });
  const subsetWb = new ExcelJS.Workbook(); await subsetWb.xlsx.load(await buildPickupWorkbook(subset) as unknown as ExcelJS.Buffer);
  assert.equal(subsetWb.worksheets.length, 1); assert.equal(subsetWb.worksheets[0].getCell("B6").value, "领取时间");
});

test("导出接口同时要求实例内数据监控与导出权限", () => {
  const handler = AnalyticsController.prototype.exportPickups;
  assert.deepEqual(Reflect.getMetadata(ALLOWED_BACKOFFICE_ALL_PERMISSIONS_KEY, handler), ["analytics:data-monitor:view", "operation-logs:export"]);
  assert.equal(Reflect.getMetadata(TENANT_SCOPED_BACKOFFICE_ROUTE_KEY, handler), true);
});

test("业务日边界和多日排序正确，重复回调采用首次成功开门", () => {
  const data = fixture();
  data.callbackLog[0].receivedAt = "2026-10-03T20:00:00Z";
  data.callbackLog[1].receivedAt = "2026-10-03T19:59:59Z";
  data.callbackLog.push({ ...data.callbackLog[1], receivedAt: "2026-10-04T03:00:00Z" });
  assert.deepEqual(collect(data).rows.map(r => [r.date, r.time]), [["2026-10-03", "03:59:59"], ["2026-10-04", "04:00:00"]]);
  assert.equal(collect(data, { startDate: "2026-10-04", endDate: "2026-10-04" }).rows.length, 1);
});

test("一次领取多种物资仍只算一次人次，全部退回不计入派发", async () => {
  const data = fixture();
  data.inventory.push({ ...data.inventory[0], id: "second-goods", goodsId: "g2", goodsName: "水", quantity: 3 });
  data.inventory.push({ ...data.inventory[1], id: "full-refund", type: "refund", quantity: 2 });
  const report = collect(data), wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await buildPickupWorkbook(report) as unknown as ExcelJS.Buffer);
  assert.equal(report.rows.length, 2);
  assert.deepEqual(["B7", "G7", "L7", "Q7"].map(c => wb.worksheets[1].getCell(c).value), [1, 1, 4, 2]);
});
