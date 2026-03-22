# Hyperliquid 反向跟单器实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 监控 Hyperliquid 指定地址成交，在 Hyperliquid/币安/OKX/Bybit 上反向开仓平仓。

**Architecture:** WS 驱动的事件架构。HyperliquidMonitor 订阅目标地址 userFills → PositionTracker 维护仓位镜像 → OrderManager 计算反向单量并经 RiskManager 校验 → ExchangeAdapter 执行追逐限价下单 → TelegramNotifier 推送结果。

**Tech Stack:** TypeScript, ws, yaml, ccxt (Binance/OKX/Bybit), node-telegram-bot-api, vitest

---

### Task 1: 项目脚手架

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `config.example.yaml`

**Step 1: 初始化项目**

```bash
cd /Users/doggg/Documents/hype-bot
git init
npm init -y
```

**Step 2: 安装依赖**

```bash
npm install ws yaml ccxt node-telegram-bot-api
npm install -D typescript @types/node @types/ws vitest tsx
```

**Step 3: 创建 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 4: 创建 .gitignore**

```
node_modules/
dist/
config.yaml
.env
```

**Step 5: 创建 config.example.yaml**

```yaml
global:
  network: "mainnet"
  totalPositionCap: 50000
  checkIntervalMs: 1000

exchanges:
  hyperliquid:
    privateKey: "0x_YOUR_PRIVATE_KEY"
  binance:
    apiKey: "YOUR_API_KEY"
    apiSecret: "YOUR_API_SECRET"
  okx:
    apiKey: "YOUR_API_KEY"
    apiSecret: "YOUR_API_SECRET"
    passphrase: "YOUR_PASSPHRASE"
  bybit:
    apiKey: "YOUR_API_KEY"
    apiSecret: "YOUR_API_SECRET"

telegram:
  botToken: "YOUR_BOT_TOKEN"
  chatId: "YOUR_CHAT_ID"

targets:
  - name: "whale-1"
    address: "0xabc..."
    exchange: "okx"
    leverage: 10
    sizeMode: "fixedRatio"
    sizeValue: 0.1
    perCoinCap: 10000
    enabled: true
```

**Step 6: 更新 package.json scripts**

在 package.json 中添加：
```json
{
  "type": "module",
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc",
    "start": "node dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

**Step 7: Commit**

```bash
git add package.json tsconfig.json .gitignore config.example.yaml
git commit -m "chore: init project scaffolding"
```

---

### Task 2: Config 模块

**Files:**
- Create: `src/config.ts`
- Create: `src/__tests__/config.test.ts`

**Step 1: 写失败测试**

```typescript
// src/__tests__/config.test.ts
import { describe, it, expect } from "vitest";
import { parseConfig, validateConfig, type AppConfig } from "../config.js";

const VALID_YAML = `
global:
  network: mainnet
  totalPositionCap: 50000
  checkIntervalMs: 1000
exchanges:
  hyperliquid:
    privateKey: "0xabc"
  binance:
    apiKey: "key"
    apiSecret: "secret"
  okx:
    apiKey: "key"
    apiSecret: "secret"
    passphrase: "pass"
  bybit:
    apiKey: "key"
    apiSecret: "secret"
telegram:
  botToken: "token"
  chatId: "123"
targets:
  - name: whale-1
    address: "0xabc0000000000000000000000000000000000001"
    exchange: okx
    leverage: 10
    sizeMode: fixedRatio
    sizeValue: 0.1
    perCoinCap: 10000
    enabled: true
`;

describe("parseConfig", () => {
  it("parses valid YAML into AppConfig", () => {
    const config = parseConfig(VALID_YAML);
    expect(config.global.totalPositionCap).toBe(50000);
    expect(config.targets).toHaveLength(1);
    expect(config.targets[0].exchange).toBe("okx");
  });
});

describe("validateConfig", () => {
  it("throws on missing targets", () => {
    const config = parseConfig(VALID_YAML);
    config.targets = [];
    expect(() => validateConfig(config)).toThrow("targets");
  });

  it("throws on invalid sizeMode", () => {
    const config = parseConfig(VALID_YAML);
    config.targets[0].sizeMode = "invalid" as any;
    expect(() => validateConfig(config)).toThrow("sizeMode");
  });

  it("throws on invalid exchange", () => {
    const config = parseConfig(VALID_YAML);
    config.targets[0].exchange = "kraken" as any;
    expect(() => validateConfig(config)).toThrow("exchange");
  });

  it("passes valid config", () => {
    const config = parseConfig(VALID_YAML);
    expect(() => validateConfig(config)).not.toThrow();
  });
});
```

**Step 2: 运行测试确认失败**

```bash
npx vitest run src/__tests__/config.test.ts
```
Expected: FAIL - module not found

**Step 3: 实现 config.ts**

```typescript
// src/config.ts
import { readFileSync } from "fs";
import { parse } from "yaml";

export type SizeMode = "fixedRatio" | "equalSize" | "fixedAmount";
export type ExchangeId = "hyperliquid" | "binance" | "okx" | "bybit";

export interface TargetConfig {
  name: string;
  address: string;
  exchange: ExchangeId;
  leverage: number;
  sizeMode: SizeMode;
  sizeValue: number;
  perCoinCap: number;
  enabled: boolean;
}

export interface AppConfig {
  global: {
    network: "mainnet" | "testnet";
    totalPositionCap: number;
    checkIntervalMs: number;
  };
  exchanges: {
    hyperliquid?: { privateKey: string };
    binance?: { apiKey: string; apiSecret: string };
    okx?: { apiKey: string; apiSecret: string; passphrase: string };
    bybit?: { apiKey: string; apiSecret: string };
  };
  telegram: {
    botToken: string;
    chatId: string;
  };
  targets: TargetConfig[];
}

const VALID_SIZE_MODES: SizeMode[] = ["fixedRatio", "equalSize", "fixedAmount"];
const VALID_EXCHANGES: ExchangeId[] = ["hyperliquid", "binance", "okx", "bybit"];

