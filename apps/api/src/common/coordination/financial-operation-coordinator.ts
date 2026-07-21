import { Injectable } from "@nestjs/common";

export interface FinancialOperationLease {
  readonly eventId: string;
  readonly businessOrderNo: string;
}

@Injectable()
export class FinancialOperationCoordinator {
  private readonly locks = new Map<string, Promise<void>>();
  private readonly activeLeases = new WeakSet<FinancialOperationLease>();

  async run<T>(
    eventId: string,
    businessOrderNo: string,
    action: (lease: FinancialOperationLease) => Promise<T>
  ): Promise<T> {
    const normalizedEventId = this.normalizeKeyPart(eventId, "事件编号");
    const normalizedBusinessOrderNo = this.normalizeKeyPart(
      businessOrderNo,
      "业务订单号"
    );
    const key = `${normalizedEventId}\0${normalizedBusinessOrderNo}`;
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.locks.set(key, tail);

    await previous;
    const lease = Object.freeze({
      eventId: normalizedEventId,
      businessOrderNo: normalizedBusinessOrderNo
    });
    this.activeLeases.add(lease);

    try {
      return await action(lease);
    } finally {
      this.activeLeases.delete(lease);
      release();

      if (this.locks.get(key) === tail) {
        this.locks.delete(key);
      }
    }
  }

  assertActiveLease(
    lease: FinancialOperationLease | undefined,
    eventId: string,
    businessOrderNo: string
  ) {
    const normalizedEventId = this.normalizeKeyPart(eventId, "事件编号");
    const normalizedBusinessOrderNo = this.normalizeKeyPart(
      businessOrderNo,
      "业务订单号"
    );
    if (
      !lease ||
      !this.activeLeases.has(lease) ||
      lease.eventId !== normalizedEventId ||
      lease.businessOrderNo !== normalizedBusinessOrderNo
    ) {
      throw new Error("金融操作租约无效或与当前业务订单不匹配。");
    }
  }

  private normalizeKeyPart(value: string, label: string) {
    const normalized = value?.trim();
    if (!normalized) {
      throw new Error(`${label}不能为空。`);
    }
    return normalized;
  }
}
