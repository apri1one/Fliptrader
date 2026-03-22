# Hyperliquid 反向跟单器设计文档

## 概述

监控 Hyperliquid 上指定地址的成交记录，在目标交易所（Hyperliquid / 币安 / OKX / Bybit）反向开仓/平仓。

## 核心决策

| 项目 | 决定 |
|------|------|
| 语言 | TypeScript |
| 监控源 | Hyperliquid WebSocket `userFills`（公开数据，无需认证） |
| 监控对象 | 多个地址，每个独立配置 |
| 交易端 | Hyperliquid / 币安 / OKX / Bybit 永续合约 |
| 保证金模式 | 全部逐仓（isolated margin） |
| 下单方式 | 追逐限价：OKX 用原生 `chase` 算法单，其他交易所手动 post-only + 每秒撤单重挂，一直追到成交 |
| 仓位模式 | 可配置：固定比例 / 等量反向 / 固定金额 |
| 风控 | 单品种硬顶 + 总仓位硬顶 |
| 通知 | Telegram |
| 部署 | 本地（Mac/Windows）+ 服务器（Ubuntu） |
| 网络 | 主网 |

## 架构

```
┌─────────────┐    WebSocket     ┌──────────────┐     ┌───────────────┐
│ Hyperliquid │  userFills x N   │  Monitor     │     │  Exchange     │
│ WS Server   │ ──────────────→  │  (per addr)  │ ──→ │  Router       │
└─────────────┘                  └──────────────┘     └───────┬───────┘
                                        │               ┌────┼────┬────────┐
                                        ▼               ▼    ▼    ▼        ▼
                                 ┌──────────────┐     HyperL  Binance  OKX  Bybit
                                 │  Position    │
                                 │  Tracker     │     ┌───────────────┐
                                 └──────────────┘     │  Risk Manager │
                                                      └───────────────┘
                                                            │
                                                            ▼
                                                      ┌───────────┐
                                                      │  Telegram  │
                                                      └───────────┘
```

## 核心模块

| 模块 | 职责 |
|------|------|
| **HyperliquidMonitor** | 每个目标地址一个 WS 连接，订阅 `userFills`，解析成交方向和数量 |
| **PositionTracker** | 内存维护目标地址仓位镜像，根据 fill 推算当前持仓 |
| **OrderManager** | 反向下单决策，路由到对应交易所 |
| **ChaseExecutor** | 追逐限价通用逻辑（非 OKX 交易所用） |
| **ExchangeAdapter** | 统一接口：下单、撤单、查仓位、查盘口、设置逐仓 |
| **HyperliquidAdapter** | Hyperliquid Exchange API 实现 |
| **BinanceAdapter** | 币安 USDT-M 合约 API 实现 |
| **OKXAdapter** | OKX 合约 API 实现（含原生 chase 订单） |
| **BybitAdapter** | Bybit 线性合约 API 实现 |
| **RiskManager** | 单品种硬顶 + 总仓位硬顶检查 |
| **TelegramNotifier** | Telegram 推送开仓/平仓/异常事件 |
| **Config** | YAML 配置加载与校验 |

## 核心流程

### 成交监控 → 反向下单

```
1. WS 收到目标地址 userFill
   ├── fill.side = "B" (对方买入/做多) → 我方开空 (sell)
   └── fill.side = "A" (对方卖出/做空或平多) → 我方开多 (buy)

2. 判断开仓/平仓
   ├── fill.closedPnl = "0" → 开仓/加仓 → 反向开仓
   └── fill.closedPnl ≠ "0" → 减仓/平仓 → 反向减仓/平仓

3. 计算下单数量
   ├── fixedRatio: fill.sz × ratio
   ├── equalSize: fill.sz
   └── fixedAmount: fixedUSDC / currentPrice

4. 风控检查
   ├── 单品种仓位 + 新单 > perCoinCap → 截断到硬顶
   └── 总仓位 + 新单 > totalCap → 拒绝下单

5. 执行下单（追逐限价）
   ├── OKX: chase 算法单
   └── 其他: post-only bid1/ask1 → 每秒撤单重挂 → 直到全部成交

6. Telegram 通知
```

### 追逐限价逻辑

```
开多/平空 → 挂在 bid1 (post-only)
开空/平多 → 挂在 ask1 (post-only)
每秒: 检查成交量 → 未完全成交 → 撤单 → 用最新盘口重挂剩余量
循环直到全部成交
```

### WS 断连处理

```
断连 → 自动重连 → 重新订阅（接受可能漏单）
```

### 币种映射

```
Hyperliquid "BTC" → Binance "BTCUSDT" (USDT-M futures)
Hyperliquid "BTC" → OKX "BTC-USDT-SWAP"
Hyperliquid "BTC" → Bybit "BTCUSDT" (linear perpetual)
```

### 逐仓设置

| 交易所 | 方式 |
|--------|------|
| Hyperliquid | 下单时 leverage.type = "isolated" |
| Binance | `POST /fapi/v1/marginType` → ISOLATED |
| OKX | tdMode = "isolated" |
| Bybit | `POST /v5/position/switch-isolated` |

## 配置文件

```yaml
global:
  network: "mainnet"
  totalPositionCap: 50000
  checkIntervalMs: 1000

exchanges:
  hyperliquid:
    privateKey: "0x..."
  binance:
    apiKey: "xxx"
    apiSecret: "xxx"
  okx:
    apiKey: "xxx"
    apiSecret: "xxx"
    passphrase: "xxx"
  bybit:
    apiKey: "xxx"
    apiSecret: "xxx"

telegram:
  botToken: "xxx"
  chatId: "xxx"

targets:
  - name: "whale-1"
    address: "0xabc..."
    exchange: "okx"
    leverage: 10
    sizeMode: "fixedRatio"
    sizeValue: 0.1
    perCoinCap: 10000
    enabled: true
  - name: "whale-2"
    address: "0xdef..."
    exchange: "binance"
    leverage: 5
    sizeMode: "fixedAmount"
    sizeValue: 500
    perCoinCap: 5000
    enabled: true
```

## 项目结构

```
hype-bot/
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── monitor/
│   │   └── HyperliquidMonitor.ts
│   ├── tracker/
│   │   └── PositionTracker.ts
│   ├── exchange/
│   │   ├── types.ts
│   │   ├── HyperliquidAdapter.ts
│   │   ├── BinanceAdapter.ts
│   │   ├── OKXAdapter.ts
│   │   └── BybitAdapter.ts
│   ├── order/
│   │   ├── OrderManager.ts
│   │   └── ChaseExecutor.ts
│   ├── risk/
│   │   └── RiskManager.ts
│   ├── notify/
│   │   └── TelegramNotifier.ts
│   └── utils/
│       ├── logger.ts
│       └── coinMapping.ts
├── config.yaml
├── config.example.yaml
├── package.json
├── tsconfig.json
└── .gitignore
```