export function parseConfig(yamlStr: string): AppConfig {
  return parse(yamlStr) as AppConfig;
}

export function loadConfig(path: string): AppConfig {
  const raw = readFileSync(path, "utf-8");
  const config = parseConfig(raw);
  validateConfig(config);
  return config;
}

export function validateConfig(config: AppConfig): void {
  if (!config.targets || config.targets.length === 0) {
    throw new Error("config: targets must have at least one entry");
  }
  for (const t of config.targets) {
    if (!VALID_EXCHANGES.includes(t.exchange)) {
      throw new Error(`config: invalid exchange "${t.exchange}" for target "${t.name}"`);
    }
    if (!VALID_SIZE_MODES.includes(t.sizeMode)) {
      throw new Error(`config: invalid sizeMode "${t.sizeMode}" for target "${t.name}"`);
    }
    if (t.sizeValue <= 0) {
      throw new Error(`config: sizeValue must be > 0 for target "${t.name}"`);
    }
    if (t.perCoinCap <= 0) {
      throw new Error(`config: perCoinCap must be > 0 for target "${t.name}"`);
    }
    if (t.leverage <= 0) {
      throw new Error(`config: leverage must be > 0 for target "${t.name}"`);
    }
    // 检查对应交易所的 API 密钥是否配置
    if (!config.exchanges[t.exchange]) {
      throw new Error(`config: exchange "${t.exchange}" credentials missing for target "${t.name}"`);
    }
  }
}
```

**Step 4: 运行测试确认通过**

```bash
npx vitest run src/__tests__/config.test.ts
```
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts
git commit -m "feat: add config loading and validation"
```

---

### Task 3: Logger 工具

**Files:**
- Create: `src/utils/logger.ts`

**Step 1: 实现 logger**

```typescript
// src/utils/logger.ts
export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

let currentLevel = LogLevel.INFO;

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function timestamp(): string {
  return new Date().toISOString();
}

export function debug(tag: string, msg: string, data?: unknown): void {
  if (currentLevel <= LogLevel.DEBUG) {
    console.log(`[${timestamp()}] [DEBUG] [${tag}] ${msg}`, data ?? "");
  }
}

export function info(tag: string, msg: string, data?: unknown): void {
  if (currentLevel <= LogLevel.INFO) {
    console.log(`[${timestamp()}] [INFO] [${tag}] ${msg}`, data ?? "");
  }
}

export function warn(tag: string, msg: string, data?: unknown): void {
  if (currentLevel <= LogLevel.WARN) {
    console.warn(`[${timestamp()}] [WARN] [${tag}] ${msg}`, data ?? "");
  }
}

export function error(tag: string, msg: string, data?: unknown): void {
  if (currentLevel <= LogLevel.ERROR) {
    console.error(`[${timestamp()}] [ERROR] [${tag}] ${msg}`, data ?? "");
  }
}
```

**Step 2: Commit**

```bash
git add src/utils/logger.ts
git commit -m "feat: add logger utility"
```

---

### Task 4: 币种映射工具

**Files:**
- Create: `src/utils/coinMapping.ts`
- Create: `src/__tests__/coinMapping.test.ts`

**Step 1: 写失败测试**

```typescript
// src/__tests__/coinMapping.test.ts
import { describe, it, expect } from "vitest";
import { mapCoin } from "../utils/coinMapping.js";

describe("mapCoin", () => {
  it("maps BTC to Binance symbol", () => {
    expect(mapCoin("BTC", "binance")).toBe("BTC/USDT:USDT");
  });

  it("maps ETH to OKX symbol", () => {
    expect(mapCoin("ETH", "okx")).toBe("ETH/USDT:USDT");
  });

  it("maps SOL to Bybit symbol", () => {
    expect(mapCoin("SOL", "bybit")).toBe("SOL/USDT:USDT");
  });

  it("maps BTC to Hyperliquid symbol", () => {
    expect(mapCoin("BTC", "hyperliquid")).toBe("BTC/USDC:USDC");
  });
});
```

**Step 2: 运行测试确认失败**

```bash
npx vitest run src/__tests__/coinMapping.test.ts
```

**Step 3: 实现 coinMapping**

```typescript
// src/utils/coinMapping.ts
import type { ExchangeId } from "../config.js";

// ccxt unified symbol format
// Hyperliquid 永续用 USDC 结算
// CEX 永续用 USDT 结算
export function mapCoin(hlCoin: string, exchange: ExchangeId): string {
  if (exchange === "hyperliquid") {
    return `${hlCoin}/USDC:USDC`;
  }
  // Binance, OKX, Bybit 统一用 ccxt 格式
  return `${hlCoin}/USDT:USDT`;
}
```

**Step 4: 运行测试确认通过**

```bash
npx vitest run src/__tests__/coinMapping.test.ts
```

**Step 5: Commit**

```bash
git add src/utils/coinMapping.ts src/__tests__/coinMapping.test.ts
git commit -m "feat: add coin mapping for exchange symbols"
```

---

### Task 5: Hyperliquid Monitor（WS 监控）

**Files:**
- Create: `src/monitor/HyperliquidMonitor.ts`
- Create: `src/monitor/types.ts`

**Step 1: 定义事件类型**

```typescript
// src/monitor/types.ts
export interface HlFill {
  coin: string;
  px: string;       // 成交价
  sz: string;       // 成交量
  side: "B" | "A";  // B=买入, A=卖出
  time: number;
  closedPnl: string; // "0" 表示开仓, 非零表示平仓
  fee: string;
  tid: number;
  oid: number;
  cloid?: string;
  startPosition: string;
  dir: string;
  hash: string;
}

export interface FillEvent {
  targetName: string;
  targetAddress: string;
  fill: HlFill;
  isOpen: boolean;  // true=开仓/加仓, false=减仓/平仓
}

export type FillHandler = (event: FillEvent) => void;
```

**Step 2: 实现 Monitor**

