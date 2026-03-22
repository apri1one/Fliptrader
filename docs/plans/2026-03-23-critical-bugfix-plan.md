# Hype-Bot 关键缺陷修复计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修复代码审查发现的 2 个 Critical + 10 个 High + 8 个 Medium 级问题，消除真金交易中的系统性风险。

**Architecture:** 按"影响真金程度"分三批修复：第一批修 Critical/High 级资金安全问题（仓位同步、去重、ChaseExecutor、OKX Adapter），第二批修 High 级架构问题（mutex 粒度、风控聚合），第三批修 Medium 级防御性问题（stop 生命周期、Telegram 格式、配置校验）。

**Tech Stack:** TypeScript, vitest, ccxt, ws, node-telegram-bot-api

---

## Task 1: 启动时同步自身交易所仓位（Critical #2）

**问题：** 启动时只加载被监控目标的仓位，不加载自身在 Binance/Bybit/OKX 上的真实持仓。重启后 `my-*` 持仓默认为空，风控低估敞口，平仓信号被跳过。

**Files:**
- Modify: `src/index.ts:99-109`
- Modify: `src/exchange/types.ts:28-45`（`ExchangeAdapter` 已有 `getPosition`，需新增 `fetchAllPositions`）

**Step 1: 在 ExchangeAdapter 接口添加 fetchAllPositions 方法**

在 `src/exchange/types.ts` 的 `ExchangeAdapter` 接口中添加：

```typescript
fetchAllPositions(): Promise<Array<{ symbol: string; size: number; side: "long" | "short" }>>;
```

**Step 2: 在四个 Adapter 中实现 fetchAllPositions**

各 Adapter 使用 `this.client.fetchPositions()` (无参数) 获取所有持仓，过滤 `contracts !== 0` 的返回。

**Step 3: 在 index.ts 的 monitor.start() 之前同步自身仓位**

```typescript
// 同步自身在各交易所的真实仓位
for (const [exchangeId, adapter] of adapters) {
  try {
    const positions = await adapter.fetchAllPositions();
    const myKey = `my-${exchangeId}`;
    for (const pos of positions) {
      const hlCoin = reverseMapCoin(pos.symbol, exchangeId);
      const side: "B" | "A" = pos.side === "long" ? "B" : "A";
      const book = await adapter.getBookTop(pos.symbol);
      const price = pos.side === "long" ? book.bid : book.ask;
      tracker.applyFill(myKey, hlCoin, side, pos.size, price);
      log.info(TAG, `synced my position: ${myKey} ${hlCoin} ${pos.side} ${pos.size}`);
    }
  } catch (e: any) {
    log.error(TAG, `failed to sync positions for ${exchangeId}: ${e.message}`);
  }
}
```

**Step 4: 在 coinMapping.ts 添加 reverseMapCoin 辅助函数**

```typescript
export function reverseMapCoin(symbol: string, exchange: ExchangeId): string {
  // "BTC/USDT:USDT" -> "BTC", "ETH/USDC:USDC" -> "ETH"
  return symbol.split("/")[0];
}
```

**Step 5: 运行 `npm run build` 确认编译通过**

**Step 6: 提交**

---

## Task 2: Fill 级去重 — 防止 WebSocket 重连后重复下单（High #10）

**问题：** `HlFill` 带 `tid`/`hash`，但 monitor 无去重机制，WebSocket 重连/重发会重复下单。

**Files:**
- Modify: `src/monitor/HyperliquidMonitor.ts:152-186`

**Step 1: 添加已处理 fill 集合**

在 `HyperliquidMonitor` 类中添加 `processedFills: Set<string>`，用 `hash` 做去重 key。为防内存膨胀，限制集合大小（保留最近 10000 条）。

```typescript
private processedFills = new Set<string>();
private readonly MAX_PROCESSED_FILLS = 10_000;
```

**Step 2: 在 handleFills 中做去重**

```typescript
if (this.processedFills.has(fill.hash)) {
  log.debug(TAG, `duplicate fill ${fill.hash} for ${target.name}, skipping`);
  continue;
}
this.processedFills.add(fill.hash);
if (this.processedFills.size > this.MAX_PROCESSED_FILLS) {
  const first = this.processedFills.values().next().value;
  this.processedFills.delete(first);
}
```

**Step 3: 运行 `npm run build && npm test` 确认通过**

**Step 4: 提交**

---

## Task 3: 修复 ChaseExecutor — closed 重复累计 + 永不返回 failed（High #3, Medium #13）

**问题 1：** closed 订单被重复累计成交量（循环内加一次，final check 再加一次）。
**问题 2：** 0 成交也返回 `"partial"` 而非 `"failed"`。

**Files:**
- Modify: `src/order/ChaseExecutor.ts:51-115`

**Step 1: 修复 closed 时 break 前清空 currentOrderId**

在 `if (status.status === "closed")` 分支中，break 前设 `currentOrderId = null`：

```typescript
if (status.status === "closed") {
  currentOrderId = null;
  break;
}
```

**Step 2: 修复返回状态判断**

