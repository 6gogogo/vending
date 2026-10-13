import ExcelJS from "exceljs";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { PickupReport, PickupReportRow, ReportField } from "./pickup-report.model";

const INK = "243B4A", PALE = "E7EFF3", LINE = "C7D2D9", MUTED = "667783";
const font = { name: "Microsoft YaHei", size: 11, color: { argb: INK } };
const fill = (argb: string): ExcelJS.Fill => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
const border: Partial<ExcelJS.Borders> = Object.fromEntries(["top", "bottom", "left", "right"].map(side => [side, { style: "thin", color: { argb: LINE } }]));
const names: Record<ReportField, string> = { date: "领取日期", person: "领取人", time: "领取时间", goods: "派发出的物资", quantity: "领取数量 / 件", device: "柜机名称 / 编号", region: "社区 / 街道", phone: "手机号（脱敏）" };
const widths: Record<ReportField, number> = { date: 15, person: 12, time: 14, goods: 31, quantity: 17, device: 30, region: 28, phone: 20 };
const sum = (rows: PickupReportRow[]) => rows.reduce((n, r) => n + r.quantity, 0);
const unique = (rows: PickupReportRow[], field: "personId" | "eventId" | "goodsId") => new Set(rows.map(r => r[field])).size;
const groupRows = (rows: PickupReportRow[], field: "personId" | "deviceCode" | "goodsId") => {
  const groups = new Map<string, PickupReportRow[]>();
  for (const row of rows) {
    const entries = groups.get(row[field]);
    if (entries) entries.push(row); else groups.set(row[field], [row]);
  }
  return [...groups.values()];
};
const localStamp = (report: PickupReport) => new Date(Date.parse(report.generatedAt) + report.timezoneOffset * 3_600_000).toISOString().slice(0, 16).replace("T", " ");

function write(sheet: ExcelJS.Worksheet, address: string, value: ExcelJS.CellValue, style?: Partial<ExcelJS.Style>) {
  const cell = sheet.getCell(address); cell.value = value;
  cell.style = { font: { ...font }, alignment: { vertical: "middle", horizontal: typeof value === "number" ? "right" : "left" }, ...style };
  return cell;
}
function merged(sheet: ExcelJS.Worksheet, address: string, value: ExcelJS.CellValue, style?: Partial<ExcelJS.Style>) {
  sheet.mergeCells(address);
  const [start, end] = address.split(":").map(a => sheet.getCell(a));
  const master = write(sheet, start.address, value, style);
  for (let row = Number(start.row); row <= Number(end.row); row++) for (let col = Number(start.col); col <= Number(end.col); col++) sheet.getCell(row, col).style = master.style;
  return master;
}
function heading(sheet: ExcelJS.Worksheet, row: number, labels: string[], start = 2) {
  sheet.getRow(row).height = 30;
  labels.forEach((text, i) => write(sheet, sheet.getCell(row, start + i).address, text, {
    font: { ...font, bold: true, color: { argb: "FFFFFF" } }, fill: fill(INK), border,
    alignment: { vertical: "middle", horizontal: "center" }
  }));
}
function base(wb: ExcelJS.Workbook, name: string, report: PickupReport, lastColumn: number) {
  const sheet = wb.addWorksheet(name, { views: [{ showGridLines: true }], properties: { defaultRowHeight: 27 } });
  sheet.getColumn(1).width = 8;
  sheet.pageSetup = { paperSize: 9, orientation: lastColumn > 7 ? "landscape" : "portrait", fitToPage: true, fitToWidth: 1, fitToHeight: 0,
    margins: { left: .25, right: .25, top: .3, bottom: .3, header: .15, footer: .15 } };
  sheet.getRow(1).height = 15; sheet.getRow(2).height = 32;
  merged(sheet, `B2:${sheet.getColumn(lastColumn).letter}2`, name === "领取概览" ? report.title : name, { font: { ...font, size: 16, bold: true } });
  merged(sheet, `B3:${sheet.getColumn(lastColumn).letter}3`, `${report.startDate} 至 ${report.endDate}    截至 ${localStamp(report)}`, { font: { ...font, size: 10, color: { argb: MUTED } } });
  return sheet;
}

