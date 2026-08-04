import assert from "node:assert/strict";
import test from "node:test";

import { parsePersonnelImportRows } from "./personnel-import";

test("特殊群体 Excel 行会规范化手机号、标签、区域和额度", () => {
  const result = parsePersonnelImportRows(
    [
      ["姓名", "手机号", "区域名称", "区域编号", "标签", "每日总额度", "食品额度", "饮品额度", "日用品额度"],
      ["张三", 18800000001, "梁溪区", "region-liangxi", "独居，低保;高龄", 3, 2, 1, 0],
      [null, null, null]
    ],
    "special"
  );

  assert.deepEqual(result.issues, []);
  assert.equal(result.sourceRowCount, 1);
  assert.deepEqual(result.entries, [
    {
      phone: "18800000001",
      name: "张三",
      neighborhood: "梁溪区",
      regionName: "梁溪区",
      regionId: "region-liangxi",
      tags: ["独居", "低保", "高龄"],
      quota: {
        dailyLimit: 3,
        categoryLimit: { food: 2, drink: 1, daily: 0 }
      }
    }
  ]);
});

test("商家导入拒绝额度列并报告 Excel 行号", () => {
  const result = parsePersonnelImportRows(
    [
      ["姓名", "手机号", "每日总额度"],
      ["爱心商户", "18800000002", 10]
    ],
    "merchant"
  );

  assert.deepEqual(result.entries, []);
  assert.match(result.issues[0]?.message ?? "", /商家导入不使用额度/u);
  assert.equal(result.issues[0]?.row, 2);
});

test("模板列、手机号、重复行和总额度都在提交前校验", () => {
  const invalidHeader = parsePersonnelImportRows(
    [["姓名", "手机号", "备注"], ["张三", "18800000001", "不应静默忽略"]],
    "special"
  );
  assert.match(invalidHeader.issues[0]?.message ?? "", /不支持列/u);

  const invalidRows = parsePersonnelImportRows(
    [
      ["姓名", "手机号", "食品额度"],
      ["张三", "123", 1],
      ["李四", "123", 2]
    ],
    "special"
  );
  assert.deepEqual(invalidRows.entries, []);
  assert.ok(invalidRows.issues.some((issue) => issue.row === 2 && /11 位/u.test(issue.message)));
  assert.ok(invalidRows.issues.some((issue) => issue.row === 2 && /每日总额度/u.test(issue.message)));
});

test("空模板和超过 500 行都不会产生可提交数据", () => {
  assert.match(
    parsePersonnelImportRows([["姓名", "手机号"]], "special").issues[0]?.message ?? "",
    /没有人员数据/u
  );

  const rows = [
    ["姓名", "手机号"],
    ...Array.from({ length: 501 }, (_, index) => [
      `用户${index + 1}`,
      String(13000000000 + index)
    ])
  ];
  const result = parsePersonnelImportRows(rows, "special");
  assert.deepEqual(result.entries, []);
  assert.ok(result.issues.some((issue) => /最多导入 500 人/u.test(issue.message)));
});