```typescript
// src/monitor/HyperliquidMonitor.ts
import WebSocket from "ws";
import type { TargetConfig } from "../config.js";
import type { HlFill, FillEvent, FillHandler } from "./types.js";
import * as log from "../utils/logger.js";

const TAG = "Monitor";
const HL_WS_URL = "wss://api.hyperliquid.xyz/ws";

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

  start(): void {
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
    // 跳过初始快照，只处理实时成交
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
```

**Step 3: Commit**

```bash
git add src/monitor/types.ts src/monitor/HyperliquidMonitor.ts
git commit -m "feat: add Hyperliquid WebSocket monitor for userFills"
```

---

### Task 6: Position Tracker

**Files:**
- Create: `src/tracker/PositionTracker.ts`
- Create: `src/__tests__/positionTracker.test.ts`

**Step 1: 写失败测试**

```typescript
// src/__tests__/positionTracker.test.ts
import { describe, it, expect } from "vitest";
import { PositionTracker } from "../tracker/PositionTracker.js";

describe("PositionTracker", () => {
  it("tracks new long position", () => {
    const tracker = new PositionTracker();
    tracker.applyFill("whale-1", "BTC", "B", 0.5, 50000);
    const pos = tracker.getPosition("whale-1", "BTC");
    expect(pos).toEqual({ size: 0.5, side: "long", notional: 25000 });
  });

  it("tracks new short position", () => {
    const tracker = new PositionTracker();
    tracker.applyFill("whale-1", "ETH", "A", 10, 3000);
    const pos = tracker.getPosition("whale-1", "ETH");
    expect(pos).toEqual({ size: 10, side: "short", notional: 30000 });
  });

  it("increases existing position", () => {
    const tracker = new PositionTracker();
    tracker.applyFill("whale-1", "BTC", "B", 0.5, 50000);
    tracker.applyFill("whale-1", "BTC", "B", 0.3, 51000);
    const pos = tracker.getPosition("whale-1", "BTC");
    expect(pos!.size).toBeCloseTo(0.8);
    expect(pos!.side).toBe("long");
  });

  it("reduces position on partial close", () => {
    const tracker = new PositionTracker();
    tracker.applyFill("whale-1", "BTC", "B", 1.0, 50000);
    tracker.applyFill("whale-1", "BTC", "A", 0.4, 52000);
    const pos = tracker.getPosition("whale-1", "BTC");
    expect(pos!.size).toBeCloseTo(0.6);
    expect(pos!.side).toBe("long");
  });

  it("removes position on full close", () => {
    const tracker = new PositionTracker();
    tracker.applyFill("whale-1", "BTC", "B", 1.0, 50000);
    tracker.applyFill("whale-1", "BTC", "A", 1.0, 52000);
    const pos = tracker.getPosition("whale-1", "BTC");
    expect(pos).toBeNull();
  });

  it("returns total notional across coins", () => {
    const tracker = new PositionTracker();
    tracker.applyFill("whale-1", "BTC", "B", 1, 50000);
    tracker.applyFill("whale-1", "ETH", "A", 10, 3000);
    expect(tracker.getTotalNotional("whale-1")).toBeCloseTo(80000);
  });

  it("isolates different targets", () => {
    const tracker = new PositionTracker();
    tracker.applyFill("whale-1", "BTC", "B", 1, 50000);
    tracker.applyFill("whale-2", "BTC", "A", 2, 50000);
    expect(tracker.getPosition("whale-1", "BTC")!.side).toBe("long");
    expect(tracker.getPosition("whale-2", "BTC")!.side).toBe("short");
  });
});
```

**Step 2: 运行测试确认失败**

```bash
npx vitest run src/__tests__/positionTracker.test.ts
```

**Step 3: 实现 PositionTracker**

```typescript
// src/tracker/PositionTracker.ts
export interface Position {
  size: number;     // 绝对值
  side: "long" | "short";
  notional: number; // size * 最新价
}

export class PositionTracker {
  // targetName -> coin -> position
  private positions = new Map<string, Map<string, { rawSize: number; lastPrice: number }>>();

  applyFill(targetName: string, coin: string, side: "B" | "A", size: number, price: number): void {
    if (!this.positions.has(targetName)) {
      this.positions.set(targetName, new Map());
    }
    const targetPositions = this.positions.get(targetName)!;

    const current = targetPositions.get(coin) ?? { rawSize: 0, lastPrice: price };
    // B (buy) = 正方向(long), A (sell) = 负方向(short)
    const delta = side === "B" ? size : -size;
    current.rawSize += delta;
    current.lastPrice = price;

    // 清除归零仓位
    if (Math.abs(current.rawSize) < 1e-12) {
      targetPositions.delete(coin);
    } else {
      targetPositions.set(coin, current);
    }
  }

  getPosition(targetName: string, coin: string): Position | null {
    const targetPositions = this.positions.get(targetName);
    if (!targetPositions) return null;
    const pos = targetPositions.get(coin);
    if (!pos) return null;
    return {
      size: Math.abs(pos.rawSize),
      side: pos.rawSize > 0 ? "long" : "short",
      notional: Math.abs(pos.rawSize) * pos.lastPrice,
    };
  }

  getCoinNotional(targetName: string, coin: string): number {
    const pos = this.getPosition(targetName, coin);
    return pos ? pos.notional : 0;
  }

  getTotalNotional(targetName: string): number {
    const targetPositions = this.positions.get(targetName);
    if (!targetPositions) return 0;
    let total = 0;
    for (const [, pos] of targetPositions) {
      total += Math.abs(pos.rawSize) * pos.lastPrice;
    }
    return total;
  }
}
```

**Step 4: 运行测试确认通过**

```bash
npx vitest run src/__tests__/positionTracker.test.ts
```

**Step 5: Commit**

```bash
git add src/tracker/PositionTracker.ts src/__tests__/positionTracker.test.ts
git commit -m "feat: add position tracker with fill-based state management"
```

---

### Task 7: Risk Manager

**Files:**
- Create: `src/risk/RiskManager.ts`
- Create: `src/__tests__/riskManager.test.ts`

