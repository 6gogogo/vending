import { Inject, Injectable } from "@nestjs/common";

import type { PlatformOverviewSnapshot, PlatformTenantUsageSummary } from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";
import { DeviceOperationCoordinator } from "../devices/device-operation-coordinator";

@Injectable()
export class PlatformService {
  constructor(
    @Inject(InMemoryStoreService) private readonly store: InMemoryStoreService,
    @Inject(DeviceOperationCoordinator) private readonly deviceOperations: DeviceOperationCoordinator
  ) {}

  listTenants() {
    return this.store.listPlatformTenants();
  }

  getOverview(): PlatformOverviewSnapshot {
    const tenants = this.store.listPlatformTenants().map((tenant): PlatformTenantUsageSummary => {
      const ownsCurrentInstanceData = tenant.id === this.store.getDefaultTenantId();
      const users = ownsCurrentInstanceData ? this.store.users : [];
      const devices = ownsCurrentInstanceData ? this.store.devices : [];
      const inventory = ownsCurrentInstanceData ? this.store.inventory : [];
      const pendingTasks = ownsCurrentInstanceData
        ? this.store.alerts.filter((entry) => entry.status === "open")
        : [];
      const logs = ownsCurrentInstanceData ? this.store.logs : [];
      const lastActivityAt = [
        ...inventory.map((entry) => entry.happenedAt),
        ...logs.map((entry) => entry.occurredAt),
        ...devices.map((entry) => entry.lastSeenAt)
      ]
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1);

      return {
        tenant,
        metrics: {
          users: users.filter((entry) => entry.role === "special").length,
          merchants: users.filter((entry) => entry.role === "merchant").length,
          devices: devices.length,
          onlineDevices: devices.filter(
            (entry) => this.deviceOperations.getEffectiveStatus(entry.deviceCode) === "online"
          ).length,
          inventoryUnits: this.store.goodsBatches
            .filter(() => ownsCurrentInstanceData)
            .reduce((sum, entry) => sum + entry.remainingQuantity, 0),
          pickupCount: inventory.filter((entry) => entry.type === "pickup").length,
          donationCount: inventory.filter((entry) => entry.type === "donation" || entry.type === "manual-restock").length,
          pendingTasks: pendingTasks.length,
          operationLogs: logs.length
        },
        lastActivityAt
      };
    });

    return {
      generatedAt: new Date().toISOString(),
      totals: {
        tenants: tenants.length,
        activeTenants: tenants.filter((entry) => entry.tenant.status === "active").length,
        users: this.sumMetric(tenants, "users"),
        merchants: this.sumMetric(tenants, "merchants"),
        devices: this.sumMetric(tenants, "devices"),
        onlineDevices: this.sumMetric(tenants, "onlineDevices"),
        inventoryUnits: this.sumMetric(tenants, "inventoryUnits"),
        pickupCount: this.sumMetric(tenants, "pickupCount"),
        donationCount: this.sumMetric(tenants, "donationCount"),
        pendingTasks: this.sumMetric(tenants, "pendingTasks"),
        operationLogs: this.sumMetric(tenants, "operationLogs")
      },
      tenants
    };
  }

  private sumMetric(
    tenants: PlatformTenantUsageSummary[],
    key: keyof PlatformTenantUsageSummary["metrics"]
  ) {
    return tenants.reduce((sum, entry) => sum + entry.metrics[key], 0);
  }
}
