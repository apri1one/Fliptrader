import WebSocket from "ws";
import type { TargetConfig } from "../config.js";
import type { HlFill, FillEvent, FillHandler } from "./types.js";
import * as log from "../utils/logger.js";

const TAG = "Monitor";
const HL_WS_URL = "wss://api.hyperliquid.xyz/ws";
const HL_INFO_URL = "https://api.hyperliquid.xyz/info";

export class HyperliquidMonitor {
  private wsList: Map<string, WebSocket> = new Map();
  private handlers: FillHandler[] = [];
  private targets: TargetConfig[];
  private reconnectDelayMs = 3000;

  constructor(targets: TargetConfig[]) {
    this.targets = targets.filter((t) => t.enabled);
  }

  onFill(handler: FillHandler): void {
    this.handlers.push(handler);
  }

  async start(): Promise<void> {
    // 启动时先 REST 拉取每个目标的当前仓位
    for (const target of this.targets) {
      await this.fetchInitialPositions(target);
    }
    // 然后建立 WS 连接
    for (const target of this.targets) {
      this.connectTarget(target);
    }
    log.info(TAG, `started monitoring ${this.targets.length} targets`);
  }

  stop(): void {
    for (const [name, ws] of this.wsList) {
      ws.close();
      log.info(TAG, `closed WS for ${name}`);
    }
    this.wsList.clear();
  }

  // REST 拉取目标地址当前仓位（初始化用）
  async fetchInitialPositions(target: TargetConfig): Promise<any> {
    try {
      const response = await fetch(HL_INFO_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "clearinghouseState",
          user: target.address,
        }),
      });
      const data = await response.json();
      log.info(TAG, `fetched initial positions for ${target.name}`, {
        positions: data.assetPositions?.length ?? 0,
      });
      return data;
    } catch (e: any) {
      log.error(TAG, `failed to fetch initial positions for ${target.name}: ${e.message}`);
      return null;
    }
  }

  private connectTarget(target: TargetConfig): void {
    const ws = new WebSocket(HL_WS_URL);

    ws.on("open", () => {
      log.info(TAG, `connected for ${target.name} (${target.address})`);
      const subMsg = JSON.stringify({
        method: "subscribe",
        subscription: {
          type: "userFills",
          user: target.address,
        },
      });
      ws.send(subMsg);
    });

    ws.on("message", (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.channel === "userFills") {
          this.handleFills(target, msg.data);
        }
      } catch (e) {
        log.error(TAG, `parse error for ${target.name}`, e);
      }
    });

    ws.on("close", () => {
      log.warn(TAG, `disconnected for ${target.name}, reconnecting...`);
      this.wsList.delete(target.name);
      setTimeout(() => this.connectTarget(target), this.reconnectDelayMs);
    });

    ws.on("error", (err) => {
      log.error(TAG, `WS error for ${target.name}`, err.message);
    });

    this.wsList.set(target.name, ws);
  }

  private handleFills(target: TargetConfig, data: { isSnapshot?: boolean; user: string; fills: HlFill[] }): void {
    if (data.isSnapshot) {
      log.debug(TAG, `snapshot for ${target.name}, ${data.fills.length} historical fills (skipped)`);
      return;
    }

    for (const fill of data.fills) {
      const isOpen = fill.closedPnl === "0";
      const event: FillEvent = {
        targetName: target.name,
        targetAddress: target.address,
        fill,
        isOpen,
      };
      log.info(TAG, `${target.name} ${fill.side === "B" ? "BUY" : "SELL"} ${fill.sz} ${fill.coin} @ ${fill.px} | ${isOpen ? "OPEN" : "CLOSE"}`);
      for (const handler of this.handlers) {
        handler(event);
      }
    }
  }
}