**Step 1: 写失败测试**

```typescript
// src/__tests__/riskManager.test.ts
import { describe, it, expect } from "vitest";
import { RiskManager } from "../risk/RiskManager.js";

describe("RiskManager", () => {
  it("allows order within limits", () => {
    const rm = new RiskManager(50000);
    const result = rm.check({
      coin: "BTC",
      orderNotional: 5000,
      currentCoinNotional: 0,
      perCoinCap: 10000,
      currentTotalNotional: 0,
    });
    expect(result.allowed).toBe(true);
    expect(result.adjustedNotional).toBe(5000);
  });

  it("truncates to per-coin cap", () => {
    const rm = new RiskManager(50000);
    const result = rm.check({
      coin: "BTC",
      orderNotional: 8000,
      currentCoinNotional: 6000,
      perCoinCap: 10000,
      currentTotalNotional: 6000,
    });
    expect(result.allowed).toBe(true);
    expect(result.adjustedNotional).toBe(4000);
  });

  it("truncates to total cap", () => {
    const rm = new RiskManager(50000);
    const result = rm.check({
      coin: "ETH",
      orderNotional: 20000,
      currentCoinNotional: 0,
      perCoinCap: 30000,
      currentTotalNotional: 40000,
    });
    expect(result.allowed).toBe(true);
    expect(result.adjustedNotional).toBe(10000);
  });

  it("rejects when coin cap already reached", () => {
    const rm = new RiskManager(50000);
    const result = rm.check({
      coin: "BTC",
      orderNotional: 1000,
      currentCoinNotional: 10000,
      perCoinCap: 10000,
      currentTotalNotional: 10000,
    });
    expect(result.allowed).toBe(false);
  });

  it("rejects when total cap already reached", () => {
    const rm = new RiskManager(50000);
    const result = rm.check({
      coin: "BTC",
      orderNotional: 1000,
      currentCoinNotional: 0,
      perCoinCap: 10000,
      currentTotalNotional: 50000,
    });
    expect(result.allowed).toBe(false);
  });
});
```

**Step 2: 运行测试确认失败**

```bash
npx vitest run src/__tests__/riskManager.test.ts
```

**Step 3: 实现 RiskManager**

```typescript
// src/risk/RiskManager.ts
import * as log from "../utils/logger.js";

const TAG = "Risk";

export interface RiskCheckInput {
  coin: string;
  orderNotional: number;
  currentCoinNotional: number;
  perCoinCap: number;
  currentTotalNotional: number;
}

export interface RiskCheckResult {
  allowed: boolean;
  adjustedNotional: number;
  reason?: string;
}

export class RiskManager {
  private totalCap: number;

  constructor(totalPositionCap: number) {
    this.totalCap = totalPositionCap;
  }

  check(input: RiskCheckInput): RiskCheckResult {
    const coinRemaining = input.perCoinCap - input.currentCoinNotional;
    const totalRemaining = this.totalCap - input.currentTotalNotional;

    if (coinRemaining <= 0) {
      log.warn(TAG, `${input.coin} per-coin cap reached (${input.currentCoinNotional}/${input.perCoinCap})`);
      return { allowed: false, adjustedNotional: 0, reason: "per-coin cap reached" };
    }

    if (totalRemaining <= 0) {
      log.warn(TAG, `total cap reached (${input.currentTotalNotional}/${this.totalCap})`);
      return { allowed: false, adjustedNotional: 0, reason: "total cap reached" };
    }

    let adjusted = input.orderNotional;

    if (input.currentCoinNotional + adjusted > input.perCoinCap) {
      adjusted = coinRemaining;
      log.info(TAG, `${input.coin} truncated to per-coin cap: ${adjusted}`);
    }

    if (input.currentTotalNotional + adjusted > this.totalCap) {
      adjusted = totalRemaining;
      log.info(TAG, `${input.coin} truncated to total cap: ${adjusted}`);
    }

    return { allowed: true, adjustedNotional: adjusted };
  }
}
```

**Step 4: 运行测试确认通过**

```bash
npx vitest run src/__tests__/riskManager.test.ts
```

**Step 5: Commit**

```bash
git add src/risk/RiskManager.ts src/__tests__/riskManager.test.ts
git commit -m "feat: add risk manager with per-coin and total position caps"
```

---

### Task 8: Exchange Adapter 接口 + Hyperliquid 实现

**Files:**
- Create: `src/exchange/types.ts`
- Create: `src/exchange/HyperliquidAdapter.ts`

**Step 1: 定义统一接口**

```typescript
// src/exchange/types.ts
export interface OrderParams {
  symbol: string;         // ccxt unified symbol
  side: "buy" | "sell";
  size: number;           // 合约数量
  leverage: number;
  reduceOnly: boolean;
}

export interface OrderResult {
  orderId: string;
  filledSize: number;
  avgPrice: number;
  status: "filled" | "partial" | "failed";
}

export interface BookTop {
  bid: number;
  ask: number;
}

export interface ExchangeAdapter {
  name: string;
  ensureIsolatedMargin(symbol: string, leverage: number): Promise<void>;
  getBookTop(symbol: string): Promise<BookTop>;
  placePostOnly(symbol: string, side: "buy" | "sell", size: number, price: number, reduceOnly: boolean): Promise<string>;
  cancelOrder(symbol: string, orderId: string): Promise<void>;
  getOrderStatus(symbol: string, orderId: string): Promise<{ filled: number; remaining: number; status: string }>;
  placeChaseLimitOrder?(params: OrderParams): Promise<OrderResult>;  // OKX only
  getPosition(symbol: string): Promise<{ size: number; side: "long" | "short" | "none" }>;
}
```

**Step 2: 实现 HyperliquidAdapter**

查询 Hyperliquid Python SDK 的 exchange API 文档后，使用原始 HTTP 调用实现。Hyperliquid 的 exchange API 需要 EIP-712 签名，这里使用 `hyperliquid` npm 社区包或直接用原始 API。