function detail(wb: ExcelJS.Workbook, report: PickupReport) {
  const fields = report.fields, lastColumn = Math.max(6, fields.length + 1);
  const sheet = base(wb, "领取明细", report, lastColumn);
  sheet.views = [{ state: "frozen", ySplit: 6, showGridLines: true }];
  fields.forEach((field, i) => { sheet.getColumn(i + 2).width = widths[field]; });
  merged(sheet, `B4:${sheet.getColumn(lastColumn).letter}4`, `日期从旧到新，同一天内时间从早到晚。${report.omittedEvents ? `缺少可信开门时间的 ${report.omittedEvents} 笔事件未纳入。` : "领取时间取成功开门回调。"}`, { font: { ...font, size: 10, color: { argb: MUTED } }, alignment: { wrapText: true, vertical: "middle" } });
  sheet.getRow(4).height = report.omittedEvents ? 36 : 24;
  heading(sheet, 6, fields.map(f => names[f]));
  let lastDate = "", stripe = false;
  report.rows.forEach((r, i) => {
    if (r.date !== lastDate) { stripe = !stripe; lastDate = r.date; }
    fields.forEach((field, j) => {
      let value: ExcelJS.CellValue = field === "device" ? `${r.device} / ${r.deviceCode}` : r[field];
      if (field === "date") value = new Date(`${r.date}T00:00:00Z`);
      if (field === "time") value = ((Date.parse(r.openedAt) + report.timezoneOffset * 3_600_000) % 86_400_000) / 86_400_000;
      write(sheet, sheet.getCell(i + 7, j + 2).address, value, { border, fill: fill(stripe ? PALE : "FFFFFF"),
        alignment: { vertical: "middle", horizontal: ["goods", "device", "region"].includes(field) ? "left" : "center", wrapText: ["goods", "device", "region"].includes(field) },
        numFmt: field === "date" ? "yyyy-mm-dd" : field === "time" ? "hh:mm:ss" : field === "quantity" ? "0" : "@" });
    });
    sheet.getRow(i + 7).height = fields.includes("device") || fields.includes("region") ? 38 : 27;
  });
  if (!report.rows.length) merged(sheet, `B7:${sheet.getColumn(lastColumn).letter}7`, "所选时间段暂无可核对的领取记录");
  sheet.autoFilter = { from: { row: 6, column: 2 }, to: { row: Math.max(7, report.rows.length + 6), column: fields.length + 1 } };
  sheet.pageSetup.printTitlesRow = "6:6";
  sheet.pageSetup.printArea = `A1:${sheet.getColumn(lastColumn).letter}${Math.max(7, report.rows.length + 6)}`;
}

