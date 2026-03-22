import ccxt from "ccxt";
import type { ExchangeAdapter, BookTop } from "./types.js";
import * as log from "../utils/logger.js";

const TAG = "Bybit-Adapter";

export class BybitAdapter implements ExchangeAdapter {
  name = "bybit";
  private client: ccxt.bybit;

  constructor(apiKey: string, apiSecret: string) {
    this.client = new ccxt.bybit({
      apiKey,
      secret: apiSecret,
    });
  }

  async ensureIsolatedMargin(symbol: string, leverage: number): Promise<void> {
    try {
      await this.client.setMarginMode("isolated", symbol);
    } catch (e: any) {
      if (!e.message?.includes("not modified")) throw e;
    }
    await this.client.setLeverage(leverage, symbol);
    log.info(TAG, `set ${symbol} isolated ${leverage}x`);
  }

  async getBookTop(symbol: string): Promise<BookTop> {
    const ob = await this.client.fetchOrderBook(symbol, 1);
    return { bid: ob.bids[0][0], ask: ob.asks[0][0] };
  }

  async placePostOnly(
    symbol: string,
    side: "buy" | "sell",
    size: number,
    price: number,
    reduceOnly: boolean,
  ): Promise<string> {
    const order = await this.client.createOrder(
      symbol,
      "limit",
      side,
      size,
      price,
      {
        timeInForce: "PostOnly",
        reduceOnly,
      },
    );
    log.info(
      TAG,
      `post-only ${side} ${size} ${symbol} @ ${price} → ${order.id}`,
    );
    return order.id;
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    await this.client.cancelOrder(orderId, symbol);
  }

  async getOrderStatus(
    symbol: string,
    orderId: string,
  ): Promise<{ filled: number; remaining: number; status: string }> {
    const order = await this.client.fetchOrder(orderId, symbol);
    return {
      filled: order.filled ?? 0,
      remaining: order.remaining ?? 0,
      status: order.status ?? "unknown",
    };
  }

  async getPosition(
    symbol: string,
  ): Promise<{ size: number; side: "long" | "short" | "none" }> {
    const positions = await this.client.fetchPositions([symbol]);
    const pos = positions.find((p) => p.symbol === symbol);
    if (!pos || pos.contracts === 0) return { size: 0, side: "none" };
    return {
      size: Math.abs(pos.contracts ?? 0),
      side: (pos.side as "long" | "short") ?? "none",
    };
  }
}