```typescript
return {
  orderId: currentOrderId ?? "unknown",
  filledSize: filled,
  avgPrice,
  status: filled >= totalSize - 1e-8 ? "filled" : filled > 0 ? "partial" : "failed",
};
```

**Step 3: 编写测试覆盖这两个场景**

在 `src/__tests__/chaseExecutor.test.ts` 中：
- 测试 closed 订单不重复累计
- 测试 0 成交返回 `"failed"`
- 测试正常部分成交返回 `"partial"`

**Step 4: 运行 `npm test` 确认通过**

**Step 5: 提交**

---

## Task 4: 修复 OKX Adapter — instId 格式 + 撤单请求体 + 空盘口（High #5, #6, Medium #14）

**问题 1：** `BTC/USDT:USDT` → `BTC-USDT-USDT` 不是 OKX 合约 instId 格式（应为 `BTC-USDT-SWAP`）。
**问题 2：** 超时撤单 JSON.stringify 了数组再传，ccxt 期望直接传数组。
**问题 3：** `getBookTop()` 不检查空盘口。

**Files:**
- Modify: `src/exchange/OKXAdapter.ts:35-37,80,169-171`

**Step 1: 修复 instId 转换**

```typescript
// BTC/USDT:USDT → BTC-USDT-SWAP
const instId = params.symbol.split("/")[0] + "-USDT-SWAP";
```

**Step 2: 修复撤单请求体**

```typescript
await (this.client as any).privatePostTradeCancelAlgos(
  [{ algoId, instId }],
);
```

**Step 3: 修复 getBookTop 空盘口检查**

```typescript
async getBookTop(symbol: string): Promise<BookTop> {
  const ob = await this.client.fetchOrderBook(symbol, 1);
  const bid = ob.bids?.[0]?.[0];
  const ask = ob.asks?.[0]?.[0];
  if (bid === undefined || ask === undefined) {
    throw new Error(`empty order book for ${symbol}`);
  }
  return { bid, ask };
}
```

**Step 4: 修复超时分支累计 pending 成交量**

在 `pollAlgoOrder` 中，超时返回前检查最后的 pending 成交：

```typescript
// 超时前先查一次 pending 看是否有部分成交
try {
  const pending = await (this.client as any).privateGetTradeOrdersAlgoPending({
    ordType: "chase", algoId,
  });
  const pendingOrder = pending?.data?.[0];
  const filledSoFar = parseFloat(pendingOrder?.actualSz || "0");
  const avgPx = parseFloat(pendingOrder?.actualPx || "0");
  if (filledSoFar > 0) {
    return { orderId: algoId, filledSize: filledSoFar, avgPrice: avgPx, status: "partial" };
  }
} catch {}
```

**Step 5: 运行 `npm run build` 确认通过**

**Step 6: 提交**

---

## Task 5: 修复 Monitor stop() 生命周期 + 验证 user 字段（Medium #15, High #12）

**问题 1：** `stop()` 关闭 socket 后 `close` 回调仍触发重连。
**问题 2：** WebSocket 数据不验证 `data.user === target.address`。

**Files:**
- Modify: `src/monitor/HyperliquidMonitor.ts:51-57,96-133,152-155`

**Step 1: 添加 stopped 标志位**

```typescript
private stopped = false;
```

**Step 2: stop() 中设置 stopped = true**

```typescript
stop(): void {
  this.stopped = true;
  for (const [name, ws] of this.wsList) { ... }
}
```

**Step 3: close 回调中检查 stopped**

```typescript
ws.on("close", () => {
  log.warn(TAG, `disconnected for ${target.name}`);
  this.wsList.delete(target.name);
  if (!this.stopped) {
    log.info(TAG, `reconnecting for ${target.name}...`);
    setTimeout(() => this.connectTarget(target), this.reconnectDelayMs);
  }
});
```

**Step 4: handleFills 中校验 user 字段**

```typescript
if (data.user !== target.address) {
  log.warn(TAG, `user mismatch for ${target.name}: expected ${target.address}, got ${data.user}`);
  return;
}
```

**Step 5: 运行 `npm run build` 确认通过**

**Step 6: 提交**

---

## Task 6: 风控按 target 隔离仓位桶（High #4, #11）

**问题：** `my-${exchange}` 导致多 target 共享仓位桶；`totalPositionCap` 按单交易所生效而非全局。

**Files:**
- Modify: `src/order/OrderManager.ts:112-117,175-178`

**Step 1: 将仓位 key 从 `my-${exchange}` 改为 `my-${targetName}`**

这样每个 target 有独立的仓位桶。

```typescript
const myKey = `my-${event.targetName}`;
```

**Step 2: 风控的 totalNotional 改为跨所有 `my-*` 前缀的聚合**

在 `PositionTracker` 添加 `getGlobalNotional()` 方法：

```typescript
getGlobalNotional(prefix: string): number {
  let total = 0;
  for (const [key, positions] of this.positions) {
    if (key.startsWith(prefix)) {
      for (const [, pos] of positions) {
        total += Math.abs(pos.rawSize) * pos.lastPrice;
      }
    }
  }
  return total;
}
```

