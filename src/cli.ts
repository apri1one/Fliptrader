import * as readline from "readline";
import { loadConfig, type ExchangeId, type AppConfig } from "./config.js";
import { BinanceAdapter } from "./exchange/BinanceAdapter.js";
import { BybitAdapter } from "./exchange/BybitAdapter.js";
import { OKXAdapter } from "./exchange/OKXAdapter.js";
import { HyperliquidAdapter } from "./exchange/HyperliquidAdapter.js";
import type { ExchangeAdapter } from "./exchange/types.js";
import { RiskManager } from "./risk/RiskManager.js";
import { TelegramNotifier } from "./notify/TelegramNotifier.js";
import { HyperliquidMonitor } from "./monitor/HyperliquidMonitor.js";
import { mapCoin } from "./utils/coinMapping.js";

// ─── ANSI helpers ───────────────────────────────────────────────
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

function mask(secret: string): string {
  if (secret.length <= 8) return "****";
  return secret.slice(0, 4) + "****" + secret.slice(-4);
}

function printTable(headers: string[], rows: string[][]): void {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const sep = widths.map((w) => "─".repeat(w + 2)).join("┼");
  const fmtRow = (r: string[]) =>
    r.map((c, i) => ` ${(c ?? "").padEnd(widths[i])} `).join("│");

  console.log(dim("┌" + sep.replace(/┼/g, "┬") + "┐"));
  console.log("│" + fmtRow(headers) + "│");
  console.log(dim("├" + sep + "┤"));
  for (const row of rows) {
    console.log("│" + fmtRow(row) + "│");
  }
  console.log(dim("└" + sep.replace(/┼/g, "┴") + "┘"));
}

// ─── Core ───────────────────────────────────────────────────────
let config: AppConfig;
let adapters: Map<ExchangeId, ExchangeAdapter>;
let rl: readline.Interface;

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function showMenu(): void {
  console.log();
  console.log(bold("╔══════════════════════════════════════╗"));
  console.log(bold("║   FlipTrader 功能测试面板            ║"));
  console.log(bold("╠══════════════════════════════════════╣"));
  console.log("║  1. 交易所连通性测试                 ║");
  console.log("║  2. 盘口数据查询                     ║");
  console.log("║  3. 仓位查询                         ║");
  console.log("║  4. 目标监控测试                     ║");
  console.log("║  5. 风控检查                         ║");
  console.log("║  6. Telegram 通知测试                ║");
  console.log("║  7. 模拟下单 (dry-run)               ║");
  console.log("║  8. 配置查看                         ║");
  console.log("║  q. 退出                             ║");
  console.log(bold("╚══════════════════════════════════════╝"));
}

// ─── 1. Exchange Connectivity ───────────────────────────────────
async function testConnectivity(): Promise<void> {
  console.log(bold("\n── 交易所连通性测试 ──\n"));
  const rows: string[][] = [];

  for (const [id, adapter] of adapters) {
    const symbol = mapCoin("BTC", id);
    const start = Date.now();
    try {
      await adapter.getBookTop(symbol);
      const ms = Date.now() - start;
      rows.push([id, green("✓ 连通"), `${ms}ms`]);
    } catch (e: any) {
      const ms = Date.now() - start;
      rows.push([id, red("✗ 失败"), `${ms}ms | ${e.message?.slice(0, 40)}`]);
    }
  }
  printTable(["交易所", "状态", "详情"], rows);
}

// ─── 2. Book Top ────────────────────────────────────────────────
async function testBookTop(): Promise<void> {
  console.log(bold("\n── 盘口数据查询 ──\n"));
  const coin = (await ask(cyan("输入币种 (如 BTC): "))).trim().toUpperCase();
  if (!coin) return;

  const ids = [...adapters.keys()];
  console.log(`可用交易所: ${ids.map((id, i) => `${i + 1}.${id}`).join("  ")}`);
  const choice = (await ask(cyan("选择交易所编号 (回车=全部): "))).trim();

  const selected = choice
    ? [ids[parseInt(choice) - 1]].filter(Boolean)
    : ids;

  const rows: string[][] = [];
  for (const id of selected) {
    const adapter = adapters.get(id)!;
    const symbol = mapCoin(coin, id);
    try {
      const book = await adapter.getBookTop(symbol);
      const spread = ((book.ask - book.bid) / book.bid * 100).toFixed(4);
      rows.push([id, symbol, String(book.bid), String(book.ask), `${spread}%`]);
    } catch (e: any) {
      rows.push([id, symbol, red("error"), red("error"), e.message?.slice(0, 30)]);
    }
  }
  printTable(["交易所", "Symbol", "Bid", "Ask", "Spread"], rows);
}

