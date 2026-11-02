import assert from "node:assert/strict";
import { test } from "node:test";
import ExcelJS from "exceljs";
import { readPickupWorkbook } from "./pickup-workbook-preview";

test("预览读取实际单元格、格式、合并和底色，截断展示而不改动文件", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("领取明细");
  sheet.pageSetup.printArea = "A1:F150";
  sheet.mergeCells("B2:F2"); sheet.getCell("B2").value = "领取明细";
  sheet.getCell("B7").value = new Date("2026-11-02T00:00:00Z"); sheet.getCell("B7").numFmt = "yyyy-mm-dd";
  sheet.getCell("C7").value = "=1+1";
  sheet.getCell("D7").value = .5 + .8 / 86400; sheet.getCell("D7").numFmt = "hh:mm:ss";
  sheet.getCell("E7").value = .125; sheet.getCell("E7").numFmt = "0.0%";
  sheet.getCell("F7").value = 3;
  sheet.getCell("F7").fill = {type:"pattern",pattern:"solid",fgColor:{argb:"E7EFF3"}};
  sheet.getCell("B150").value = "末行";
  const buffer = await workbook.xlsx.writeBuffer();
  const [preview] = await readPickupWorkbook(buffer as unknown as ArrayBuffer);
  assert.equal(preview.rows.length, 100); assert.equal(preview.totalRows, 150);
  assert.equal(preview.rows[1].cells.find(c=>c.address==="B2")?.colspan,5);
  assert.deepEqual(preview.rows[6].cells.slice(1).map(c=>c.text),["2026-11-02","=1+1","12:00:01","12.5%","3"]);
  assert.equal(preview.rows[6].cells.at(-1)?.style.backgroundColor,"#E7EFF3");
  assert.equal(sheet.getCell("B150").value,"末行");
});

test("概览采用工作簿图表源数据，隐藏源数据列不出现在预览表格", async () => {
  const workbook=new ExcelJS.Workbook(), sheet=workbook.addWorksheet("领取概览");
  sheet.pageSetup.printArea="A1:U40";
  sheet.getCell("AA2").value="11-01";sheet.getCell("AB2").value=8;
  sheet.getCell("AA3").value="11-02";sheet.getCell("AB3").value=0;
  sheet.getColumn(27).hidden=true;sheet.getColumn(28).hidden=true;
  const [preview]=await readPickupWorkbook(await workbook.xlsx.writeBuffer() as unknown as ArrayBuffer);
  assert.equal(preview.columns.at(-1)?.label,"U");
  assert.deepEqual(preview.chart?.points,[{date:"11-01",value:8},{date:"11-02",value:0}]);
});
