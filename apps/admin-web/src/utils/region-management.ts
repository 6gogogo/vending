import type { RegionRecord, UserRecord } from "@vm/shared-types";

type RegionManagementUser = Pick<
  UserRecord,
  "regionId" | "regionName" | "neighborhood"
>;

export interface RegionManagementRow {
  id?: string;
  name: string;
  source: "configured" | "legacy";
  status: RegionRecord["status"];
  sortOrder: number;
  longitude?: number;
  latitude?: number;
  userCount: number;
  isLocated: boolean;
}

export interface RegionManagementRows {
  all: RegionManagementRow[];
  unlocated: RegionManagementRow[];
}

const readUserRegionName = (user: RegionManagementUser) =>
  user.regionName?.trim() || user.neighborhood?.trim() || "";

export const buildRegionManagementRows = (
  regions: RegionRecord[],
  users: RegionManagementUser[]
): RegionManagementRows => {
  const configuredNames = new Set(regions.map((region) => region.name));
  const userCountsByName = new Map<string, number>();

  users.forEach((user) => {
    const name = readUserRegionName(user);
    if (name) {
      userCountsByName.set(name, (userCountsByName.get(name) ?? 0) + 1);
    }
  });

  const configuredRows = regions.map<RegionManagementRow>((region) => ({
    id: region.id,
    name: region.name,
    source: "configured",
    status: region.status,
    sortOrder: region.sortOrder,
    longitude: region.longitude,
    latitude: region.latitude,
    userCount: users.filter(
      (user) => user.regionId === region.id || readUserRegionName(user) === region.name
    ).length,
    isLocated: region.longitude !== undefined && region.latitude !== undefined
  }));
  const legacyRows = Array.from(userCountsByName.entries())
    .filter(([name]) => !configuredNames.has(name))
    .map<RegionManagementRow>(([name, userCount]) => ({
      name,
      source: "legacy",
      status: "active",
      sortOrder: Number.MAX_SAFE_INTEGER,
      userCount,
      isLocated: false
    }));
  const all = [...configuredRows, ...legacyRows].sort((left, right) => {
    if (left.isLocated !== right.isLocated) {
      return left.isLocated ? 1 : -1;
    }
    if (left.sortOrder !== right.sortOrder) {
      return left.sortOrder - right.sortOrder;
    }
    return left.name.localeCompare(right.name, "zh-Hans-CN");
  });

  return {
    all,
    unlocated: all.filter((row) => !row.isLocated)
  };
};