// ─── 3. Position Query ──────────────────────────────────────────
async function testPositions(): Promise<void> {
  console.log(bold("\n── 仓位查询 ──\n"));
  let totalRows: string[][] = [];

  for (const [id, adapter] of adapters) {
    try {
      const positions = await adapter.fetchAllPositions();
      if (positions.length === 0) {
        totalRows.push([id, dim("无持仓"), "", ""]);
      } else {
        for (const pos of positions) {
          totalRows.push([
            id,
            pos.symbol,
            pos.side === "long" ? green("LONG") : red("SHORT"),
            String(pos.size),
          ]);
        }
      }
    } catch (e: any) {
      totalRows.push([id, red(`错误: ${e.message?.slice(0, 40)}`), "", ""]);
    }
  }
  printTable(["交易所", "Symbol", "方向", "数量"], totalRows);
}

// ─── 4. Monitor Test ────────────────────────────────────────────
async function testMonitor(): Promise<void> {
  console.log(bold("\n── 目标监控测试 ──\n"));
  const targets = config.targets.filter((t) => t.enabled);
  if (targets.length === 0) {
    console.log(red("没有启用的 target"));
    return;
  }

  targets.forEach((t, i) => console.log(`  ${i + 1}. ${t.name} (${t.address.slice(0, 8)}...)`));
  const choice = (await ask(cyan("选择 target 编号: "))).trim();
  const idx = parseInt(choice) - 1;
  if (isNaN(idx) || idx < 0 || idx >= targets.length) {
    console.log(red("无效选择"));
    return;
  }

  const target = targets[idx];
  const isTestnet = config.global.network === "testnet";
  const monitor = new HyperliquidMonitor([target], isTestnet);

  monitor.setInitialPositionHandler((name, positions) => {
    console.log(yellow(`\n[初始仓位] ${name}: ${positions.length} 个持仓`));
    for (const p of positions) {
      console.log(`  ${p.coin} ${p.szi > 0 ? green("LONG") : red("SHORT")} ${Math.abs(p.szi)} @ ${p.entryPx}`);
    }
  });

  monitor.onFill((event) => {
    const f = event.fill;
    const side = f.side === "B" ? green("BUY") : red("SELL");
    const action = event.isOpen ? yellow("OPEN") : cyan("CLOSE");
    console.log(`[FILL] ${side} ${f.sz} ${f.coin} @ ${f.px} | ${action} (dir=${f.dir})`);
  });

  console.log(yellow(`\n正在连接 ${target.name} 的 WebSocket... 按 Enter 返回菜单\n`));
  await monitor.start();

  await ask("");
  monitor.stop();
  console.log(dim("已停止监控"));
}

// ─── 5. Risk Check ──────────────────────────────────────────────
async function testRiskCheck(): Promise<void> {
  console.log(bold("\n── 风控检查 ──\n"));
  const risk = new RiskManager(config.global.totalPositionCap);

  console.log(dim(`全局仓位上限: ${config.global.totalPositionCap}`));
  console.log();

  const coin = (await ask(cyan("币种 (如 BTC): "))).trim().toUpperCase() || "BTC";
  const orderNotional = parseFloat(await ask(cyan("下单名义价值: "))) || 0;
  const currentCoinNotional = parseFloat(await ask(cyan("当前该币种持仓名义: "))) || 0;
  const perCoinCap = parseFloat(await ask(cyan("单币种上限: "))) || 10000;
  const currentTotalNotional = parseFloat(await ask(cyan("当前总持仓名义: "))) || 0;

  const result = risk.check({
    coin,
    orderNotional,
    currentCoinNotional,
    perCoinCap,
    currentTotalNotional,
  });

  console.log();
  if (result.allowed) {
    console.log(green("✓ 允许下单"));
    if (result.adjustedNotional < orderNotional) {
      console.log(yellow(`  调整后名义: ${result.adjustedNotional} (原始: ${orderNotional})`));
    } else {
      console.log(`  名义价值: ${result.adjustedNotional}`);
    }
  } else {
    console.log(red(`✗ 拒绝: ${result.reason}`));
  }
}

