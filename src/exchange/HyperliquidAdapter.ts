import ccxt, { type hyperliquid } from "ccxt";
import type { ExchangeAdapter, BookTop } from "./types.js";
import * as log from "../utils/logger.js";

const TAG = "HL-Adapter";

export class HyperliquidAdapter implements ExchangeAdapter {
  name = "hyperliquid";
  private client: hyperliquid;

  constructor(privateKey: string) {
    this.client = new ccxt.hyperliquid({
      privateKey,
      walletAddress: undefined,
    });
  }

  async ensureIsolatedMargin(
    symbol: string,
    leverage: number,
  ): Promise<void> {
    await this.client.setMarginMode("isolated", symbol);
    await this.client.setLeverage(leverage, symbol);
    log.info(TAG, `set ${symbol} isolated ${leverage}x`);
  }

  async getBookTop(symbol: string): Promise<BookTop> {
    const ob = await this.client.fetchOrderBook(symbol, 1);
    const bid = ob.bids?.[0]?.[0];
    const ask = ob.asks?.[0]?.[0];
    if (bid === undefined || ask === undefined) {
      throw new Error(`empty order book for ${symbol}`);
    }
    return { bid, ask };
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
        postOnly: true,
        reduceOnly,
      },
    );
    log.info(
      TAG,
      `post-only ${side} ${size} ${symbol} @ ${price} -> ${order.id}`,
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