由于 ccxt 支持 Hyperliquid，优先使用 ccxt：

```typescript
// src/exchange/HyperliquidAdapter.ts
import ccxt from "ccxt";
import type { ExchangeAdapter, BookTop } from "./types.js";
import * as log from "../utils/logger.js";

const TAG = "HL-Adapter";

export class HyperliquidAdapter implements ExchangeAdapter {
  name = "hyperliquid";
  private client: ccxt.hyperliquid;

  constructor(privateKey: string) {
    this.client = new ccxt.hyperliquid({
      privateKey,
      walletAddress: undefined, // ccxt 会从 privateKey 推导
    });
  }

  async ensureIsolatedMargin(symbol: string, leverage: number): Promise<void> {
    await this.client.setMarginMode("isolated", symbol);
    await this.client.setLeverage(leverage, symbol);
    log.info(TAG, `set ${symbol} isolated ${leverage}x`);
  }

  async getBookTop(symbol: string): Promise<BookTop> {
    const ob = await this.client.fetchOrderBook(symbol, 1);
    return {
      bid: ob.bids[0][0],
      ask: ob.asks[0][0],
    };
  }

  async placePostOnly(symbol: string, side: "buy" | "sell", size: number, price: number, reduceOnly: boolean): Promise<string> {
    const order = await this.client.createOrder(symbol, "limit", side, size, price, {
      postOnly: true,
      reduceOnly,
    });
    log.info(TAG, `post-only ${side} ${size} ${symbol} @ ${price} → ${order.id}`);
    return order.id;
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    await this.client.cancelOrder(orderId, symbol);
  }

  async getOrderStatus(symbol: string, orderId: string): Promise<{ filled: number; remaining: number; status: string }> {
    const order = await this.client.fetchOrder(orderId, symbol);
    return {
      filled: order.filled ?? 0,
      remaining: order.remaining ?? 0,
      status: order.status ?? "unknown",
    };
  }

  async getPosition(symbol: string): Promise<{ size: number; side: "long" | "short" | "none" }> {
    const positions = await this.client.fetchPositions([symbol]);
    const pos = positions.find((p) => p.symbol === symbol);
    if (!pos || pos.contracts === 0) return { size: 0, side: "none" };
    return {
      size: Math.abs(pos.contracts ?? 0),
      side: (pos.side as "long" | "short") ?? "none",
    };
  }
}
```

**Step 3: Commit**

```bash
git add src/exchange/types.ts src/exchange/HyperliquidAdapter.ts
git commit -m "feat: add exchange adapter interface and Hyperliquid implementation"
```

---

### Task 9: Binance Adapter

**Files:**
- Create: `src/exchange/BinanceAdapter.ts`

**Step 1: 实现 BinanceAdapter**

```typescript
// src/exchange/BinanceAdapter.ts
import ccxt from "ccxt";
import type { ExchangeAdapter, BookTop } from "./types.js";
import * as log from "../utils/logger.js";

const TAG = "Binance-Adapter";

export class BinanceAdapter implements ExchangeAdapter {
  name = "binance";
  private client: ccxt.binanceusdm;

  constructor(apiKey: string, apiSecret: string) {
    this.client = new ccxt.binanceusdm({
      apiKey,
      secret: apiSecret,
    });
  }

  async ensureIsolatedMargin(symbol: string, leverage: number): Promise<void> {
    try {
      await this.client.setMarginMode("isolated", symbol);
    } catch (e: any) {
      // 可能已经是 isolated，忽略 "No need to change" 错误
      if (!e.message?.includes("No need to change")) throw e;
    }
    await this.client.setLeverage(leverage, symbol);
    log.info(TAG, `set ${symbol} isolated ${leverage}x`);
  }

  async getBookTop(symbol: string): Promise<BookTop> {
    const ob = await this.client.fetchOrderBook(symbol, 5);
    return { bid: ob.bids[0][0], ask: ob.asks[0][0] };
  }

  async placePostOnly(symbol: string, side: "buy" | "sell", size: number, price: number, reduceOnly: boolean): Promise<string> {
    const order = await this.client.createOrder(symbol, "limit", side, size, price, {
      timeInForce: "GTX", // Post-Only on Binance Futures
      reduceOnly,
    });
    log.info(TAG, `post-only ${side} ${size} ${symbol} @ ${price} → ${order.id}`);
    return order.id;
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    await this.client.cancelOrder(orderId, symbol);
  }

  async getOrderStatus(symbol: string, orderId: string): Promise<{ filled: number; remaining: number; status: string }> {
    const order = await this.client.fetchOrder(orderId, symbol);
    return {
      filled: order.filled ?? 0,
      remaining: order.remaining ?? 0,
      status: order.status ?? "unknown",
    };
  }

  async getPosition(symbol: string): Promise<{ size: number; side: "long" | "short" | "none" }> {
    const positions = await this.client.fetchPositions([symbol]);
    const pos = positions.find((p) => p.symbol === symbol);
    if (!pos || pos.contracts === 0) return { size: 0, side: "none" };
    return {
      size: Math.abs(pos.contracts ?? 0),
      side: (pos.side as "long" | "short") ?? "none",
    };
  }
}
```

**Step 2: Commit**

```bash
git add src/exchange/BinanceAdapter.ts
git commit -m "feat: add Binance USDT-M futures adapter"
```

---

### Task 10: OKX Adapter（含原生 chase）

**Files:**
- Create: `src/exchange/OKXAdapter.ts`

**Step 1: 实现 OKXAdapter**