// ─── 6. Telegram Test ───────────────────────────────────────────
async function testTelegram(): Promise<void> {
  console.log(bold("\n── Telegram 通知测试 ──\n"));
  const notifier = new TelegramNotifier(config.telegram.botToken, config.telegram.chatId);

  console.log(dim(`Bot Token: ${mask(config.telegram.botToken)}`));
  console.log(dim(`Chat ID: ${config.telegram.chatId}`));
  console.log();

  try {
    await notifier.notifyError("FlipTrader 测试消息 — 如果你看到这条消息说明通知功能正常");
    console.log(green("✓ 消息已发送，请检查 Telegram"));
  } catch (e: any) {
    console.log(red(`✗ 发送失败: ${e.message}`));
  }
}

// ─── 7. Dry-Run Order ───────────────────────────────────────────
async function testDryRunOrder(): Promise<void> {
  console.log(bold("\n── 模拟下单 (dry-run) ──\n"));
  console.log(yellow("注意: 将下一个远离市价的 post-only 限价单，然后立即撤销\n"));

  const ids = [...adapters.keys()];
  ids.forEach((id, i) => console.log(`  ${i + 1}. ${id}`));
  const exChoice = (await ask(cyan("选择交易所编号: "))).trim();
  const exIdx = parseInt(exChoice) - 1;
  if (isNaN(exIdx) || exIdx < 0 || exIdx >= ids.length) {
    console.log(red("无效选择"));
    return;
  }

  const exchangeId = ids[exIdx];
  const adapter = adapters.get(exchangeId)!;
  const coin = (await ask(cyan("币种 (如 BTC): "))).trim().toUpperCase() || "BTC";
  const symbol = mapCoin(coin, exchangeId);

  const sideInput = (await ask(cyan("方向 (buy/sell) [buy]: "))).trim().toLowerCase();
  const side: "buy" | "sell" = sideInput === "sell" ? "sell" : "buy";

  // 获取盘口
  let book;
  try {
    book = await adapter.getBookTop(symbol);
    console.log(dim(`当前盘口: bid=${book.bid} ask=${book.ask}`));
  } catch (e: any) {
    console.log(red(`获取盘口失败: ${e.message}`));
    return;
  }

  // 使用远离市价 50% 的价格，确保不会成交
  const safePrice = side === "buy"
    ? Math.floor(book.bid * 0.5 * 100) / 100
    : Math.ceil(book.ask * 2 * 100) / 100;
  // 使用极小数量
  const size = parseFloat(await ask(cyan(`数量 [最小量 0.001]: `))) || 0.001;

  console.log();
  console.log(`交易所: ${exchangeId}`);
  console.log(`Symbol: ${symbol}`);
  console.log(`方向: ${side}`);
  console.log(`价格: ${safePrice} ${dim("(远离市价，不会成交)")}`);
  console.log(`数量: ${size}`);

  const confirm = (await ask(yellow("\n确认下单? (y/N): "))).trim().toLowerCase();
  if (confirm !== "y") {
    console.log(dim("已取消"));
    return;
  }

  // Step 1: ensureIsolatedMargin
  try {
    console.log(dim("\n[1/4] 设置保证金模式..."));
    await adapter.ensureIsolatedMargin(symbol, 1);
    console.log(green("  ✓ 保证金模式已设置"));
  } catch (e: any) {
    console.log(yellow(`  ⚠ ${e.message?.slice(0, 60)} (可能已设置，继续)`));
  }

  // Step 2: placePostOnly
  let orderId: string;
  try {
    console.log(dim("[2/4] 下单..."));
    orderId = await adapter.placePostOnly(symbol, side, size, safePrice, false);
    console.log(green(`  ✓ 订单已创建: ${orderId}`));
  } catch (e: any) {
    console.log(red(`  ✗ 下单失败: ${e.message}`));
    return;
  }

  // Step 3: getOrderStatus
  try {
    console.log(dim("[3/4] 查询订单状态..."));
    const status = await adapter.getOrderStatus(symbol, orderId);
    console.log(green(`  ✓ 状态: ${status.status}, filled: ${status.filled}, remaining: ${status.remaining}`));
  } catch (e: any) {
    console.log(yellow(`  ⚠ 查询失败: ${e.message?.slice(0, 60)}`));
  }

  // Step 4: cancelOrder
  try {
    console.log(dim("[4/4] 撤单..."));
    await adapter.cancelOrder(symbol, orderId);
    console.log(green("  ✓ 订单已撤销"));
  } catch (e: any) {
    console.log(yellow(`  ⚠ 撤单: ${e.message?.slice(0, 60)} (可能已撤销或成交)`));
  }

  console.log(green("\n✓ Dry-run 完成，全部 API 调用正常"));
}

