import ExcelJS from "exceljs";

export interface PreviewCell {
  address: string; text: string; colspan: number; rowspan: number;
  style: Record<string, string>;
}
export interface PreviewSheet {
  name: string; columns: Array<{ label: string; width: number }>;
  rows: Array<{ number: number; height: number; cells: PreviewCell[] }>;
  totalRows: number; width: number; height: number;
  chart?: { left: number; top: number; width: number; height: number; points: Array<{ date: string; value: number }> };
}

const color = (argb?: string) => argb ? `#${argb.slice(-6)}` : undefined;
function display(cell: ExcelJS.Cell): string {
  const value = cell.value;
  const format = cell.numFmt ?? "";
  if (value instanceof Date) {
    return format.includes("hh:mm") ? new Date(Math.round(value.getTime() / 1000) * 1000).toISOString().slice(11, 19) : value.toISOString().slice(0, 10);
  }
  if (typeof value === "number") {
    if (format.includes("hh:mm")) {
      const seconds = Math.round(value * 86400) % 86400;
      return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, "0")).join(":");
    }
    if (format.includes("%")) return `${(value * 100).toFixed(format.includes("0.0") ? 1 : 0)}%`;
  }
  return cell.text;
}

/** 读取实际下载文件的单元格和样式；不另算业务指标，也不执行公式。 */
export async function readPickupWorkbook(data: ArrayBuffer): Promise<PreviewSheet[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(data as unknown as ExcelJS.Buffer);
  return workbook.worksheets.map(sheet => {
    const end = sheet.pageSetup.printArea?.split(":").at(-1)?.match(/([A-Z]+)(\d+)$/);
    const endColumn = end ? Number(sheet.getCell(`${end[1]}1`).col) : sheet.columnCount;
    const totalRows = end ? Number(end[2]) : sheet.rowCount;
    const count = Math.min(100, totalRows);
    const columns = Array.from({ length: endColumn }, (_, i) => sheet.getColumn(i + 1))
      .filter(column => !column.hidden).map(column => ({ label: column.letter, width: Math.round((column.width ?? 9) * 7 + 5) }));
    const spans = new Map<string, { colspan: number; rowspan: number }>();
    for (const range of sheet.model.merges) {
      const [first, last] = range.split(":").map(address => sheet.getCell(address));
      spans.set(first.address, { colspan: Number(last.col) - Number(first.col) + 1, rowspan: Math.min(Number(last.row), count) - Number(first.row) + 1 });
    }
    const rows = Array.from({ length: count }, (_, i) => {
      const row = sheet.getRow(i + 1);
      const cells = columns.flatMap(column => {
        const cell = row.getCell(column.label);
        if (cell.isMerged && cell.master.address !== cell.address) return [];
        const fill = cell.fill?.type === "pattern" ? color(cell.fill.fgColor?.argb) : undefined;
        return [{ address: cell.address, text: display(cell), colspan: spans.get(cell.address)?.colspan ?? 1, rowspan: spans.get(cell.address)?.rowspan ?? 1,
          style: {
            backgroundColor: fill ?? "#ffffff", color: color(cell.font?.color?.argb) ?? "#243b4a",
            fontWeight: cell.font?.bold ? "700" : "400", fontSize: `${(cell.font?.size ?? 11) * 4 / 3}px`,
            textAlign: cell.alignment?.horizontal === "center" ? "center" : cell.alignment?.horizontal === "right" ? "right" : "left",
            whiteSpace: cell.alignment?.wrapText ? "normal" : "nowrap",
            borderColor: color(cell.border?.bottom?.color?.argb) ?? "#e4e9ed"
          } }];
      });
      return { number: i + 1, height: (row.height ?? sheet.properties.defaultRowHeight ?? 20) * 4 / 3, cells };
    });
    const result: PreviewSheet = { name: sheet.name, columns, rows, totalRows,
      width: 42 + columns.reduce((sum, column) => sum + column.width, 0), height: 28 + rows.reduce((sum, row) => sum + row.height, 0) };
    // 概览原生图表的数据引用固定为 AA/AB，网页用同一组数据绘制。
    if (sheet.name === "领取概览") {
      const points = Array.from({ length: sheet.getColumn(27).values.length - 2 }, (_, i) => ({ date: sheet.getCell(i + 2, 27).text, value: Number(sheet.getCell(i + 2, 28).value) })).filter(point => point.date);
      result.chart = { left: 42 + columns[0].width, top: 28 + rows.slice(0, 11).reduce((n, row) => n + row.height, 0),
        width: columns.slice(1, 10).reduce((n, column) => n + column.width, 0), height: rows.slice(11, 22).reduce((n, row) => n + row.height, 0), points };
    }
    return result;
  });
}