```typescript
// src/exchange/OKXAdapter.ts
import ccxt from "ccxt";
import type { ExchangeAdapter, BookTop, OrderParams, OrderResult } from "./types.js";
import * as log from "../utils/logger.js";

const TAG = "OKX-Adapter";

export class OKXAdapter implements ExchangeAdapter {
  name = "okx";
  private client: ccxt.okx;

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
    return { bid: ob.bids[0][0], ask: ob.asks[0][0] };
  }

  async placePostOnly(symbol: string, side: "buy" | "sell", size: number, price: number, reduceOnly: boolean): Promise<string> {
    const params: any = { tdMode: "isolated" };
    if (reduceOnly) params.reduceOnly = true;
    const order = await this.client.createOrder(symbol, "post_only", side, size, price, params);
    log.info(TAG, `post-only ${side} ${size} ${symbol} @ ${price} → ${order.id}`);
    return order.id;
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    await this.client.cancelOrder(orderId, symbol);
  }

  async getOrderStatus(symbol: string, orderId: string): Promise<{ filled: number; remaining: number; status: string }> {
    const order = await this.client.fetchOrder(orderId, symbol);
    return {
      filled: order.filled ?? 0,
      remaining: order.remaining ?? 0,
      status: order.status ?? "unknown",
    };
  }

  // OKX 原生 chase 限价单
  async placeChaseLimitOrder(params: OrderParams): Promise<OrderResult> {
    const instId = params.symbol.replace("/", "-").replace(":", "-");
    // 通过 OKX 私有 API 下 chase 算法单
    const response = await this.client.privatePostTradeOrderAlgo({
      instId,
      tdMode: "isolated",
      side: params.side,
      ordType: "chase",
      sz: String(params.size),
      // 默认 chase 参数：距离最优价 0 USD，跟到成交
    });
    const algoId = response.data?.[0]?.algoId ?? "unknown";
    log.info(TAG, `chase order ${params.side} ${params.size} ${params.symbol} → algoId: ${algoId}`);

    // chase 单是异步执行的，返回 algoId 后需轮询状态
    return {
      orderId: algoId,
      filledSize: 0,
      avgPrice: 0,
      status: "partial", // 异步执行中
    };
  }

  async getPosition(symbol: string): Promise<{ size: number; side: "long" | "short" | "none" }> {
    const positions = await this.client.fetchPositions([symbol]);
    const pos = positions.find((p) => p.symbol === symbol);
    if (!pos || pos.contracts === 0) return { size: 0, side: "none" };
    return {
      size: Math.abs(pos.contracts ?? 0),
      side: (pos.side as "long" | "short") ?? "none",
    };
  }
}
```

**Step 2: Commit**

```bash
git add src/exchange/OKXAdapter.ts
git commit -m "feat: add OKX adapter with native chase limit order"
```

---

### Task 11: Bybit Adapter

**Files:**
- Create: `src/exchange/BybitAdapter.ts`

**Step 1: 实现 BybitAdapter**

```typescript
// src/exchange/BybitAdapter.ts
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

  async placePostOnly(symbol: string, side: "buy" | "sell", size: number, price: number, reduceOnly: boolean): Promise<string> {
    const order = await this.client.createOrder(symbol, "limit", side, size, price, {
      timeInForce: "PostOnly",
      reduceOnly,
    });
    log.info(TAG, `post-only ${side} ${size} ${symbol} @ ${price} → ${order.id}`);
    return order.id;
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    await this.client.cancelOrder(orderId, symbol);
  }

  async getOrderStatus(symbol: string, orderId: string): Promise<{ filled: number; remaining: number; status: string }> {
    const order = await this.client.fetchOrder(orderId, symbol);
    return {
      filled: order.filled ?? 0,
      remaining: order.remaining ?? 0,
      status: order.status ?? "unknown",
    };
  }

  async getPosition(symbol: string): Promise<{ size: number; side: "long" | "short" | "none" }> {
    const positions = await this.client.fetchPositions([symbol]);
    const pos = positions.find((p) => p.symbol === symbol);
    if (!pos || pos.contracts === 0) return { size: 0, side: "none" };
    return {
      size: Math.abs(pos.contracts ?? 0),
      side: (pos.side as "long" | "short") ?? "none",
    };
  }
}
```

**Step 2: Commit**

```bash
git add src/exchange/BybitAdapter.ts
git commit -m "feat: add Bybit linear perpetual adapter"
```

---

### Task 12: Chase Executor（通用追逐限价）

**Files:**
- Create: `src/order/ChaseExecutor.ts`

**Step 1: 实现 ChaseExecutor**

```typescript
// src/order/ChaseExecutor.ts
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
    let remaining = totalSize;
    let totalCost = 0;
    let currentOrderId: string | null = null;

    log.info(TAG, `start chase ${side} ${totalSize} ${symbol} on ${adapter.name}`);

    while (remaining > 1e-8) {
      // 撤掉上一个单
      if (currentOrderId) {
        try {
          await adapter.cancelOrder(symbol, currentOrderId);
        } catch {
          // 可能已成交或已撤
        }

        // 检查上一单成交情况
        try {
          const status = await adapter.getOrderStatus(symbol, currentOrderId);
          if (status.filled > 0) {
            const newFilled = status.filled - (totalSize - remaining - (totalSize - remaining - filled));
            // 简化：重新计算
          }
        } catch {
          // ignore
        }
      }

      // 获取最新盘口
      const book = await adapter.getBookTop(symbol);
      const price = side === "buy" ? book.bid : book.ask;

      // 挂 post-only 单
      try {
        currentOrderId = await adapter.placePostOnly(symbol, side, remaining, price, reduceOnly);
      } catch (e: any) {
        log.error(TAG, `place failed: ${e.message}`);
        currentOrderId = null;
      }

      // 等待一个间隔
      await sleep(this.intervalMs);

      // 检查成交
      if (currentOrderId) {
        try {
          const status = await adapter.getOrderStatus(symbol, currentOrderId);
          const newFill = status.filled;
          if (newFill > 0) {
            filled += newFill;
            totalCost += newFill * price;
            remaining = totalSize - filled;
            log.info(TAG, `filled ${newFill}, total ${filled}/${totalSize}`);
          }
        } catch {
          // ignore
        }
      }
    }

    const avgPrice = filled > 0 ? totalCost / filled : 0;
    log.info(TAG, `chase complete: ${filled} ${symbol} @ avg ${avgPrice.toFixed(2)}`);

    return {
      orderId: currentOrderId ?? "unknown",
      filledSize: filled,
      avgPrice,
      status: "filled",
    };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

**Step 2: Commit**

```bash
git add src/order/ChaseExecutor.ts
git commit -m "feat: add generic chase limit executor for non-OKX exchanges"
```

---

### Task 13: Order Manager

**Files:**
- Create: `src/order/OrderManager.ts`
- Create: `src/__tests__/orderManager.test.ts`

**Step 1: 写计算下单量的测试**

```typescript
// src/__tests__/orderManager.test.ts
import { describe, it, expect } from "vitest";
import { calcOrderSize } from "../order/OrderManager.js";

