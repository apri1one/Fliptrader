import type { ExchangeAdapter, OrderResult } from "../exchange/types.js";
import * as log from "../utils/logger.js";

const TAG = "Chase";

const DEFAULT_MAX_ITERATIONS = 120;
const DEFAULT_TIMEOUT_MS = 120_000; // 2 minutes

export class ChaseExecutor {
  private intervalMs: number;
  private maxIterations: number;
  private timeoutMs: number;

  constructor(
    intervalMs: number = 1000,
    maxIterations: number = DEFAULT_MAX_ITERATIONS,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ) {
    this.intervalMs = intervalMs;
    this.maxIterations = maxIterations;
    this.timeoutMs = timeoutMs;
  }

  async execute(
    adapter: ExchangeAdapter,
    symbol: string,
    side: "buy" | "sell",
    totalSize: number,
    reduceOnly: boolean,
  ): Promise<OrderResult> {
    let filled = 0;
    let totalCost = 0;
    let currentOrderId: string | null = null;
    let iterations = 0;
    const startTime = Date.now();

    log.info(TAG, `start chase ${side} ${totalSize} ${symbol} on ${adapter.name}`);

    while (totalSize - filled > 1e-8) {
      // S-C2: 超时保护
      if (iterations >= this.maxIterations) {
        log.warn(TAG, `max iterations (${this.maxIterations}) reached, stopping chase`);
        break;
      }
      if (Date.now() - startTime > this.timeoutMs) {
        log.warn(TAG, `timeout (${this.timeoutMs}ms) reached, stopping chase`);
        break;
      }
      iterations++;

      // Cancel previous order if exists
      if (currentOrderId) {
        try {
          const status = await adapter.getOrderStatus(symbol, currentOrderId);
          if (status.filled > 0) {
            // H1: 使用实际成交价，而非盘口估算价
            const fillPrice = status.avgPrice ?? (side === "buy" ? (await adapter.getBookTop(symbol)).bid : (await adapter.getBookTop(symbol)).ask);
            filled += status.filled;
            totalCost += status.filled * fillPrice;
            log.info(TAG, `partial fill: ${status.filled} @ ${fillPrice}, total ${filled}/${totalSize}`);
          }
          if (status.status === "closed") {
            currentOrderId = null;
            break;
          }
          await adapter.cancelOrder(symbol, currentOrderId);
        } catch {
          // Order may already be filled or canceled
        }
        currentOrderId = null;
      }

      const nowRemaining = totalSize - filled;
      if (nowRemaining <= 1e-8) break;

      // Get current book top
      const book = await adapter.getBookTop(symbol);
      const price = side === "buy" ? book.bid : book.ask;

      // Place post-only order
      try {
        currentOrderId = await adapter.placePostOnly(symbol, side, nowRemaining, price, reduceOnly);
      } catch (e: any) {
        log.error(TAG, `place failed: ${e.message}`);
        currentOrderId = null;
      }

      await sleep(this.intervalMs);
    }

    // Final check on last order
    if (currentOrderId) {
      try {
        const status = await adapter.getOrderStatus(symbol, currentOrderId);
        if (status.filled > 0) {
          const fillPrice = status.avgPrice ?? 0;
          filled += status.filled;
          totalCost += status.filled * (fillPrice > 0 ? fillPrice : totalCost / filled || 0);
        }
        if (status.remaining > 0) {
          await adapter.cancelOrder(symbol, currentOrderId);
        }
      } catch {
        // ignore
      }
    }

    const avgPrice = filled > 0 ? totalCost / filled : 0;
    log.info(TAG, `chase complete: ${filled} ${symbol} @ avg ${avgPrice.toFixed(2)} (${iterations} iterations)`);

    return {
      orderId: currentOrderId ?? "unknown",
      filledSize: filled,
      avgPrice,
      status: filled >= totalSize - 1e-8 ? "filled" : filled > 0 ? "partial" : "failed",
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
