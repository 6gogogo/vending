export const adminCopy = {
  users: {
    batchRemoveNoSelection: "批量删除失败：请先选择需要删除的人员。",
    batchRemoveIncludesCurrent: "批量删除失败：不能包含当前登录账号。",
    batchRemoveFirstConfirmation: (count: number) =>
      `第一次确认：将从当前人员台账中删除 ${count} 人，历史记录仍会保留。是否继续？`,
    batchRemoveSecondConfirmation: (count: number) =>
      `第二次确认：确定删除这 ${count} 人吗？该操作不能直接撤销。`,
    batchRemoveSuccess: (count: number) =>
      `已从人员台账中删除 ${count} 人，历史记录仍保留用于追溯。`,
    batchRemoveFailed: (reason: string) => `批量删除人员失败：${reason}`,
    batchRemoveButton: (count: number) => `批量删除（${count}）`,
    batchRemovingButton: "删除中",
    regionLegacySummary: (count: number) =>
      `来自现有人员 · ${count} 人 · 未设置地图位置`,
    regionLocatedSummary: (longitude: number, latitude: number, count: number) =>
      `${longitude.toFixed(6)}, ${latitude.toFixed(6)} · ${count} 人`,
    regionUnlocatedSummary: (count: number) => `未设置地图位置 · ${count} 人`,
    regionLegacyStatus: "未设置位置",
    regionLocationSaved: (name: string) =>
      `地区“${name}”的位置已保存，原有人员已自动关联，无需重新迁移。`,
    regionAllLocated: "所有地区都已设置详细坐标",
    regionListEmpty: "当前还没有地区"
  },
  map: {
    unsupported: "当前环境不支持地图加载",
    mockMode: "当前地图服务尚未启用，暂时不能搜索地点；请联系服务管理员完成地图服务设置，或先手工录入坐标。",
    missingWebKey: "地图服务尚未完成设置。",
    scriptLoadFailed: "地图服务暂时不可用，请确认服务授权和当前站点设置。",
    searchUnavailable: "地图服务尚未就绪，暂时无法搜索地点。",
    searchNoResult: "未找到地点，请尝试更具体的关键词。",
    searchInvalidCredential: (_info: string) => "地图搜索暂时不可用，请确认服务设置后重试，或改为手工录入坐标。",
    searchFailed: (_info?: string) => "地图搜索暂时不可用，请稍后重试，或改为手工录入坐标。"
  }
} as const;