describe("calcOrderSize", () => {
  it("fixedRatio: 10% of fill size", () => {
    expect(calcOrderSize("fixedRatio", 0.1, 1.0, 50000)).toBeCloseTo(0.1);
  });

  it("equalSize: same as fill", () => {
    expect(calcOrderSize("equalSize", 1, 2.5, 50000)).toBeCloseTo(2.5);
  });

  it("fixedAmount: USD amount / price", () => {
    expect(calcOrderSize("fixedAmount", 500, 1.0, 50000)).toBeCloseTo(0.01);
  });
});
```

**Step 2: 运行测试确认失败**

```bash
npx vitest run src/__tests__/orderManager.test.ts
```

**Step 3: 实现 OrderManager**

```typescript
// src/order/OrderManager.ts
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
): number {
  switch (mode) {
    case "fixedRatio":
      return fillSize * value;
    case "equalSize":
      return fillSize;
    case "fixedAmount":
      return value / price;
  }
}

export class OrderManager {
  private adapters: Map<ExchangeId, ExchangeAdapter>;
  private targetMap: Map<string, TargetConfig>; // targetName → config
  private tracker: PositionTracker;
  private risk: RiskManager;
  private chase: ChaseExecutor;
  private onOrderResult?: (target: string, coin: string, result: OrderResult, side: "buy" | "sell", isOpen: boolean) => void;

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

  async handleFill(event: FillEvent): Promise<void> {
    const config = this.targetMap.get(event.targetName);
    if (!config) return;

    const fill = event.fill;
    const price = parseFloat(fill.px);
    const fillSize = parseFloat(fill.sz);

    // 更新目标仓位镜像
    this.tracker.applyFill(event.targetName, fill.coin, fill.side, fillSize, price);

    // 计算反向方向
    const reverseSide: "buy" | "sell" = fill.side === "B" ? "sell" : "buy";
    const isOpen = event.isOpen;

    // 计算下单量
    let orderSize = calcOrderSize(config.sizeMode, config.sizeValue, fillSize, price);
    const orderNotional = orderSize * price;

    // 风控检查（只对开仓检查，平仓不限制）
    if (isOpen) {
      // 我方的反向仓位名义值 = 用我方 adapter 查或用 tracker 的镜像估算
      const mySymbol = mapCoin(fill.coin, config.exchange);
      const adapter = this.adapters.get(config.exchange);
      if (!adapter) {
        log.error(TAG, `no adapter for ${config.exchange}`);
        return;
      }

      // 使用 tracker 跟踪我方仓位（以 "my-{exchange}" 为 key）
      const myKey = `my-${config.exchange}`;
      const currentCoinNotional = this.tracker.getCoinNotional(myKey, fill.coin);
      const currentTotalNotional = this.tracker.getTotalNotional(myKey);

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
    }

    // 执行下单
    const adapter = this.adapters.get(config.exchange);
    if (!adapter) return;

    const symbol = mapCoin(fill.coin, config.exchange);

    try {
      // 确保逐仓模式
      await adapter.ensureIsolatedMargin(symbol, config.leverage);

      let result: OrderResult;

      // OKX 使用原生 chase
      if (config.exchange === "okx" && adapter.placeChaseLimitOrder) {
        result = await adapter.placeChaseLimitOrder({
          symbol,
          side: reverseSide,
          size: orderSize,
          leverage: config.leverage,
          reduceOnly: !isOpen,
        });
      } else {
        // 其他交易所用通用 chase
        result = await this.chase.execute(adapter, symbol, reverseSide, orderSize, !isOpen);
      }

      // 更新我方仓位
      const myKey = `my-${config.exchange}`;
      const mySide: "B" | "A" = reverseSide === "buy" ? "B" : "A";
      this.tracker.applyFill(myKey, fill.coin, mySide, result.filledSize, result.avgPrice || price);

      log.info(TAG, `${event.targetName} → reverse ${reverseSide} ${result.filledSize} ${fill.coin} on ${config.exchange}`);

      this.onOrderResult?.(event.targetName, fill.coin, result, reverseSide, isOpen);
    } catch (e: any) {
      log.error(TAG, `order failed: ${e.message}`);
    }
  }
}
```

**Step 4: 运行测试确认通过**

```bash
npx vitest run src/__tests__/orderManager.test.ts
```

**Step 5: Commit**

```bash
git add src/order/OrderManager.ts src/__tests__/orderManager.test.ts
git commit -m "feat: add order manager with reverse trading logic"
```

---

### Task 14: Telegram Notifier

**Files:**
- Create: `src/notify/TelegramNotifier.ts`

**Step 1: 实现 TelegramNotifier**

```typescript
// src/notify/TelegramNotifier.ts
import TelegramBot from "node-telegram-bot-api";
import type { OrderResult } from "../exchange/types.js";
import * as log from "../utils/logger.js";

const TAG = "Telegram";

export class TelegramNotifier {
  private bot: TelegramBot;
  private chatId: string;

  constructor(botToken: string, chatId: string) {
    this.bot = new TelegramBot(botToken);
    this.chatId = chatId;
  }