function overview(wb: ExcelJS.Workbook, report: PickupReport) {
  const sheet = base(wb, "领取概览", report, 20);
  for (let c = 2; c <= 20; c++) sheet.getColumn(c).width = 7.5;
  sheet.getColumn(11).width = 3;
  sheet.getColumn(21).width = 2;
  const { rows } = report;
  const metrics = [unique(rows, "personId"), unique(rows, "eventId"), sum(rows), unique(rows, "goodsId")];
  ["服务人数", "累计领取", "发放物资", "物资种类"].forEach((label, i) => {
    const start = 2 + i * 5, end = start + 3, a = sheet.getColumn(start).letter, b = sheet.getColumn(end).letter;
    merged(sheet, `${a}6:${b}6`, label, { fill: fill("F4F7F8"), font: { ...font, size: 10, color: { argb: MUTED } } });
    merged(sheet, `${a}7:${b}8`, metrics[i], { fill: fill("F4F7F8"), font: { ...font, size: 20, bold: true }, alignment: { horizontal: "left", vertical: "middle" } });
    merged(sheet, `${a}9:${b}9`, ["本期去重人数", "人次", "件", "种"][i], { fill: fill("F4F7F8"), font: { ...font, size: 10, color: { argb: MUTED } } });
  });
  const daily = report.dates.map(date => { const group = rows.filter(r => r.date === date); return { date, visits: unique(group, "eventId"), units: sum(group) }; });
  const goods = groupRows(rows, "goodsId").map(group => ({ name: group[0].goods, units: sum(group) })).sort((a, b) => b.units - a.units);
  merged(sheet, "B11:J11", "每日领取", { font: { ...font, bold: true } });
  merged(sheet, "L11:T11", "物资发放", { font: { ...font, bold: true } });
  const head = { fill: fill("F4F7F8"), font: { ...font, size: 10, bold: true, color: { argb: MUTED } }, border };
  merged(sheet, "L12:Q12", "派发出的物资", head); write(sheet, "R12", "件数", head); merged(sheet, "S12:T12", "占比", head);
  goods.forEach((g, i) => { const r = i + 13; merged(sheet, `L${r}:Q${r}`, g.name, { border }); write(sheet, `R${r}`, g.units, { border }); merged(sheet, `S${r}:T${r}`, metrics[2] ? g.units / metrics[2] : 0, { numFmt: "0.0%", border }); });
  if (!goods.length) merged(sheet, "L13:T13", "暂无领取物资");
  const below = Math.max(23, goods.length + 15);
  merged(sheet, `B${below}:J${below}`, "每日领取情况", { font: { ...font, bold: true } });
  if (daily.length <= 7) {
    const totalColumn = sheet.getColumn(3 + daily.length).letter;
    write(sheet, `B${below + 1}`, "日期", head); write(sheet, `B${below + 2}`, "人次"); write(sheet, `B${below + 3}`, "件数", head);
    daily.forEach((d, i) => { const c = sheet.getColumn(i + 3).letter; write(sheet, `${c}${below + 1}`, d.date.slice(5), head); write(sheet, `${c}${below + 2}`, d.visits); write(sheet, `${c}${below + 3}`, d.units, head); });
    write(sheet, `${totalColumn}${below + 1}`, "合计", head); write(sheet, `${totalColumn}${below + 2}`, metrics[1]); write(sheet, `${totalColumn}${below + 3}`, metrics[2], head);
  } else {
    merged(sheet, `B${below + 1}:E${below + 1}`, "日期", head); merged(sheet, `F${below + 1}:G${below + 1}`, "人次", head); merged(sheet, `H${below + 1}:J${below + 1}`, "件数", head);
    daily.forEach((d, i) => { const r = below + 2 + i; merged(sheet, `B${r}:E${r}`, new Date(`${d.date}T00:00:00Z`), { border, numFmt: "yyyy-mm-dd" }); merged(sheet, `F${r}:G${r}`, d.visits, { border }); merged(sheet, `H${r}:J${r}`, d.units, { border }); });
  }
  merged(sheet, `L${below}:T${below}`, "领取时段", { font: { ...font, bold: true } });
  merged(sheet, `L${below + 1}:O${below + 1}`, "时间段", head); merged(sheet, `P${below + 1}:Q${below + 1}`, "人次", head); merged(sheet, `R${below + 1}:T${below + 1}`, "占比", head);
  const bins = [[0, 10], [10, 12], [12, 14], [14, 16], [16, 18], [18, 20], [20, 24]].map(([lo, hi]) => ({ lo, hi, visits: unique(rows.filter(r => Number(r.time.slice(0, 2)) >= lo && Number(r.time.slice(0, 2)) < hi), "eventId") })).filter(b => b.visits > 0);
  bins.forEach((b, i) => { const r = below + 2 + i; merged(sheet, `L${r}:O${r}`, `${String(b.lo).padStart(2, "0")}:00 — ${String(b.hi).padStart(2, "0")}:00`); merged(sheet, `P${r}:Q${r}`, b.visits); merged(sheet, `R${r}:T${r}`, metrics[1] ? b.visits / metrics[1] : 0, { numFmt: "0.0%" }); });
  const footer = below + Math.max(daily.length <= 7 ? 7 : daily.length + 3, bins.length + 3) + 1;
  merged(sheet, `B${footer}:T${footer}`, `领取时间取成功开门回调；业务日 ${String(report.businessDayStartHour).padStart(2, "0")}:00 切换。`, { font: { ...font, size: 10, color: { argb: MUTED } } });
  merged(sheet, `B${footer + 1}:T${footer + 1}`, `不含空取货、开门失败、补货和盘点。${report.omittedEvents ? `缺少可信开门时间的 ${report.omittedEvents} 笔事件未纳入，请核对原始记录。` : ""}`, { font: { ...font, size: 10, color: { argb: MUTED } } });
  daily.forEach((d, i) => { write(sheet, `AA${i + 2}`, d.date.slice(5)); write(sheet, `AB${i + 2}`, d.units); });
  sheet.getColumn(27).hidden = true; sheet.getColumn(28).hidden = true;
  sheet.pageSetup.printArea = `A1:U${footer + 2}`;
  sheet.pageSetup.fitToHeight = daily.length <= 7 && goods.length <= 12 ? 1 : 0;
  for (let row = 1; row <= footer + 2; row++) if (!sheet.getRow(row).height) sheet.getRow(row).height = 19;
  return { sheetId: sheet.id, daily };
}

