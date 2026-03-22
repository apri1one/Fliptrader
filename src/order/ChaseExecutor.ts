import type { ExchangeAdapter, OrderResult } from "../exchange/types.js";
import * as log from "../utils/logger.js";

const TAG = "Chase";

export class ChaseExecutor {
  private intervalMs: number;

  constructor(intervalMs: number = 1000) {
    this.intervalMs = intervalMs;
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

    log.info(TAG, `start chase ${side} ${totalSize} ${symbol} on ${adapter.name}`);

    while (totalSize - filled > 1e-8) {
      const remaining = totalSize - filled;

      // Cancel previous order if exists
      if (currentOrderId) {
        try {
          // Check how much was filled before canceling
          const status = await adapter.getOrderStatus(symbol, currentOrderId);
          if (status.filled > 0) {
            const book = await adapter.getBookTop(symbol);
            const estPrice = side === "buy" ? book.bid : book.ask;
            filled += status.filled;
            totalCost += status.filled * estPrice;
            log.info(TAG, `partial fill: ${status.filled}, total ${filled}/${totalSize}`);
          }
          if (status.status === "closed") {
            // Fully filled
            break;
          }
          await adapter.cancelOrder(symbol, currentOrderId);
        } catch {
          // Order may already be filled or canceled
        }
        currentOrderId = null;
      }

      // Recalculate remaining after fills
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

      // Wait interval
      await sleep(this.intervalMs);
    }

    // Final check on last order
    if (currentOrderId) {
      try {
        const status = await adapter.getOrderStatus(symbol, currentOrderId);
        if (status.filled > 0) {
          const book = await adapter.getBookTop(symbol);
          const estPrice = side === "buy" ? book.bid : book.ask;
          filled += status.filled;
          totalCost += status.filled * estPrice;
        }
        if (status.remaining > 0) {
          await adapter.cancelOrder(symbol, currentOrderId);
        }
      } catch {
        // ignore
      }
    }

    const avgPrice = filled > 0 ? totalCost / filled : 0;
    log.info(TAG, `chase complete: ${filled} ${symbol} @ avg ${avgPrice.toFixed(2)}`);

    return {
      orderId: currentOrderId ?? "unknown",
      filledSize: filled,
      avgPrice,
      status: filled >= totalSize - 1e-8 ? "filled" : "partial",
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
