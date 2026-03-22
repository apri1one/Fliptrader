import * as log from "../utils/logger.js";

const TAG = "Risk";

export interface RiskCheckInput {
  coin: string;
  orderNotional: number;
  currentCoinNotional: number;
  perCoinCap: number;
  currentTotalNotional: number;
}

export interface RiskCheckResult {
  allowed: boolean;
  adjustedNotional: number;
  reason?: string;
}

export class RiskManager {
  private totalCap: number;

  constructor(totalPositionCap: number) {
    this.totalCap = totalPositionCap;
  }

  check(input: RiskCheckInput): RiskCheckResult {
    // H2: NaN 校验 — NaN 绕过所有比较运算
    if (
      isNaN(input.orderNotional) ||
      isNaN(input.currentCoinNotional) ||
      isNaN(input.currentTotalNotional) ||
      isNaN(input.perCoinCap)
    ) {
      log.warn(TAG, `rejected: NaN detected in risk input`, input);
      return { allowed: false, adjustedNotional: 0, reason: "invalid input (NaN)" };
    }

    const coinRemaining = input.perCoinCap - input.currentCoinNotional;
    const totalRemaining = this.totalCap - input.currentTotalNotional;

    if (coinRemaining <= 0) {
      log.warn(TAG, `${input.coin} per-coin cap reached (${input.currentCoinNotional}/${input.perCoinCap})`);
      return { allowed: false, adjustedNotional: 0, reason: "per-coin cap reached" };
    }

    if (totalRemaining <= 0) {
      log.warn(TAG, `total cap reached (${input.currentTotalNotional}/${this.totalCap})`);
      return { allowed: false, adjustedNotional: 0, reason: "total cap reached" };
    }

    let adjusted = input.orderNotional;

    if (input.currentCoinNotional + adjusted > input.perCoinCap) {
      adjusted = coinRemaining;
      log.info(TAG, `${input.coin} truncated to per-coin cap: ${adjusted}`);
    }

    if (input.currentTotalNotional + adjusted > this.totalCap) {
      adjusted = totalRemaining;
      log.info(TAG, `${input.coin} truncated to total cap: ${adjusted}`);
    }

    return { allowed: true, adjustedNotional: adjusted };
  }
}
