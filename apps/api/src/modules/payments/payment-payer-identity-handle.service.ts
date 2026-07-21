import { GoneException, Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHash, randomBytes } from "node:crypto";

import type { PaymentProvider, UserRole } from "@vm/shared-types";

interface PayerIdentityBinding {
  actorId: string;
  actorRole: UserRole;
  provider: PaymentProvider;
  payerIdentity: string;
  expiresAt: number;
}

@Injectable()
export class PaymentPayerIdentityHandleService {
  private readonly bindings = new Map<string, PayerIdentityBinding>();

  constructor(
    @Inject(ConfigService)
    private readonly configService: ConfigService = new ConfigService()
  ) {}

  issue(
    provider: PaymentProvider,
    actor: { id: string; role: UserRole },
    payerIdentity: string
  ) {
    this.removeExpired();
    if (this.bindings.size >= this.getCapacity()) {
      throw new ServiceUnavailableException("付款身份临时凭据容量已满，请稍后重新授权。");
    }

    const handle = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + this.getTtlMs();
    this.bindings.set(this.digest(handle), {
      actorId: actor.id,
      actorRole: actor.role,
      provider,
      payerIdentity,
      expiresAt
    });

    return {
      handle,
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  consume(
    handle: string,
    provider: PaymentProvider,
    actor: { id: string; role: UserRole }
  ) {
    const normalized = typeof handle === "string" ? handle.trim() : "";
    if (!normalized || normalized.length > 128) {
      throw this.invalidHandle();
    }

    const digest = this.digest(normalized);
    const binding = this.bindings.get(digest);
    if (!binding) {
      throw this.invalidHandle();
    }

    if (binding.expiresAt <= Date.now()) {
      this.bindings.delete(digest);
      throw this.invalidHandle();
    }

    if (
      binding.provider !== provider ||
      binding.actorId !== actor.id ||
      binding.actorRole !== actor.role
    ) {
      throw this.invalidHandle();
    }

    this.bindings.delete(digest);
    return binding.payerIdentity;
  }

  private removeExpired() {
    const now = Date.now();
    for (const [digest, binding] of this.bindings) {
      if (binding.expiresAt <= now) {
        this.bindings.delete(digest);
      }
    }
  }

  private getTtlMs() {
    const configured = Number(
      this.configService.get<string>("PAYMENT_PAYER_IDENTITY_TTL_SECONDS") ?? 120
    );
    const seconds =
      Number.isSafeInteger(configured) && configured >= 30 && configured <= 600
        ? configured
        : 120;
    return seconds * 1_000;
  }

  private getCapacity() {
    const configured = Number(
      this.configService.get<string>("PAYMENT_PAYER_IDENTITY_HANDLE_CAPACITY") ?? 4096
    );
    return Number.isSafeInteger(configured) && configured >= 128 && configured <= 65_536
      ? configured
      : 4096;
  }

  private digest(handle: string) {
    return createHash("sha256").update(handle, "utf8").digest("hex");
  }

  private invalidHandle() {
    return new GoneException("付款身份句柄无效、已过期、已使用或与当前账号及支付渠道不匹配，请重新授权。");
  }
}
