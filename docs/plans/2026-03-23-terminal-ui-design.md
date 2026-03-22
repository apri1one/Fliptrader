# FlipTrader Terminal UI MVP 设计

**Goal:** 交互式菜单驱动的终端测试面板，逐个验证 bot 各模块功能。

**Tech:** 单文件 `src/cli.ts`，纯 readline + ANSI 颜色，零额外依赖，复用现有模块。

## 功能列表

1. 交易所连通性测试 — fetchOrderBook 测试各交易所
2. 盘口数据查询 — 用户输入币种+交易所，显示 bid/ask/spread
3. 仓位查询 — fetchAllPositions 表格展示
4. 目标监控测试 — WebSocket 实时打印 fill 事件
5. 风控检查 — 交互式输入参数测试 RiskManager
6. Telegram 通知测试 — 发送测试消息
7. 模拟下单 (dry-run) — placePostOnly 远离市价 + 立即 cancelOrder
8. 配置查看 — 脱敏展示配置