function grouped(wb: ExcelJS.Workbook, report: PickupReport, by: "personId" | "deviceCode") {
  const people = by === "personId", label = people ? "按人员汇总" : "按柜机汇总";
  const sheet = base(wb, label, report, people ? 6 : 7);
  sheet.pageSetup.orientation = "landscape";
  (people ? [8, 24, 18, 18, 18, 42] : [8, 24, 18, 18, 18, 18, 42]).forEach((width, i) => { sheet.getColumn(i + 1).width = width; });
  heading(sheet, 6, people ? ["领取人", "领取天数", "领取人次", "领取件数", "派发出的物资（件）"] : ["柜机名称", "柜机编号", "服务人数", "领取人次", "领取件数", "派发出的物资（件）"]);
  const groups = groupRows(report.rows, by).sort((a, b) => sum(b) - sum(a));
  groups.forEach((rows, i) => {
    const goods = groupRows(rows, "goodsId").map(entries => `${entries[0].goods} ${sum(entries)} 件`).join("；");
    const values = people ? [rows[0].person, new Set(rows.map(r => r.date)).size, unique(rows, "eventId"), sum(rows), goods] : [rows[0].device, rows[0].deviceCode, unique(rows, "personId"), unique(rows, "eventId"), sum(rows), goods];
    values.forEach((v, j) => write(sheet, sheet.getCell(i + 7, j + 2).address, v, { border, fill: fill(i % 2 ? "FFFFFF" : PALE), alignment: { vertical: "middle", wrapText: true } }));
    sheet.getRow(i + 7).height = Math.max(30, Math.ceil(goods.length / 22) * 16);
  });
  if (!groups.length) write(sheet, "B7", "所选时间段暂无领取记录");
  sheet.views = [{ state: "frozen", ySplit: 6, showGridLines: true }];
  sheet.pageSetup.printTitlesRow = "6:6"; sheet.pageSetup.printArea = `A1:${people ? "F" : "G"}${Math.max(7, groups.length + 6)}`;
}

