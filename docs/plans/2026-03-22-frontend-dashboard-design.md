# 前端管理面板设计文档

## 概述

为 hype-bot 反向跟单器构建 Web 管理面板，支持配置管理、状态监控、交易历史查看和目标地址数据查询。

## 核心决策

| 项目 | 决定 |
|------|------|
| 技术栈 | Next.js + Tailwind CSS |
| 设计风格 | 暗色主题，参考 Hyperbot |
| 架构 | 前后分离：Next.js(:3000) + Bot API(:3001) |
| 通信 | REST（配置读写）+ WebSocket（实时状态推送） |
| 认证 | 无需登录 |

## 架构

```
┌─────────────────────────────────┐     ┌──────────────────────────┐
│       Next.js 前端 (:3000)       │     │   Bot 进程 (:3001)        │
│                                 │     │                          │
│  Pages:                         │     │  HTTP API (Fastify)      │
│  - /dashboard                   │◄───►│  - GET/POST /api/config  │
│  - /targets                     │REST │  - GET /api/status       │
│  - /targets/:addr               │     │  - GET /api/trades       │
│  - /exchanges                   │     │  - GET /api/positions    │
│  - /settings                    │◄───►│  - GET /api/hl/*         │
│  - /history                     │ WS  │                          │
│                                 │     │  WebSocket (:3001/ws)    │
└─────────────────────────────────┘     │  - 实时状态推送           │
                                        │  - 新成交通知            │
                                        │                          │
                                        │  Bot Core (现有逻辑)      │
                                        └──────────────────────────┘
```

## Bot API 端点设计

### REST API

**状态类：**
- `GET /api/status` — Bot 运行状态、WS 连接状态、各目标监控状态
- `GET /api/positions` — 我方当前所有持仓
- `GET /api/trades` — 反向跟单交易历史（分页）

**配置类：**
- `GET /api/config` — 读取当前配置
- `POST /api/config` — 更新配置并热重载
- `POST /api/config/targets` — 添加目标
- `PUT /api/config/targets/:name` — 更新目标
- `DELETE /api/config/targets/:name` — 删除目标
- `POST /api/config/exchanges/:id` — 更新交易所配置
- `POST /api/config/exchanges/:id/test` — 测试交易所连接
- `POST /api/config/telegram/test` — 测试 Telegram 发送

**Hyperliquid 代理查询：**
- `GET /api/hl/positions/:address` — 目标地址当前持仓 (clearinghouseState)
- `GET /api/hl/orders/:address` — 目标地址挂单 (openOrders)
- `GET /api/hl/fills/:address` — 目标地址成交历史 (userFills)

### WebSocket

连接: `ws://localhost:3001/ws`

推送事件：
```json
{ "type": "status", "data": { "running": true, "connections": 3 } }
{ "type": "fill", "data": { "target": "whale-1", "coin": "BTC", ... } }
{ "type": "trade", "data": { "side": "sell", "coin": "BTC", ... } }
{ "type": "error", "data": { "message": "..." } }
```

## 页面设计

### 1. 仪表盘 `/dashboard`

顶部4个统计卡片：Bot 运行状态、WS 连接数、总持仓价值、总盈亏
中部：最近交易实时滚动表格（WS 推送）
底部左：我的当前持仓表格
底部右：盈亏曲线折线图

### 2. 目标管理 `/targets`

目标列表（卡片或表格），支持添加/编辑/删除/启停
点击进入详情页 `/targets/:address`，Tab 切换：
- 当前持仓（clearinghouseState）
- 挂单（openOrders）
- 历史委托（userFills）
- 历史仓位

### 3. 交易所配置 `/exchanges`

4个交易所卡片（Hyperliquid/Binance/OKX/Bybit）
已配置显示脱敏的 Key，支持修改和测试连接
未配置显示配置按钮

### 4. 全局设置 `/settings`

风控设置：总仓位硬顶、追逐限价间隔
Telegram 通知：Token、Chat ID、测试发送
网络选择：主网/测试网
保存按钮

### 5. 交易历史 `/history`

筛选栏：目标、品种、交易所、日期范围
分页表格：时间、目标、品种、方向、数量、均价、交易所、状态

## 设计风格

参考 Hyperbot 暗色主题：
- 背景：#0a0a12，卡片：#12121a + 细边框 #1e1e2e
- 主色：蓝紫渐变（#6366f1 → #8b5cf6）
- 盈：#22c55e，亏：#ef4444
- 状态在线：#22c55e 圆点，离线：#6b7280
- 数字等宽字体（Tabular Nums）
- 卡片圆角、半透明、微光边框
- 表格暗色行、排序箭头
- 按钮：描边 + 图标

## 前端项目结构

```
web/
├── src/
│   ├── app/
│   │   ├── layout.tsx          # 全局布局（侧边栏+顶栏）
│   │   ├── page.tsx            # 重定向到 /dashboard
│   │   ├── dashboard/
│   │   │   └── page.tsx
│   │   ├── targets/
│   │   │   ├── page.tsx        # 目标列表
│   │   │   └── [address]/
│   │   │       └── page.tsx    # 目标详情
│   │   ├── exchanges/
│   │   │   └── page.tsx
│   │   ├── settings/
│   │   │   └── page.tsx
│   │   └── history/
│   │       └── page.tsx
│   ├── components/
│   │   ├── layout/
│   │   │   ├── Sidebar.tsx
│   │   │   └── TopBar.tsx
│   │   ├── dashboard/
│   │   │   ├── StatCard.tsx
│   │   │   ├── RecentTrades.tsx
│   │   │   ├── MyPositions.tsx
│   │   │   └── PnlChart.tsx
│   │   ├── targets/
│   │   │   ├── TargetList.tsx
│   │   │   ├── TargetForm.tsx
│   │   │   └── TargetDetail.tsx
│   │   ├── exchanges/
│   │   │   └── ExchangeCard.tsx
│   │   └── ui/
│   │       ├── Table.tsx
│   │       ├── Badge.tsx
│   │       ├── Button.tsx
│   │       ├── Input.tsx
│   │       ├── Select.tsx
│   │       ├── Modal.tsx
│   │       ├── Tabs.tsx
│   │       └── DonutChart.tsx
│   ├── hooks/
│   │   ├── useWebSocket.ts
│   │   └── useApi.ts
│   ├── lib/
│   │   └── api.ts              # REST API 客户端
│   └── styles/
│       └── globals.css
├── tailwind.config.ts
├── next.config.ts
├── package.json
└── tsconfig.json
```

## Bot 端新增模块

```
src/
├── api/
│   ├── server.ts               # Fastify HTTP + WS 服务器
│   ├── routes/
│   │   ├── config.ts           # 配置读写 API
│   │   ├── status.ts           # 状态查询 API
│   │   ├── trades.ts           # 交易历史 API
│   │   └── hyperliquid.ts      # HL 代理查询 API
│   └── ws.ts                   # WebSocket 推送管理
├── store/
│   └── TradeStore.ts           # 交易记录持久化（JSON 文件或 SQLite）
```
