import type { AccessQuota, UserRecord } from "@vm/shared-types";

export type PersonnelImportRole = Extract<UserRecord["role"], "special" | "merchant">;
export type PersonnelImportCell = string | number | boolean | Date | null | undefined;

export interface PersonnelImportEntry {
  phone: string;
  name: string;
  neighborhood?: string;
  regionId?: string;
  regionName?: string;
  tags?: string[];
  quota?: AccessQuota;
}

export interface PersonnelImportIssue {
  row: number;
  field: string;
  message: string;
}

export interface PersonnelImportResult {
  entries: PersonnelImportEntry[];
  issues: PersonnelImportIssue[];
  sourceRowCount: number;
}

export const PERSONNEL_IMPORT_HEADERS = [
  "姓名",
  "手机号",
  "区域名称",
  "区域编号",
  "标签",
  "每日总额度",
  "食品额度",
  "饮品额度",
  "日用品额度"
] as const;

type PersonnelImportHeader = (typeof PERSONNEL_IMPORT_HEADERS)[number];

const requiredHeaders = new Set<PersonnelImportHeader>(["姓名", "手机号"]);
const quotaHeaders: PersonnelImportHeader[] = [
  "每日总额度",
  "食品额度",
  "饮品额度",
  "日用品额度"
];
const MAX_IMPORT_ROWS = 500;

const cellText = (value: PersonnelImportCell) => {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
};

const splitTags = (value: string) =>
  Array.from(
    new Set(
      value
        .split(/[，,；;]/u)
        .map((item) => item.trim())
        .filter(Boolean)
    )
  );

const readNonNegativeInteger = (
  rawValue: PersonnelImportCell,
  row: number,
  field: PersonnelImportHeader,
  issues: PersonnelImportIssue[]
) => {
  const text = cellText(rawValue);
  if (!text) return undefined;
  const value = typeof rawValue === "number" ? rawValue : Number(text);
  if (!Number.isInteger(value) || value < 0) {
    issues.push({ row, field, message: `${field}必须是非负整数。` });
    return undefined;
  }
  return value;
};

export function parsePersonnelImportRows(
  rows: PersonnelImportCell[][],
  role: PersonnelImportRole
): PersonnelImportResult {
  const issues: PersonnelImportIssue[] = [];
  if (!rows.length) {
    return {
      entries: [],
      issues: [{ row: 1, field: "表格", message: "Excel 文件没有可读取的内容。" }],
      sourceRowCount: 0
    };
  }

  const headerIndexes = new Map<PersonnelImportHeader, number>();
  const allowedHeaders = new Set<string>(PERSONNEL_IMPORT_HEADERS);
  rows[0]?.forEach((rawHeader, index) => {
    const header = cellText(rawHeader);
    if (!header) return;
    if (!allowedHeaders.has(header)) {
      issues.push({ row: 1, field: header, message: `不支持列“${header}”，请使用下载的模板。` });
      return;
    }
    const typedHeader = header as PersonnelImportHeader;
    if (headerIndexes.has(typedHeader)) {
      issues.push({ row: 1, field: header, message: `列“${header}”重复。` });
      return;
    }
    headerIndexes.set(typedHeader, index);
  });

  for (const header of requiredHeaders) {
    if (!headerIndexes.has(header)) {
      issues.push({ row: 1, field: header, message: `缺少必填列“${header}”。` });
    }
  }

  if (issues.length) {
    return { entries: [], issues, sourceRowCount: 0 };
  }

  const entries: PersonnelImportEntry[] = [];
  const phoneRows = new Map<string, number>();
  let sourceRowCount = 0;

  for (let index = 1; index < rows.length; index += 1) {
    const rawRow = rows[index] ?? [];
    const hasContent = rawRow.some((cell) => cellText(cell) !== "");
    if (!hasContent) continue;

    sourceRowCount += 1;
    const excelRow = index + 1;
    const issueCountBeforeRow = issues.length;
    const read = (header: PersonnelImportHeader) => rawRow[headerIndexes.get(header) ?? -1];
    const name = cellText(read("姓名"));
    const phone = cellText(read("手机号"));
    const regionName = cellText(read("区域名称"));
    const regionId = cellText(read("区域编号"));
    const tags = splitTags(cellText(read("标签")));

    if (!name) {
      issues.push({ row: excelRow, field: "姓名", message: "姓名不能为空。" });
    } else if ([...name].length > 100 || /[\r\n]/u.test(name)) {
      issues.push({ row: excelRow, field: "姓名", message: "姓名必须是 1 至 100 个字符的单行文本。" });
    }

    if (!/^1\d{10}$/u.test(phone)) {
      issues.push({ row: excelRow, field: "手机号", message: "手机号必须是 11 位中国大陆手机号。" });
    } else {
      const firstRow = phoneRows.get(phone);
      if (firstRow !== undefined) {
        issues.push({
          row: excelRow,
          field: "手机号",
          message: `手机号与第 ${firstRow} 行重复。`
        });
      } else {
        phoneRows.set(phone, excelRow);
      }
    }

    for (const [field, value] of [
      ["区域名称", regionName],
      ["区域编号", regionId]
    ] as const) {
      if ([...value].length > 100 || /[\r\n]/u.test(value)) {
        issues.push({ row: excelRow, field, message: `${field}不能超过 100 个字符且不能换行。` });
      }
    }

    if (tags.length > 50 || tags.some((tag) => [...tag].length > 50)) {
      issues.push({ row: excelRow, field: "标签", message: "标签最多 50 项，每项不能超过 50 个字符。" });
    }

    let quota: AccessQuota | undefined;
    const hasQuotaValue = quotaHeaders.some((header) => cellText(read(header)) !== "");
    if (role === "merchant" && hasQuotaValue) {
      issues.push({ row: excelRow, field: "额度", message: "商家导入不使用额度列，请将额度单元格留空。" });
    } else if (role === "special" && hasQuotaValue) {
      const dailyLimit = readNonNegativeInteger(read("每日总额度"), excelRow, "每日总额度", issues);
      if (cellText(read("每日总额度")) === "") {
        issues.push({ row: excelRow, field: "每日总额度", message: "填写分类额度时必须同时填写每日总额度。" });
      }
      const food = readNonNegativeInteger(read("食品额度"), excelRow, "食品额度", issues);
      const drink = readNonNegativeInteger(read("饮品额度"), excelRow, "饮品额度", issues);
      const daily = readNonNegativeInteger(read("日用品额度"), excelRow, "日用品额度", issues);
      if (dailyLimit !== undefined) {
        quota = {
          dailyLimit,
          categoryLimit: {
            ...(food !== undefined ? { food } : {}),
            ...(drink !== undefined ? { drink } : {}),
            ...(daily !== undefined ? { daily } : {})
          }
        };
      }
    }

    if (issues.length !== issueCountBeforeRow) continue;

    entries.push({
      phone,
      name,
      ...(regionName ? { neighborhood: regionName, regionName } : {}),
      ...(regionId ? { regionId } : {}),
      ...(tags.length ? { tags } : {}),
      ...(quota ? { quota } : {})
    });
  }

  if (sourceRowCount === 0) {
    issues.push({ row: 2, field: "表格", message: "模板中没有人员数据。" });
  } else if (sourceRowCount > MAX_IMPORT_ROWS) {
    issues.push({
      row: 2,
      field: "表格",
      message: `每次最多导入 ${MAX_IMPORT_ROWS} 人，请拆分文件。`
    });
  }

  return { entries: issues.length ? [] : entries, issues, sourceRowCount };
}
