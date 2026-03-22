import ccxt, { type Position } from "ccxt";
import type {
  ExchangeAdapter,
  BookTop,
  OrderParams,
  OrderResult,
  OrderStatus,
} from "./types.js";
import * as log from "../utils/logger.js";

type OKXClient = InstanceType<(typeof ccxt)["okx"]>;

const TAG = "OKX-Adapter";
const ALGO_POLL_INTERVAL_MS = 2000;
const ALGO_POLL_TIMEOUT_MS = 120_000; // 2 minutes

export class OKXAdapter implements ExchangeAdapter {
  name = "okx";
  private client: OKXClient;

  constructor(apiKey: string, apiSecret: string, passphrase: string, testnet: boolean = false) {
    this.client = new ccxt.okx({
      apiKey,
      secret: apiSecret,
      password: passphrase,
      sandbox: testnet,
    });
  }

  async ensureIsolatedMargin(symbol: string, leverage: number): Promise<void> {
    try {
      // 先尝试设置单向持仓模式
      await this.client.setPositionMode(false, symbol);
    } catch {
      // 可能已经是单向模式
    }
    await this.client.setMarginMode("isolated", symbol, { lever: String(leverage) });
    await this.client.setLeverage(leverage, symbol, { mgnMode: "isolated" });
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
    const params: Record<string, unknown> = { tdMode: "isolated", posSide: "net" };
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

  async getOrderStatus(symbol: string, orderId: string): Promise<OrderStatus> {
    const order = await this.client.fetchOrder(orderId, symbol);
    return {
      filled: order.filled ?? 0,
      remaining: order.remaining ?? 0,
      status: order.status ?? "unknown",
      avgPrice: order.average ?? undefined,
    };
  }

  // C1+C2: OKX 原生 chase 限价单，带轮询等待实际成交 + reduceOnly 透传
  async placeChaseLimitOrder(params: OrderParams): Promise<OrderResult> {
    const instId = params.symbol.split("/")[0] + "-USDT-SWAP";

    const reqBody: Record<string, string> = {
      instId,
      tdMode: "isolated",
      side: params.side,
      ordType: "chase",
      sz: String(params.size),
    };

    // C2: 透传 reduceOnly
    if (params.reduceOnly) {
      reqBody.reduceOnly = "true";
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamically generated private endpoint
    const response = (await (this.client as any).privatePostTradeOrderAlgo(
      reqBody,
    )) as { data?: Array<{ algoId?: string }> };

    const algoId = response.data?.[0]?.algoId ?? "unknown";
    log.info(
      TAG,
      `chase order ${params.side} ${params.size} ${params.symbol} → algoId: ${algoId}`,
    );

    if (algoId === "unknown") {
      return { orderId: "unknown", filledSize: 0, avgPrice: 0, status: "failed" };
    }

    // C1: 轮询等待 algo order 实际成交
    return await this.pollAlgoOrder(algoId, instId);
  }

  private async pollAlgoOrder(algoId: string, instId: string): Promise<OrderResult> {
    const startTime = Date.now();

    while (Date.now() - startTime < ALGO_POLL_TIMEOUT_MS) {
      await sleep(ALGO_POLL_INTERVAL_MS);

      try {
        // 先查 pending
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pending = (await (this.client as any).privateGetTradeOrdersAlgoPending({
          ordType: "chase",
          algoId,
        })) as { data?: Array<Record<string, string>> };

        const pendingOrder = pending?.data?.[0];
        if (pendingOrder) {
          // 还在执行中，继续等
          const filledSoFar = parseFloat(pendingOrder.actualSz || "0");
          if (filledSoFar > 0) {
            log.debug(TAG, `algo ${algoId} still running, filled so far: ${filledSoFar}`);
          }
          continue;
        }

        // 不在 pending 中，查 history
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const history = (await (this.client as any).privateGetTradeOrdersAlgoHistory({
          ordType: "chase",
          algoId,
        })) as { data?: Array<Record<string, string>> };

        const historyOrder = history?.data?.[0];
        if (historyOrder) {
          const filledSize = parseFloat(historyOrder.actualSz || "0");
          const avgPrice = parseFloat(historyOrder.actualPx || "0");
          const state = historyOrder.state; // "effective", "canceled", "order_failed"

          log.info(TAG, `algo ${algoId} completed: state=${state}, filled=${filledSize}, avgPx=${avgPrice}`);

          return {
            orderId: algoId,
            filledSize,
            avgPrice,
            status: filledSize > 0 ? (state === "effective" ? "filled" : "partial") : "failed",
          };
        }
      } catch (e: any) {
        log.warn(TAG, `poll algo ${algoId} error: ${e.message}`);
      }
    }

    // 超时，尝试取消并检查已成交量
    log.warn(TAG, `algo ${algoId} poll timeout, attempting cancel`);
    try {
      await (this.client as any).privatePostTradeCancelAlgos(
        [{ algoId, instId }],
      );
    } catch (e: any) {
      log.warn(TAG, `cancel algo ${algoId} failed: ${e.message}`);
    }

    // 超时后查一次成交量
    try {
      const history = (await (this.client as any).privateGetTradeOrdersAlgoHistory({
        ordType: "chase",
        algoId,
      })) as { data?: Array<Record<string, string>> };
      const historyOrder = history?.data?.[0];
      if (historyOrder) {
        const filledSize = parseFloat(historyOrder.actualSz || "0");
        const avgPrice = parseFloat(historyOrder.actualPx || "0");
        if (filledSize > 0) {
          log.info(TAG, `algo ${algoId} had partial fill after timeout: ${filledSize}`);
          return { orderId: algoId, filledSize, avgPrice, status: "partial" as const };
        }
      }
    } catch {}

    return { orderId: algoId, filledSize: 0, avgPrice: 0, status: "failed" as const };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
