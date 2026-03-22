import ccxt, { type Position } from "ccxt";
import type {
  ExchangeAdapter,
  BookTop,
  OrderParams,
  OrderResult,
} from "./types.js";
import * as log from "../utils/logger.js";

type OKXClient = InstanceType<(typeof ccxt)["okx"]>;

const TAG = "OKX-Adapter";

export class OKXAdapter implements ExchangeAdapter {
  name = "okx";
  private client: OKXClient;

  constructor(apiKey: string, apiSecret: string, passphrase: string) {
    this.client = new ccxt.okx({
      apiKey,
      secret: apiSecret,
      password: passphrase,
    });
  }

  async ensureIsolatedMargin(symbol: string, leverage: number): Promise<void> {
    await this.client.setMarginMode("isolated", symbol);
    await this.client.setLeverage(leverage, symbol, { mgnMode: "isolated" });
    log.info(TAG, `set ${symbol} isolated ${leverage}x`);
  }

  async getBookTop(symbol: string): Promise<BookTop> {
    const ob = await this.client.fetchOrderBook(symbol, 1);
    return { bid: Number(ob.bids[0][0]), ask: Number(ob.asks[0][0]) };
  }

  async placePostOnly(
    symbol: string,
    side: "buy" | "sell",
    size: number,
    price: number,
    reduceOnly: boolean,
  ): Promise<string> {
    const params: Record<string, unknown> = { tdMode: "isolated" };
    if (reduceOnly) params.reduceOnly = true;
    const order = await this.client.createOrder(
      symbol,
      "limit",
      side,
      size,
      price,
      { ...params, postOnly: true },
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

  // OKX 原生 chase 限价单 — POST /api/v5/trade/order-algo  ordType: "chase"
  // 服务器端自动跟踪最优买卖价挂 post-only 单
  async placeChaseLimitOrder(params: OrderParams): Promise<OrderResult> {
    const instId = params.symbol.replace("/", "-").replace(":", "-");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically generated private endpoint
    const response = (await (this.client as any).privatePostTradeOrderAlgo({
      instId,
      tdMode: "isolated",
      side: params.side,
      ordType: "chase",
      sz: String(params.size),
    })) as { data?: Array<{ algoId?: string }> };

    const algoId = response.data?.[0]?.algoId ?? "unknown";
    log.info(
      TAG,
      `chase order ${params.side} ${params.size} ${params.symbol} → algoId: ${algoId}`,
    );

    return {
      orderId: algoId,
      filledSize: 0,
      avgPrice: 0,
      status: "partial",
    };
  }

  async getPosition(
    symbol: string,
  ): Promise<{ size: number; side: "long" | "short" | "none" }> {
    const positions = await this.client.fetchPositions([symbol]);
    const pos = positions.find((p: Position) => p.symbol === symbol);
    if (!pos || pos.contracts === 0) return { size: 0, side: "none" };
    return {
      size: Math.abs(pos.contracts ?? 0),
      side: (pos.side as "long" | "short") ?? "none",
    };
  }
}