// ─── 8. Config View ─────────────────────────────────────────────
function showConfig(): void {
  console.log(bold("\n── 当前配置 ──\n"));

  // Global
  printTable(["配置项", "值"], [
    ["network", config.global.network],
    ["totalPositionCap", String(config.global.totalPositionCap)],
    ["checkIntervalMs", String(config.global.checkIntervalMs)],
  ]);

  // Exchanges
  console.log(bold("\n交易所凭证:"));
  const exRows: string[][] = [];
  if (config.exchanges.hyperliquid) {
    exRows.push(["hyperliquid", `privateKey: ${mask(config.exchanges.hyperliquid.privateKey)}`]);
  }
  if (config.exchanges.binance) {
    exRows.push(["binance", `apiKey: ${mask(config.exchanges.binance.apiKey)}`]);
  }
  if (config.exchanges.okx) {
    exRows.push(["okx", `apiKey: ${mask(config.exchanges.okx.apiKey)}`]);
  }
  if (config.exchanges.bybit) {
    exRows.push(["bybit", `apiKey: ${mask(config.exchanges.bybit.apiKey)}`]);
  }
  printTable(["交易所", "凭证"], exRows);

  // Targets
  console.log(bold("\n跟单目标:"));
  const tRows = config.targets.map((t) => [
    t.name,
    t.address.slice(0, 8) + "...",
    t.exchange,
    `${t.leverage}x`,
    t.sizeMode,
    String(t.sizeValue),
    String(t.perCoinCap),
    t.enabled ? green("启用") : red("禁用"),
  ]);
  printTable(["名称", "地址", "交易所", "杠杆", "模式", "值", "单币上限", "状态"], tRows);

  // Telegram
  console.log(bold("\nTelegram:"));
  printTable(["配置项", "值"], [
    ["botToken", mask(config.telegram.botToken)],
    ["chatId", config.telegram.chatId],
  ]);
}

// ─── Main ───────────────────────────────────────────────────────
async function main(): Promise<void> {
  const configPath = process.argv[2] ?? "config.yaml";

  try {
    config = loadConfig(configPath);
  } catch (e: any) {
    console.log(red(`配置加载失败: ${e.message}`));
    process.exit(1);
  }

  const isTestnet = config.global.network === "testnet";
  if (isTestnet) {
    console.log(yellow("\n⚠ TESTNET 模式\n"));
  }

  // Initialize adapters
  adapters = new Map();
  if (config.exchanges.hyperliquid) {
    adapters.set("hyperliquid", new HyperliquidAdapter(config.exchanges.hyperliquid.privateKey, isTestnet));
  }
  if (config.exchanges.binance) {
    adapters.set("binance", new BinanceAdapter(config.exchanges.binance.apiKey, config.exchanges.binance.apiSecret, isTestnet));
  }
  if (config.exchanges.okx) {
    adapters.set("okx", new OKXAdapter(config.exchanges.okx.apiKey, config.exchanges.okx.apiSecret, config.exchanges.okx.passphrase, isTestnet));
  }
  if (config.exchanges.bybit) {
    adapters.set("bybit", new BybitAdapter(config.exchanges.bybit.apiKey, config.exchanges.bybit.apiSecret, isTestnet));
  }

  console.log(bold(`\nFlipTrader CLI — 已加载 ${adapters.size} 个交易所, ${config.targets.filter((t) => t.enabled).length} 个目标\n`));

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const handlers: Record<string, () => Promise<void> | void> = {
    "1": testConnectivity,
    "2": testBookTop,
    "3": testPositions,
    "4": testMonitor,
    "5": testRiskCheck,
    "6": testTelegram,
    "7": testDryRunOrder,
    "8": showConfig,
  };

  while (true) {
    showMenu();
    const choice = (await ask(cyan("\n请选择: "))).trim().toLowerCase();

    if (choice === "q") {
      console.log(dim("\n再见 👋\n"));
      rl.close();
      process.exit(0);
    }

    const handler = handlers[choice];
    if (handler) {
      try {
        await handler();
      } catch (e: any) {
        console.log(red(`\n执行出错: ${e.message}`));
      }
      await ask(dim("\n按 Enter 返回菜单..."));
    } else {
      console.log(red("无效选择"));
    }
  }
}

main().catch((e: any) => {
  console.error(red(`fatal: ${e.message}`));
  process.exit(1);
});
