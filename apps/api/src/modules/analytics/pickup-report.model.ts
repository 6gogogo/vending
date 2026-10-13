import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { addDaysToDateKey, getBusinessDayKey, getBusinessTimezoneOffsetHours, getBusinessDayStartHour } from "../../common/time/business-day";

export const REPORT_FIELDS = ["date", "person", "time", "goods", "quantity", "device", "region", "phone"] as const;
export const REPORT_SECTIONS = ["detail", "overview", "people", "devices"] as const;
export type ReportField = typeof REPORT_FIELDS[number];
export type ReportSection = typeof REPORT_SECTIONS[number];
export interface PickupReportQuery { startDate?: string; endDate?: string; fields?: string; sections?: string }
export interface PickupReportRow {
  date: string; time: string; openedAt: string; personId: string; person: string;
  goodsId: string; goods: string; quantity: number; eventId: string;
  deviceCode: string; device: string; region: string; phone: string;
}
export interface PickupReport {
  startDate: string; endDate: string; generatedAt: string; title: string;
  fields: ReportField[]; sections: ReportSection[]; rows: PickupReportRow[];
  dates: string[]; omittedEvents: number; timezoneOffset: number; businessDayStartHour: number;
}

function selection<T extends string>(raw: string | undefined, allowed: readonly T[], defaults: T[]): T[] {
  if (raw === undefined) return defaults;
  if (typeof raw !== "string") throw new BadRequestException("导出选项格式不正确");
  const selected = [...new Set(raw.split(",").filter(Boolean))];
  if (selected.some(value => !allowed.includes(value as T))) throw new BadRequestException("包含不支持的导出选项");
  return allowed.filter(value => selected.includes(value));
}

export function validatePickupReportQuery(query: PickupReportQuery) {
  const validDate = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
  if (!validDate(query.startDate) || !validDate(query.endDate)) throw new BadRequestException("请选择有效的开始和结束日期");
  const days = (Date.parse(query.endDate) - Date.parse(query.startDate)) / 86_400_000 + 1;
  if (days < 1 || days > 366) throw new BadRequestException("开始日期不能晚于结束日期，单次最多导出 366 天");
  const fields = selection(query.fields, REPORT_FIELDS, ["date", "person", "time", "goods", "quantity"]);
  const sections = selection(query.sections, REPORT_SECTIONS, ["detail", "overview"]);
  if (!sections.length || (sections.includes("detail") && !fields.length)) throw new BadRequestException("请至少选择一个工作表，并为领取明细选择字段");
  return { startDate: query.startDate, endDate: query.endDate, fields, sections,
    dates: Array.from({ length: days }, (_, i) => addDaysToDateKey(query.startDate!, i)) };
}

