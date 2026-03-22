import ccxt, { binanceusdm } from "ccxt";
import type { ExchangeAdapter, BookTop, OrderStatus } from "./types.js";
import * as log from "../utils/logger.js";

const TAG = "Binance-Adapter";

export class BinanceAdapter implements ExchangeAdapter {
  name = "binance";
  private client: binanceusdm;

  constructor(apiKey: string, apiSecret: string, testnet: boolean = false) {
    this.client = new ccxt.binanceusdm({
      apiKey,
      secret: apiSecret,
      sandbox: testnet,
    });
  }

  async ensureIsolatedMargin(symbol: string, leverage: number): Promise<void> {
    try {
      await this.client.setMarginMode("isolated", symbol);
    } catch (e: any) {
      if (!e.message?.includes("No need to change")) throw e;
    }
    await this.client.setLeverage(leverage, symbol);
    log.info(TAG, `set ${symbol} isolated ${leverage}x`);
  }

  async getBookTop(symbol: string): Promise<BookTop> {
    const ob = await this.client.fetchOrderBook(symbol, 5);
    const bid = ob.bids[0]?.[0];
    const ask = ob.asks[0]?.[0];
    if (bid == null || ask == null) {
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
        timeInForce: "GTX",
        reduceOnly,
      },
    );
    log.info(TAG, `post-only ${side} ${size} ${symbol} @ ${price} -> ${order.id}`);
    return order.id;
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    await this.client.cancelOrder(orderId, symbol);
  }

  async getOrderStatus(symbol: string, orderId: string): Promise<OrderStatus> {
    const order = await this.client.fetchOrder(orderId, symbol);
    return {
      filled: order.filled ?? 0,
      remaining: order.remaining ?? 0,
      status: order.status ?? "unknown",
      avgPrice: order.average ?? undefined,
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

  async fetchAllPositions(): Promise<
    Array<{ symbol: string; size: number; side: "long" | "short" }>
  > {
    const positions = await this.client.fetchPositions();
    return positions
      .filter((p) => p.contracts !== 0)
      .map((p) => ({
        symbol: p.symbol,
        size: Math.abs(p.contracts ?? 0),
        side: (p.side as "long" | "short") ?? "long",
      }));
  }
}