**Step 3: OrderManager 中使用 getGlobalNotional("my-") 做全局风控**

```typescript
const currentTotalNotional = this.tracker.getGlobalNotional("my-");
```

**Step 4: 编写测试验证多 target 独立风控 + totalCap 全局生效**

**Step 5: 运行 `npm test` 确认通过**

**Step 6: 提交**

---

## Task 7: fillMutex 改为 per-target 粒度（High #7）

**问题：** 全局 mutex 串行化所有 fill，一个慢单阻塞全部。

**Files:**
- Modify: `src/order/OrderManager.ts:39-72`

**Step 1: 将单个 mutex 改为 per-target Map**

```typescript
private fillMutexes = new Map<string, Promise<void>>();
```

**Step 2: handleFill 中按 targetName 获取/创建 mutex**

```typescript
async handleFill(event: FillEvent): Promise<void> {
  let releaseFn!: () => void;
  const release = new Promise<void>((r) => { releaseFn = r; });
  const prev = this.fillMutexes.get(event.targetName) ?? Promise.resolve();
  this.fillMutexes.set(event.targetName, release);
  await prev;
  try {
    await this._handleFill(event);
  } finally {
    releaseFn();
  }
}
```

**Step 3: 运行 `npm run build` 确认通过**

**Step 4: 提交**

---

## Task 8: Telegram 通知修复 — failed 状态 + Markdown 转义（Medium #16）

**Files:**
- Modify: `src/notify/TelegramNotifier.ts:24-48`

**Step 1: 区分 failed 状态文案**

```typescript
const statusText = result.status === "filled" ? "已成交"
  : result.status === "partial" ? "部分成交"
  : "失败";
```

**Step 2: Markdown 特殊字符转义**

```typescript
function escapeMarkdown(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
```

对 `notifyError` 中的 `message` 应用转义。

**Step 3: 运行 `npm run build` 确认通过**

**Step 4: 提交**

---

## Task 9: 配置校验增强 — 重复 target name + address 格式（Medium #17）

**Files:**
- Modify: `src/config.ts:76-99`

**Step 1: 添加 target name 唯一性检查**

```typescript
const names = new Set<string>();
for (const t of config.targets) {
  if (names.has(t.name)) {
    throw new Error(`config: duplicate target name "${t.name}"`);
  }
  names.add(t.name);
  // ... existing checks
}
```

**Step 2: 添加 address 非空检查**

```typescript
if (!t.address || typeof t.address !== "string") {
  throw new Error(`config: invalid address for target "${t.name}"`);
}
```

**Step 3: 添加 checkIntervalMs 范围检查**

```typescript
if (!config.global.checkIntervalMs || config.global.checkIntervalMs < 100) {
  throw new Error("config: checkIntervalMs must be >= 100");
}
```

**Step 4: 运行 `npm test` 确认现有配置测试通过**

**Step 5: 提交**

---

## Task 10: testnet 配置生效（Critical #1）

**问题：** `network: testnet` 配置存在但运行时完全忽略。

**Files:**
- Modify: `src/config.ts` — 添加 network 校验
- Modify: `src/index.ts` — 传递 network 到 adapter 和 monitor
- Modify: `src/exchange/BinanceAdapter.ts`, `BybitAdapter.ts`, `OKXAdapter.ts`, `HyperliquidAdapter.ts` — 构造函数接受 testnet 参数
- Modify: `src/monitor/HyperliquidMonitor.ts` — 根据 network 选择 endpoint

**Step 1: Adapter 构造函数添加 testnet 参数**

各 Adapter 的 ccxt 构造参数添加 `sandbox: true` 当 `network === "testnet"` 时。

**Step 2: Monitor 根据 network 切换 endpoint**

```typescript
const HL_WS_URL_MAINNET = "wss://api.hyperliquid.xyz/ws";
const HL_WS_URL_TESTNET = "wss://api.hyperliquid-testnet.xyz/ws";
const HL_INFO_URL_MAINNET = "https://api.hyperliquid.xyz/info";
const HL_INFO_URL_TESTNET = "https://api.hyperliquid-testnet.xyz/info";
```

**Step 3: index.ts 将 network 传给各模块**

**Step 4: 运行 `npm run build` 确认通过**

**Step 5: 提交**

---

## 执行顺序

| 批次 | Task | 严重度 | 预计复杂度 |
|------|------|--------|-----------|
| 1 | Task 1: 自身仓位同步 | Critical | 中 |
| 1 | Task 2: Fill 去重 | High | 低 |
| 1 | Task 3: ChaseExecutor 修复 | High | 低 |
| 1 | Task 4: OKX Adapter 修复 | High | 中 |
| 2 | Task 5: Monitor 生命周期 | Medium/High | 低 |
| 2 | Task 6: 风控 target 隔离 | High | 中 |
| 2 | Task 7: per-target mutex | High | 低 |
| 3 | Task 8: Telegram 修复 | Medium | 低 |
| 3 | Task 9: 配置校验 | Medium | 低 |
| 3 | Task 10: testnet 配置 | Critical | 中 |