/** 只读取会话所属实例。以成功开门回调确定领取时间，禁止拿结算时间冒充。 */
export function collectPickupReport(store: InMemoryStoreService, tenantId: string | undefined, query: PickupReportQuery, now = new Date()): PickupReport {
  if (!tenantId) throw new ForbiddenException("请先进入客户实例再导出领取报告");
  const options = validatePickupReportQuery(query);
  const devices = new Map(store.devices.filter(d => store.getDeviceTenantId(d) === tenantId).map(d => [d.deviceCode, d]));
  const users = new Map(store.users.filter(u => store.getUserTenantId(u) === tenantId && u.role === "special").map(u => [u.id, u]));
  const events = new Map(store.events.filter(e => devices.has(e.deviceCode) && users.has(e.userId) && e.role === "special"
    && (!e.operationType || e.operationType === "pickup") && ["settled", "refunded"].includes(e.status)).map(e => [e.eventId, e]));
  const goods = new Map(store.goodsCatalog.map(g => [g.goodsId, g]));
  // 兼容历史货品合并记录，避免同一货品的旧编号被分开汇总。
  const canonical = (id: string) => {
    const visited = new Set<string>();
    while (true) {
      const item = goods.get(id);
      if (!item || !("mergedIntoGoodsId" in item) || typeof item.mergedIntoGoodsId !== "string" || !item.mergedIntoGoodsId) return id;
      if (visited.has(id)) throw new BadRequestException("货品合并关系存在循环，请先核对货品资料");
      visited.add(id); id = item.mergedIntoGoodsId;
    }
  };
  const opened = new Map<string, string>();
  for (const callback of store.callbackLog) {
    const { eventId, status, deviceCode } = callback.payload;
    if (callback.type !== "door-status" || status !== "SUCCESS" || !eventId || !events.has(eventId)
      || (deviceCode && deviceCode !== events.get(eventId)!.deviceCode) || !Number.isFinite(Date.parse(callback.receivedAt))) continue;
    if (!opened.has(eventId) || Date.parse(callback.receivedAt) < Date.parse(opened.get(eventId)!)) opened.set(eventId, callback.receivedAt);
  }
  const groups = new Map<string, { row: PickupReportRow; gross: number; returned: number }>();
  const omitted = new Set<string>();
  const seenMovements = new Set<string>();
  const offset = getBusinessTimezoneOffsetHours();
  // 同一个原事件和货品只生成一行，退回量只抵扣一次；迟到结算仍归原领取日。
  for (const m of store.inventory) {
    if (!m.eventId || !events.has(m.eventId) || !["pickup", "adjustment", "refund"].includes(m.type) || seenMovements.has(m.id)) continue;
    const event = events.get(m.eventId)!;
    if (m.deviceCode !== event.deviceCode || m.userId !== event.userId || !Number.isSafeInteger(m.quantity) || m.quantity < 0) continue;
    seenMovements.add(m.id);
    const openedAt = opened.get(event.eventId);
    if (!openedAt) {
      if (Number.isFinite(Date.parse(m.happenedAt))) {
        const date = getBusinessDayKey(m.happenedAt);
        if (date >= options.startDate && date <= options.endDate) omitted.add(event.eventId);
      }
      continue;
    }
    const date = getBusinessDayKey(openedAt);
    if (date < options.startDate || date > options.endDate) continue;
    const goodsId = canonical(m.goodsId), key = JSON.stringify([event.eventId, goodsId]);
    const user = users.get(event.userId)!;
    if (!groups.has(key)) groups.set(key, { gross: 0, returned: 0, row: {
      date, openedAt, time: new Date(Date.parse(openedAt) + offset * 3_600_000).toISOString().slice(11, 19),
      personId: user.id, person: user.name, goodsId, goods: goods.get(goodsId)?.name ?? m.goodsName,
      quantity: 0, eventId: event.eventId, deviceCode: event.deviceCode, device: devices.get(event.deviceCode)!.name,
      region: [user.regionName, user.neighborhood].filter((v, i, list) => v && list.indexOf(v) === i).join(" / "),
      phone: /^\d{11}$/.test(user.phone) ? `${user.phone.slice(0, 3)}****${user.phone.slice(-4)}` : "未提供"
    } });
    const group = groups.get(key)!;
    if (m.type === "refund") group.returned += m.quantity; else group.gross += m.quantity;
  }
  const rows = [...groups.values()].map(g => ({ ...g.row, quantity: Math.max(0, g.gross - g.returned) })).filter(r => r.quantity > 0)
    .sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.eventId.localeCompare(b.eventId) || a.goodsId.localeCompare(b.goodsId));
  if (rows.length > 50_000) throw new BadRequestException("领取记录超过 5 万行，请缩短导出日期范围");
  const tenant = store.platformTenants.find(t => t.id === tenantId);
  return { ...options, rows, omittedEvents: omitted.size, title: `${tenant?.name ?? "公益智助柜"} / 领取报告`,
    generatedAt: now.toISOString(), timezoneOffset: offset, businessDayStartHour: getBusinessDayStartHour() };
}
