import WebSocket from "ws";
import type { TargetConfig } from "../config.js";
import type { HlFill, FillEvent, FillHandler } from "./types.js";
import * as log from "../utils/logger.js";

const TAG = "Monitor";
const HL_WS_URL = "wss://api.hyperliquid.xyz/ws";
const HL_WS_URL_TESTNET = "wss://api.hyperliquid-testnet.xyz/ws";
const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const HL_INFO_URL_TESTNET = "https://api.hyperliquid-testnet.xyz/info";

// H5: 初始仓位回调类型
export type InitialPositionHandler = (
  targetName: string,
  positions: Array<{
    coin: string;
    szi: number;
    entryPx: number;
    leverage: number;
  }>,
) => void;

export class HyperliquidMonitor {
  private wsList: Map<string, WebSocket> = new Map();
  private handlers: FillHandler[] = [];
  private targets: TargetConfig[];
  private reconnectDelayMs = 3000;
  private stopped = false;
  private onInitialPositions?: InitialPositionHandler;
  private processedFills = new Set<string>();
  private readonly MAX_PROCESSED_FILLS = 10_000;
  private wsUrl: string;
  private infoUrl: string;

  constructor(targets: TargetConfig[], testnet: boolean = false) {
    this.targets = targets.filter((t) => t.enabled);
    this.wsUrl = testnet ? HL_WS_URL_TESTNET : HL_WS_URL;
    this.infoUrl = testnet ? HL_INFO_URL_TESTNET : HL_INFO_URL;
  }

  onFill(handler: FillHandler): void {
    this.handlers.push(handler);
  }

  // H5: 设置初始仓位回调
  setInitialPositionHandler(handler: InitialPositionHandler): void {
    this.onInitialPositions = handler;
  }

  async start(): Promise<void> {
    for (const target of this.targets) {
      await this.fetchInitialPositions(target);
    }
    for (const target of this.targets) {
      this.connectTarget(target);
    }
    log.info(TAG, `started monitoring ${this.targets.length} targets`);
  }

  stop(): void {
    this.stopped = true;
    for (const [name, ws] of this.wsList) {
      ws.close();
      log.info(TAG, `closed WS for ${name}`);
    }
    this.wsList.clear();
  }

  // H5: REST 拉取初始仓位并通知 tracker
  async fetchInitialPositions(target: TargetConfig): Promise<void> {
    try {
      const response = await fetch(this.infoUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "clearinghouseState",
          user: target.address,
        }),
      });
      const data = (await response.json()) as {
        assetPositions?: Array<{
          position: { coin: string; szi: string; entryPx: string; leverage: { value: number } };
        }>;
      };

      const positions = (data.assetPositions ?? [])
        .filter((ap) => parseFloat(ap.position.szi) !== 0)
        .map((ap) => ({
          coin: ap.position.coin,
          szi: parseFloat(ap.position.szi),
          entryPx: parseFloat(ap.position.entryPx),
          leverage: ap.position.leverage.value,
        }));

      log.info(TAG, `fetched ${positions.length} initial positions for ${target.name}`);

      // 通知 tracker
      if (positions.length > 0 && this.onInitialPositions) {
        this.onInitialPositions(target.name, positions);
      }
    } catch (e: any) {
      log.error(TAG, `failed to fetch initial positions for ${target.name}: ${e.message}`);
    }
  }

  private connectTarget(target: TargetConfig): void {
    const ws = new WebSocket(this.wsUrl);

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
      this.wsList.delete(target.name);
      if (this.stopped) {
        log.info(TAG, `WS closed for ${target.name} (stopped)`);
        return;
      }
      log.warn(TAG, `disconnected for ${target.name}, reconnecting...`);
      setTimeout(() => this.connectTarget(target), this.reconnectDelayMs);
    });

    ws.on("error", (err) => {
      log.error(TAG, `WS error for ${target.name}`, err.message);
    });

    this.wsList.set(target.name, ws);
  }

  // H6: WS fill 数据校验
  private isValidFill(fill: unknown): fill is HlFill {
    if (typeof fill !== "object" || fill === null) return false;
    const f = fill as Record<string, unknown>;
    if (typeof f.coin !== "string" || !f.coin) return false;
    if (typeof f.px !== "string" || typeof f.sz !== "string") return false;
    if (f.side !== "B" && f.side !== "A") return false;
    if (typeof f.closedPnl !== "string") return false;
    if (typeof f.dir !== "string") return false;

    const px = parseFloat(f.px as string);
    const sz = parseFloat(f.sz as string);
    if (isNaN(px) || isNaN(sz) || px <= 0 || sz <= 0) return false;

    return true;
  }

  private handleFills(
    target: TargetConfig,
    data: { isSnapshot?: boolean; user: string; fills: unknown[] },
  ): void {
    if (data.isSnapshot) {
      log.debug(TAG, `snapshot for ${target.name}, ${data.fills.length} historical fills (skipped)`);
      return;
    }

    if (data.user !== target.address) {
      log.warn(TAG, `user mismatch for ${target.name}: expected ${target.address}, got ${data.user}`);
      return;
    }

    for (const rawFill of data.fills) {
      // H6: 校验 fill 数据完整性
      if (!this.isValidFill(rawFill)) {
        log.warn(TAG, `invalid fill data for ${target.name}, skipping`, rawFill);
        continue;
      }

      const fill = rawFill;

      if (this.processedFills.has(fill.hash)) {
        log.debug(TAG, `duplicate fill ${fill.hash} for ${target.name}, skipping`);
        continue;
      }
      this.processedFills.add(fill.hash);
      // 防止内存膨胀
      if (this.processedFills.size > this.MAX_PROCESSED_FILLS) {
        const first = this.processedFills.values().next().value;
        this.processedFills.delete(first!);
      }

      // C3: 使用 dir 字段判断开/平仓，而非 closedPnl 字符串比较
      const isOpen = fill.dir.startsWith("Open");

      const event: FillEvent = {
        targetName: target.name,
        targetAddress: target.address,
        fill,
        isOpen,
      };
      log.info(
        TAG,
        `${target.name} ${fill.side === "B" ? "BUY" : "SELL"} ${fill.sz} ${fill.coin} @ ${fill.px} | ${isOpen ? "OPEN" : "CLOSE"} (dir=${fill.dir})`,
      );
      for (const handler of this.handlers) {
        handler(event);
      }
    }
  }
}