/** ExcelJS 不提供原生图表写入；只补充固定的 OOXML 图表部件，数据来自本次概览。 */
function addDailyChart(buffer: Buffer, sheetId: number, daily: Array<{ date: string; units: number }>) {
  const files = unzipSync(buffer), put = (name: string, xml: string) => { files[name] = strToU8(xml); };
  const rel = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const pkg = "http://schemas.openxmlformats.org/package/2006/relationships";
  const sheetPath = `xl/worksheets/sheet${sheetId}.xml`;
  put(sheetPath, strFromU8(files[sheetPath]).replace("</worksheet>", '<drawing r:id="rIdPickupChart"/></worksheet>'));
  put(`xl/worksheets/_rels/sheet${sheetId}.xml.rels`, `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${pkg}"><Relationship Id="rIdPickupChart" Type="${rel}/drawing" Target="../drawings/pickup.xml"/></Relationships>`);
  put("xl/drawings/pickup.xml", `<?xml version="1.0" encoding="UTF-8"?><xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><xdr:twoCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>11</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>10</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>22</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="每日领取"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${rel}" r:id="rIdChart"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor></xdr:wsDr>`);
  put("xl/drawings/_rels/pickup.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="${pkg}"><Relationship Id="rIdChart" Type="${rel}/chart" Target="../charts/pickup.xml"/></Relationships>`);
  const cache = (numeric: boolean) => `<c:ptCount val="${daily.length}"/>${daily.map((d, i) => `<c:pt idx="${i}"><c:v>${numeric ? d.units : d.date.slice(5)}</c:v></c:pt>`).join("")}`;
  put("xl/charts/pickup.xml", `<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/><c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/><c:spPr><a:solidFill><a:srgbClr val="337F84"/></a:solidFill></c:spPr><c:cat><c:strRef><c:f>'领取概览'!$AA$2:$AA$${daily.length + 1}</c:f><c:strCache>${cache(false)}</c:strCache></c:strRef></c:cat><c:val><c:numRef><c:f>'领取概览'!$AB$2:$AB$${daily.length + 1}</c:f><c:numCache><c:formatCode>0</c:formatCode>${cache(true)}</c:numCache></c:numRef></c:val></c:ser><c:dLbls><c:dLblPos val="outEnd"/><c:showLegendKey val="0"/><c:showVal val="${daily.length <= 14 ? 1 : 0}"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls><c:gapWidth val="100"/><c:axId val="100"/><c:axId val="200"/></c:barChart><c:catAx><c:axId val="100"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:tickLblPos val="nextTo"/><c:crossAx val="200"/><c:crosses val="autoZero"/><c:tickLblSkip val="${Math.max(1, Math.ceil(daily.length / 8))}"/></c:catAx><c:valAx><c:axId val="200"/><c:scaling><c:orientation val="minMax"/><c:min val="0"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines><c:spPr><a:ln><a:solidFill><a:srgbClr val="DDE5E8"/></a:solidFill></a:ln></c:spPr></c:majorGridlines><c:numFmt formatCode="0" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:crossAx val="100"/><c:crosses val="autoZero"/></c:valAx></c:plotArea><c:plotVisOnly val="0"/></c:chart></c:chartSpace>`);
  put("[Content_Types].xml", strFromU8(files["[Content_Types].xml"]).replace("</Types>", '<Override PartName="/xl/drawings/pickup.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/><Override PartName="/xl/charts/pickup.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/></Types>'));
  return Buffer.from(zipSync(files));
}

export async function buildPickupWorkbook(report: PickupReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook(); wb.creator = "公益智助柜"; wb.created = new Date(report.generatedAt);
  if (report.sections.includes("detail")) detail(wb, report);
  const chart = report.sections.includes("overview") ? overview(wb, report) : undefined;
  if (report.sections.includes("people")) grouped(wb, report, "personId");
  if (report.sections.includes("devices")) grouped(wb, report, "deviceCode");
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  return chart ? addDailyChart(buffer, chart.sheetId, chart.daily) : buffer;
}
