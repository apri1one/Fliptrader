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
  myLeverage?: number,
  targetLeverage?: number,
): number {
  switch (mode) {
    case "fixedRatio":
      return fillSize * value;
    case "equalSize":
      return fillSize;
    case "fixedAmount":
      return value / price;
    case "leverageRatio": {
      // 匹配保证金用量: orderSize = fillSize × sizeValue × myLeverage / targetLeverage
      const ml = myLeverage ?? 1;
      const tl = targetLeverage ?? ml; // 无目标杠杆数据时退化为 equalSize × sizeValue
      return fillSize * value * ml / tl;
    }
  }
}

export class OrderManager {
  private adapters: Map<ExchangeId, ExchangeAdapter>;
  private targetMap: Map<string, TargetConfig>;
  private tracker: PositionTracker;
  private risk: RiskManager;
  private chase: ChaseExecutor;
  private onOrderResult?: (target: string, coin: string, result: OrderResult, side: "buy" | "sell", isOpen: boolean) => void;

  // H4: margin 模式缓存，避免每次 fill 都调用
  private marginCache = new Set<string>();

  // C4: 串行化 fill 处理，防止并发突破风控（per-target 粒度）
  private fillMutexes = new Map<string, Promise<void>>();

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

  // C4: 用 per-target mutex 串行化 fill 处理
  async handleFill(event: FillEvent): Promise<void> {
    let releaseFn!: () => void;
    const release = new Promise<void>((r) => { releaseFn = r; });
    const prev = this.fillMutexes.get(event.targetName) ?? Promise.resolve();
    this.fillMutexes.set(event.targetName, release);

    await prev;
    try {
      await this._handleFill(event);
    } finally {
      releaseFn();
    }
  }

  private async _handleFill(event: FillEvent): Promise<void> {
    const config = this.targetMap.get(event.targetName);
    if (!config) return;

    const fill = event.fill;
    const price = parseFloat(fill.px);
    const fillSize = parseFloat(fill.sz);

    // H2: NaN / 非法值校验
    if (isNaN(price) || isNaN(fillSize) || price <= 0 || fillSize <= 0) {
      log.error(TAG, `invalid fill data: px=${fill.px}, sz=${fill.sz}, skipping`);
      return;
    }

    // Update target position mirror
    this.tracker.applyFill(event.targetName, fill.coin, fill.side, fillSize, price);

    // Calculate reverse direction
    const reverseSide: "buy" | "sell" = fill.side === "B" ? "sell" : "buy";
    const isOpen = event.isOpen;

    // Calculate order size
    const targetLeverage = this.tracker.getLeverage(event.targetName, fill.coin) ?? undefined;
    let orderSize = calcOrderSize(config.sizeMode, config.sizeValue, fillSize, price, config.leverage, targetLeverage);
    const orderNotional = orderSize * price;

    // H2: 下单量 NaN 校验
    if (isNaN(orderSize) || orderSize <= 0) {
      log.error(TAG, `invalid order size: ${orderSize}, skipping`);
      return;
    }

    const adapter = this.adapters.get(config.exchange);
    if (!adapter) {
      log.error(TAG, `no adapter for ${config.exchange}`);
      return;
    }

    const myKey = `my-${event.targetName}`;

    // Risk check for opening positions
    if (isOpen) {
      const currentCoinNotional = this.tracker.getCoinNotional(myKey, fill.coin);
      const currentTotalNotional = this.tracker.getGlobalNotional("my-");

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
    } else {
      // H3: 平仓安全检查 — 确保我方确实有仓位可平，防止平仓信号变成反向开仓
      const myPos = this.tracker.getPosition(myKey, fill.coin);
      if (!myPos) {
        log.warn(TAG, `close signal for ${fill.coin} but no position to close, skipping`);
        return;
      }
      // 限制平仓量不超过实际持仓
      if (orderSize > myPos.size) {
        log.info(TAG, `close size ${orderSize} > position ${myPos.size}, capping to position size`);
        orderSize = myPos.size;
      }
    }

    const symbol = mapCoin(fill.coin, config.exchange);

    try {
      // H4: 缓存 margin 设置，避免每次 fill 都调用交易所 API
      const marginKey = `${config.exchange}:${symbol}:${config.leverage}`;
      if (!this.marginCache.has(marginKey)) {
        await adapter.ensureIsolatedMargin(symbol, config.leverage);
        this.marginCache.add(marginKey);
      }

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

      // Update my position tracker (only if actually filled)
      if (result.filledSize > 0) {
        const mySide: "B" | "A" = reverseSide === "buy" ? "B" : "A";
        this.tracker.applyFill(myKey, fill.coin, mySide, result.filledSize, result.avgPrice || price);
      }

      log.info(TAG, `${event.targetName} → reverse ${reverseSide} ${result.filledSize} ${fill.coin} on ${config.exchange} (status: ${result.status})`);

      this.onOrderResult?.(event.targetName, fill.coin, result, reverseSide, isOpen);
    } catch (e: any) {
      log.error(TAG, `order failed for ${fill.coin}: ${e.message}`);
      throw e; // 重新抛出让上层 catch 触发 Telegram 通知
    }
  }
}