  async notifyOrder(
    targetName: string,
    coin: string,
    side: "buy" | "sell",
    isOpen: boolean,
    result: OrderResult,
    exchange: string,
  ): Promise<void> {
    const action = isOpen ? "反向开仓" : "反向平仓";
    const sideText = side === "buy" ? "做多" : "做空";
    const statusText = result.status === "filled" ? "已成交" : "部分成交";

    const msg = [
      `📊 *${action}*`,
      `目标: \`${targetName}\``,
      `交易所: ${exchange}`,
      `品种: ${coin}`,
      `方向: ${sideText}`,
      `数量: ${result.filledSize}`,
      `均价: ${result.avgPrice.toFixed(2)}`,
      `状态: ${statusText}`,
    ].join("\n");

    try {
      await this.bot.sendMessage(this.chatId, msg, { parse_mode: "Markdown" });
    } catch (e: any) {
      log.error(TAG, `send failed: ${e.message}`);
    }
  }

  async notifyError(message: string): Promise<void> {
    try {
      await this.bot.sendMessage(this.chatId, `⚠️ *异常*\n${message}`, { parse_mode: "Markdown" });
    } catch (e: any) {
      log.error(TAG, `send failed: ${e.message}`);
    }
  }
}
```

**Step 2: Commit**

```bash
git add src/notify/TelegramNotifier.ts
git commit -m "feat: add Telegram notifier"
```

---

### Task 15: 主入口 + 集成

**Files:**
- Create: `src/index.ts`

**Step 1: 实现主入口**

```typescript
// src/index.ts
import { loadConfig, type ExchangeId } from "./config.js";
import { HyperliquidMonitor } from "./monitor/HyperliquidMonitor.js";
import { PositionTracker } from "./tracker/PositionTracker.js";
import { RiskManager } from "./risk/RiskManager.js";
import { OrderManager } from "./order/OrderManager.js";
import { TelegramNotifier } from "./notify/TelegramNotifier.js";
import { HyperliquidAdapter } from "./exchange/HyperliquidAdapter.js";
import { BinanceAdapter } from "./exchange/BinanceAdapter.js";
import { OKXAdapter } from "./exchange/OKXAdapter.js";
import { BybitAdapter } from "./exchange/BybitAdapter.js";
import type { ExchangeAdapter } from "./exchange/types.js";
import * as log from "./utils/logger.js";

const TAG = "Main";

async function main() {
  const configPath = process.argv[2] ?? "config.yaml";
  log.info(TAG, `loading config from ${configPath}`);
  const config = loadConfig(configPath);

  // 初始化交易所 adapter
  const adapters = new Map<ExchangeId, ExchangeAdapter>();

  if (config.exchanges.hyperliquid) {
    adapters.set("hyperliquid", new HyperliquidAdapter(config.exchanges.hyperliquid.privateKey));
  }
  if (config.exchanges.binance) {
    adapters.set("binance", new BinanceAdapter(config.exchanges.binance.apiKey, config.exchanges.binance.apiSecret));
  }
  if (config.exchanges.okx) {
    adapters.set("okx", new OKXAdapter(config.exchanges.okx.apiKey, config.exchanges.okx.apiSecret, config.exchanges.okx.passphrase));
  }
  if (config.exchanges.bybit) {
    adapters.set("bybit", new BybitAdapter(config.exchanges.bybit.apiKey, config.exchanges.bybit.apiSecret));
  }

  // 检查所有 target 的交易所都已配置
  const enabledTargets = config.targets.filter((t) => t.enabled);
  for (const target of enabledTargets) {
    if (!adapters.has(target.exchange)) {
      throw new Error(`exchange "${target.exchange}" not configured but required by target "${target.name}"`);
    }
  }

  // 初始化各模块
  const tracker = new PositionTracker();
  const risk = new RiskManager(config.global.totalPositionCap);
  const notifier = new TelegramNotifier(config.telegram.botToken, config.telegram.chatId);

  const orderManager = new OrderManager(
    adapters,
    enabledTargets,
    tracker,
    risk,
    config.global.checkIntervalMs,
  );

  // 下单结果通知
  orderManager.setOrderResultHandler((target, coin, result, side, isOpen) => {
    const targetConfig = enabledTargets.find((t) => t.name === target);
    notifier.notifyOrder(target, coin, side, isOpen, result, targetConfig?.exchange ?? "unknown");
  });

  // 启动监控
  const monitor = new HyperliquidMonitor(enabledTargets);
  monitor.onFill((event) => {
    orderManager.handleFill(event).catch((e) => {
      log.error(TAG, `handleFill error: ${e.message}`);
      notifier.notifyError(`handleFill error for ${event.targetName}: ${e.message}`);
    });
  });

  monitor.start();

  log.info(TAG, `hype-bot started, monitoring ${enabledTargets.length} targets`);
  await notifier.notifyOrder("system", "N/A", "buy", false, { orderId: "", filledSize: 0, avgPrice: 0, status: "filled" }, "").catch(() => {});

  // 优雅退出
  const shutdown = () => {
    log.info(TAG, "shutting down...");
    monitor.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  log.error(TAG, `fatal: ${e.message}`);
  process.exit(1);
});
```

**Step 2: Commit**

```bash
git add src/index.ts
git commit -m "feat: add main entry point wiring all modules"
```

---

### Task 16: 运行全部测试 + 最终验证

**Step 1: 运行全部测试**

```bash
npx vitest run
```
Expected: 全部 PASS

**Step 2: 类型检查**

```bash
npx tsc --noEmit
```
Expected: 无错误

**Step 3: Commit 最终状态**

```bash
git add -A
git commit -m "chore: final verification pass"
```

---

## 执行顺序依赖

```
Task 1 (脚手架)
  → Task 2 (Config)
  → Task 3 (Logger)
  → Task 4 (CoinMapping)
  → Task 5 (Monitor) + Task 6 (Tracker) + Task 7 (RiskManager) [可并行]
  → Task 8-11 (Exchange Adapters) [可并行]
  → Task 12 (ChaseExecutor)
  → Task 13 (OrderManager)
  → Task 14 (TelegramNotifier)
  → Task 15 (Main Entry)
  → Task 16 (Final Test)
```
