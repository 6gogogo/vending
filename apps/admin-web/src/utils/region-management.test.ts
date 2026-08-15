import assert from "node:assert/strict";
import test from "node:test";

import { buildRegionManagementRows } from "./region-management";

test("历史人员地区无需重新输入即可进入待补详细坐标分栏", () => {
  const rows = buildRegionManagementRows(
    [
      {
        id: "region-default",
        name: "默认",
        status: "active",
        sortOrder: 1,
        longitude: 120.309113,
        latitude: 31.537098
      }
    ],
    [
      { regionName: "翠园社区", neighborhood: "翠园社区" },
      { regionName: "翠园社区", neighborhood: "翠园社区" }
    ]
  );

  assert.deepEqual(
    rows.unlocated.map((row) => ({ name: row.name, source: row.source, userCount: row.userCount })),
    [{ name: "翠园社区", source: "legacy", userCount: 2 }]
  );
  assert.deepEqual(rows.all.map((row) => row.name), ["翠园社区", "默认"]);
});

test("已建档但未定位的地区只显示一次并保留地区编号", () => {
  const rows = buildRegionManagementRows(
    [
      {
        id: "region-cuiyuan",
        name: "翠园社区",
        status: "active",
        sortOrder: 2
      }
    ],
    [
      {
        regionId: "region-cuiyuan",
        regionName: "翠园社区",
        neighborhood: "翠园社区"
      }
    ]
  );

  assert.deepEqual(rows.unlocated, [
    {
      id: "region-cuiyuan",
      name: "翠园社区",
      source: "configured",
      status: "active",
      sortOrder: 2,
      longitude: undefined,
      latitude: undefined,
      userCount: 1,
      isLocated: false
    }
  ]);
});

test("同名地区同时存在正式绑定和历史名称时合并统计人数", () => {
  const rows = buildRegionManagementRows(
    [
      {
        id: "region-cuiyuan",
        name: "翠园社区",
        status: "active",
        sortOrder: 2
      }
    ],
    [
      { regionId: "region-cuiyuan", regionName: "翠园社区" },
      { regionName: "翠园社区", neighborhood: "翠园社区" }
    ]
  );

  assert.equal(rows.unlocated.length, 1);
  assert.equal(rows.unlocated[0]?.userCount, 2);
});
