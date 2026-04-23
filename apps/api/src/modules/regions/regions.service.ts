import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";

import type { RegionRecord } from "@vm/shared-types";

import { InMemoryStoreService } from "../../common/store/in-memory-store.service";

@Injectable()
export class RegionsService {
  constructor(@Inject(InMemoryStoreService) private readonly store: InMemoryStoreService) {}

  list() {
    return this.store.regions
      .slice()
      .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name));
  }

  create(
    payload: { name: string; sortOrder?: number; longitude?: number; latitude?: number },
    actorUserId?: string
  ) {
    const name = payload.name.trim();
    const coordinates = this.normalizeCoordinates(payload, true);

    if (!name) {
      throw new BadRequestException("区域名称不能为空。");
    }

    if (this.store.regions.some((entry) => entry.name === name)) {
      throw new BadRequestException("该区域名称已存在。");
    }

    const region: RegionRecord = {
      id: this.store.createId("region"),
      name,
      status: "active",
      sortOrder: payload.sortOrder ?? this.store.regions.length + 1,
      longitude: coordinates.longitude,
      latitude: coordinates.latitude,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.store.regions.push(region);
    this.store.logOperation({
      category: "user",
      type: "create-region",
      status: "success",
      actor: this.getActor(actorUserId),
      primarySubject: {
        type: "user",
        id: region.id,
        label: region.name
      },
      metadata: {
        regionId: region.id,
        regionName: region.name,
        undoState: "not_undoable"
      }
    });
    return region;
  }

  update(
    id: string,
    payload: Partial<Pick<RegionRecord, "name" | "status" | "sortOrder" | "longitude" | "latitude">>,
    actorUserId?: string
  ) {
    const region = this.store.regions.find((entry) => entry.id === id);

    if (!region) {
      throw new NotFoundException("未找到对应区域。");
    }

    if (payload.name !== undefined) {
      const normalized = payload.name.trim();

      if (!normalized) {
        throw new BadRequestException("区域名称不能为空。");
      }

      if (this.store.regions.some((entry) => entry.id !== id && entry.name === normalized)) {
        throw new BadRequestException("该区域名称已存在。");
      }

      region.name = normalized;
    }

    if (payload.status) {
      region.status = payload.status;
    }

    if (payload.sortOrder !== undefined) {
      region.sortOrder = payload.sortOrder;
    }

    const coordinates = this.normalizeCoordinates(payload, false, region);
    region.longitude = coordinates.longitude;
    region.latitude = coordinates.latitude;
    region.updatedAt = new Date().toISOString();

    for (const user of this.store.users) {
      if (user.regionId === region.id) {
        user.regionName = region.name;
        user.neighborhood = region.name;
      }
    }

    for (const application of this.store.registrationApplications) {
      if (application.profile.regionId === region.id) {
        application.profile.regionName = region.name;
        application.profile.neighborhood = region.name;
      }
    }

    this.store.logOperation({
      category: "user",
      type: "update-region",
      status: "success",
      actor: this.getActor(actorUserId),
      primarySubject: {
        type: "user",
        id: region.id,
        label: region.name
      },
      metadata: {
        regionId: region.id,
        regionName: region.name,
        undoState: "not_undoable"
      }
    });

    return region;
  }

  private normalizeCoordinates(
    payload: { longitude?: number; latitude?: number },
    requireBoth: boolean,
    current?: Pick<RegionRecord, "longitude" | "latitude">
  ) {
    const hasLongitude = payload.longitude !== undefined;
    const hasLatitude = payload.latitude !== undefined;

    if (!hasLongitude && !hasLatitude) {
      if (requireBoth && (current?.longitude === undefined || current?.latitude === undefined)) {
        throw new BadRequestException("请填写地区经纬度。");
      }

      return {
        longitude: current?.longitude,
        latitude: current?.latitude
      };
    }

    if (!hasLongitude || !hasLatitude) {
      throw new BadRequestException("经纬度需要同时填写。");
    }

    return {
      longitude: this.normalizeCoordinate(payload.longitude!, "经度", -180, 180),
      latitude: this.normalizeCoordinate(payload.latitude!, "纬度", -90, 90)
    };
  }

  private normalizeCoordinate(value: number, label: "经度" | "纬度", min: number, max: number) {
    const numericValue = Number(value);

    if (!Number.isFinite(numericValue)) {
      throw new BadRequestException(`${label}格式不正确。`);
    }

    if (numericValue < min || numericValue > max) {
      throw new BadRequestException(`${label}超出有效范围。`);
    }

    return Number(numericValue.toFixed(6));
  }

  private getActor(actorUserId?: string) {
    const actor =
      this.store.users.find((entry) => entry.id === actorUserId) ??
      this.store.users.find((entry) => entry.role === "admin");

    if (actor) {
      return {
        type: "admin" as const,
        id: actor.id,
        name: actor.name,
        role: actor.role
      };
    }

    return {
      type: "system" as const,
      name: "系统"
    };
  }
}
