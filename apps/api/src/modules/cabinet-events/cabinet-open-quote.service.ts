import { createHash, randomBytes } from "node:crypto";

import { ConflictException, Injectable } from "@nestjs/common";

import type { CabinetIntentItem, CabinetPreSettlement } from "@vm/shared-types";

export const CABINET_OPEN_QUOTE_TTL_MS = 2 * 60 * 1000;
export const CABINET_OPEN_QUOTE_MAX_ENTRIES = 4_096;

export interface CabinetOpenQuoteContext {
  userId: string;
  deviceCode: string;
  doorNum: string;
  reservationId?: string;
  intentItems: CabinetIntentItem[];
  preSettlement?: CabinetPreSettlement;
}

interface CabinetOpenQuoteRecord {
  fingerprintHash: string;
  ownerHash: string;
  expiresAt: number;
}

@Injectable()
export class CabinetOpenQuoteService {
  private readonly quotes = new Map<string, CabinetOpenQuoteRecord>();
  private readonly latestQuoteByOwner = new Map<string, string>();

  issue(context: CabinetOpenQuoteContext, now = Date.now()) {
    const ownerHash = this.ownerHash(context);
    const previousQuoteId = this.latestQuoteByOwner.get(ownerHash);
    if (previousQuoteId) {
      this.deleteQuote(previousQuoteId);
    }

    while (this.quotes.size >= CABINET_OPEN_QUOTE_MAX_ENTRIES) {
      const oldestQuoteId = this.quotes.keys().next().value as string | undefined;
      if (!oldestQuoteId) {
        break;
      }
      this.deleteQuote(oldestQuoteId);
    }

    const quoteId = `open-quote-${randomBytes(24).toString("base64url")}`;
    const expiresAt = now + CABINET_OPEN_QUOTE_TTL_MS;
    this.quotes.set(quoteId, {
      fingerprintHash: this.fingerprintHash(context),
      ownerHash,
      expiresAt
    });
    this.latestQuoteByOwner.set(ownerHash, quoteId);

    return {
      quoteId,
      quoteExpiresAt: new Date(expiresAt).toISOString()
    };
  }

  consume(
    quoteId: string | undefined,
    context: CabinetOpenQuoteContext,
    options: { required: boolean },
    now = Date.now()
  ): string | undefined {
    if (!quoteId) {
      if (options.required) {
        throw new ConflictException("本次领取需要重新获取并确认预结算报价。");
      }

      return;
    }

    const quote = this.quotes.get(quoteId);

    if (!quote || quote.expiresAt <= now) {
      this.deleteQuote(quoteId);
      throw new ConflictException("预结算报价已失效，请重新确认后再开柜。");
    }

    if (quote.fingerprintHash !== this.fingerprintHash(context)) {
      this.deleteQuote(quoteId);
      throw new ConflictException("商品、额度或价格已经变化，请重新确认预结算报价。");
    }

    // 缓存中的报价只核销一次；后续同命令重放由事件中保存的摘要识别。
    this.deleteQuote(quoteId);
    return this.hashQuoteId(quoteId);
  }

  hashQuoteId(quoteId: string) {
    return this.hash(quoteId);
  }

  private deleteQuote(quoteId: string) {
    const quote = this.quotes.get(quoteId);
    if (!quote) {
      return;
    }

    this.quotes.delete(quoteId);
    if (this.latestQuoteByOwner.get(quote.ownerHash) === quoteId) {
      this.latestQuoteByOwner.delete(quote.ownerHash);
    }
  }

  private ownerHash(context: CabinetOpenQuoteContext) {
    return this.hash(
      JSON.stringify([context.userId, context.deviceCode, context.doorNum])
    );
  }

  private fingerprintHash(context: CabinetOpenQuoteContext) {
    const intentItems = context.intentItems
      .map((item) => ({
        goodsId: item.goodsId,
        goodsName: item.goodsName,
        category: item.category,
        quantity: item.quantity
      }))
      .sort((left, right) => left.goodsId.localeCompare(right.goodsId));
    const preSettlement = context.preSettlement
      ? {
          deviceCode: context.preSettlement.deviceCode,
          doorNum: context.preSettlement.doorNum,
          totalQuantity: context.preSettlement.totalQuantity,
          freeQuantity: context.preSettlement.freeQuantity,
          paidQuantity: context.preSettlement.paidQuantity,
          originalAmount: context.preSettlement.originalAmount,
          freeAmount: context.preSettlement.freeAmount,
          payableAmount: context.preSettlement.payableAmount,
          chargeRequired: context.preSettlement.chargeRequired,
          items: context.preSettlement.items
            .map((item) => ({
              goodsId: item.goodsId,
              goodsName: item.goodsName,
              category: item.category,
              quantity: item.quantity,
              freeQuantity: item.freeQuantity,
              paidQuantity: item.paidQuantity,
              unitPrice: item.unitPrice,
              originalAmount: item.originalAmount,
              freeAmount: item.freeAmount,
              paidAmount: item.paidAmount
            }))
            .sort((left, right) => left.goodsId.localeCompare(right.goodsId))
        }
      : undefined;

    return this.hash(
      JSON.stringify({
        userId: context.userId,
        deviceCode: context.deviceCode,
        doorNum: context.doorNum,
        reservationId: context.reservationId ?? null,
        intentItems,
        preSettlement
      })
    );
  }

  private hash(value: string) {
    return createHash("sha256").update(value).digest("hex");
  }
}
