import type { TargetConfig, ExchangeId, SizeMode } from "../config.js";
import type { ExchangeAdapter, OrderResult } from "../exchange/types.js";
import type { FillEvent } from "../monitor/types.js";
import { PositionTracker } from "../tracker/PositionTracker.js";
import { RiskManager } from "../risk/RiskManager.js";
import { ChaseExecutor } from "./ChaseExecutor.js";
import { mapCoin } from "../utils/coinMapping.js";
import * as log from "../utils/logger.js";

const TAG = "OrderMgr";

export function calcOrderSize(
  mode: SizeMode,
  value: number,
  fillSize: number,
  price: number,
): number {
  switch (mode) {
    case "fixedRatio":
      return fillSize * value;
    case "equalSize":
      return fillSize;
    case "fixedAmount":
      return value / price;
  }
}

export class OrderManager {
  private adapters: Map<ExchangeId, ExchangeAdapter>;
  private targetMap: Map<string, TargetConfig>;
  private tracker: PositionTracker;
  private risk: RiskManager;
  private chase: ChaseExecutor;
  private onOrderResult?: (target: string, coin: string, result: OrderResult, side: "buy" | "sell", isOpen: boolean) => void;

  constructor(
    adapters: Map<ExchangeId, ExchangeAdapter>,
    targets: TargetConfig[],
    tracker: PositionTracker,
    risk: RiskManager,
    checkIntervalMs: number,
  ) {
    this.adapters = adapters;
    this.targetMap = new Map(targets.map((t) => [t.name, t]));
    this.tracker = tracker;
    this.risk = risk;
    this.chase = new ChaseExecutor(checkIntervalMs);
  }

  setOrderResultHandler(handler: (target: string, coin: string, result: OrderResult, side: "buy" | "sell", isOpen: boolean) => void): void {
    this.onOrderResult = handler;
  }

  async handleFill(event: FillEvent): Promise<void> {
    const config = this.targetMap.get(event.targetName);
    if (!config) return;

    const fill = event.fill;
    const price = parseFloat(fill.px);
    const fillSize = parseFloat(fill.sz);

    // Update target position mirror
    this.tracker.applyFill(event.targetName, fill.coin, fill.side, fillSize, price);

    // Calculate reverse direction
    const reverseSide: "buy" | "sell" = fill.side === "B" ? "sell" : "buy";
    const isOpen = event.isOpen;

    // Calculate order size
    let orderSize = calcOrderSize(config.sizeMode, config.sizeValue, fillSize, price);
    const orderNotional = orderSize * price;

    const adapter = this.adapters.get(config.exchange);
    if (!adapter) {
      log.error(TAG, `no adapter for ${config.exchange}`);
      return;
    }

    // Risk check (only for opening positions, not for closing)
    if (isOpen) {
      const myKey = `my-${config.exchange}`;
      const currentCoinNotional = this.tracker.getCoinNotional(myKey, fill.coin);
      const currentTotalNotional = this.tracker.getTotalNotional(myKey);

      const riskResult = this.risk.check({
        coin: fill.coin,
        orderNotional,
        currentCoinNotional,
        perCoinCap: config.perCoinCap,
        currentTotalNotional,
      });

      if (!riskResult.allowed) {
        log.warn(TAG, `order rejected by risk: ${riskResult.reason}`);
        return;
      }

      if (riskResult.adjustedNotional < orderNotional) {
        orderSize = riskResult.adjustedNotional / price;
        log.info(TAG, `order size adjusted to ${orderSize}`);
      }
    }

    const symbol = mapCoin(fill.coin, config.exchange);

    try {
      await adapter.ensureIsolatedMargin(symbol, config.leverage);

      let result: OrderResult;

      if (config.exchange === "okx" && adapter.placeChaseLimitOrder) {
        result = await adapter.placeChaseLimitOrder({
          symbol,
          side: reverseSide,
          size: orderSize,
          leverage: config.leverage,
          reduceOnly: !isOpen,
        });
      } else {
        result = await this.chase.execute(adapter, symbol, reverseSide, orderSize, !isOpen);
      }

      // Update my position tracker
      const myKey = `my-${config.exchange}`;
      const mySide: "B" | "A" = reverseSide === "buy" ? "B" : "A";
      this.tracker.applyFill(myKey, fill.coin, mySide, result.filledSize, result.avgPrice || price);

      log.info(TAG, `${event.targetName} → reverse ${reverseSide} ${result.filledSize} ${fill.coin} on ${config.exchange}`);

      this.onOrderResult?.(event.targetName, fill.coin, result, reverseSide, isOpen);
    } catch (e: any) {
      log.error(TAG, `order failed: ${e.message}`);
    }
  }
}
