import * as readline from "readline";
import { existsSync, writeFileSync } from "fs";
import { stringify } from "yaml";
import { loadConfig, parseConfig, type ExchangeId, type AppConfig, type SizeMode } from "./config.js";
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
  if (!secret) return dim("(未配置)");
  if (secret.length <= 8) return "****";
  return secret.slice(0, 4) + "****" + secret.slice(-4);
}

function printTable(headers: string[], rows: string[][]): void {
  if (rows.length === 0) {
    console.log(dim("  (空)"));
    return;
  }
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

// ─── State ──────────────────────────────────────────────────────
let config: AppConfig;
let configPath: string;
let adapters: Map<ExchangeId, ExchangeAdapter>;
let rl: readline.Interface;

const DEFAULT_CONFIG: AppConfig = {
  global: { network: "mainnet", totalPositionCap: 50000, checkIntervalMs: 1000 },
  exchanges: {},
  telegram: { botToken: "", chatId: "" },
  targets: [],
};

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

function askWithDefault(question: string, defaultVal: string): Promise<string> {
  return ask(cyan(`${question} [${defaultVal}]: `)).then((v) => v.trim() || defaultVal);
}

function rebuildAdapters(): void {
  adapters = new Map();
  const isTestnet = config.global.network === "testnet";
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
}

function saveConfig(): void {
  writeFileSync(configPath, stringify(config), "utf-8");
  console.log(green(`✓ 配置已保存到 ${configPath}`));
}

// ─── Menu ───────────────────────────────────────────────────────
function showMenu(): void {
  const exCount = adapters.size;
  const tgOk = config.telegram.botToken && config.telegram.chatId;
  const targetCount = config.targets.filter((t) => t.enabled).length;

  console.log();
  console.log(bold("╔══════════════════════════════════════╗"));
  console.log(bold("║   FlipTrader 功能测试面板            ║"));
  console.log(bold("╠══════════════════════════════════════╣"));
  console.log(`║  ${yellow("0")}. 配置管理                         ║`);
  console.log(bold("║──────────────────────────────────────║"));
  console.log(`║  1. 交易所连通性测试   ${exCount > 0 ? green(`[${exCount}所]`) : red("[未配置]")}      ║`);
  console.log("║  2. 盘口数据查询                     ║");
  console.log("║  3. 仓位查询                         ║");
  console.log(`║  4. 目标监控测试       ${targetCount > 0 ? green(`[${targetCount}个]`) : red("[未配置]")}      ║`);
  console.log("║  5. 风控检查                         ║");
  console.log(`║  6. Telegram 通知测试  ${tgOk ? green("[已配置]") : red("[未配置]")}      ║`);
  console.log("║  7. 模拟下单 (dry-run)               ║");
  console.log("║  8. 配置查看                         ║");
  console.log("║  q. 退出                             ║");
  console.log(bold("╚══════════════════════════════════════╝"));
}

// ─── 0. Config Management ───────────────────────────────────────
async function configMenu(): Promise<void> {
  while (true) {
    console.log(bold("\n── 配置管理 ──\n"));
    console.log("  1. 全局设置");
    console.log("  2. 交易所 API 配置");
    console.log("  3. Telegram 配置");
    console.log("  4. 跟单目标管理");
    console.log("  5. 保存配置到文件");
    console.log("  0. 返回主菜单");

    const choice = (await ask(cyan("\n请选择: "))).trim();

    switch (choice) {
      case "1": await configGlobal(); break;
      case "2": await configExchanges(); break;
      case "3": await configTelegram(); break;
      case "4": await configTargets(); break;
      case "5":
        saveConfig();
        rebuildAdapters();
        break;
      case "0": return;
      default: console.log(red("无效选择"));
    }
  }
}

async function configGlobal(): Promise<void> {
  console.log(bold("\n── 全局设置 ──\n"));
  console.log(dim(`当前: network=${config.global.network}, totalPositionCap=${config.global.totalPositionCap}, checkIntervalMs=${config.global.checkIntervalMs}\n`));

  const networkInput = await askWithDefault("网络 (mainnet/testnet)", config.global.network);
  if (networkInput === "mainnet" || networkInput === "testnet") {
    config.global.network = networkInput;
  }

  const capStr = await askWithDefault("全局仓位上限 (USDT)", String(config.global.totalPositionCap));
  const cap = parseFloat(capStr);
  if (!isNaN(cap) && cap > 0) config.global.totalPositionCap = cap;

  const intervalStr = await askWithDefault("检查间隔 (ms)", String(config.global.checkIntervalMs));
  const interval = parseInt(intervalStr);
  if (!isNaN(interval) && interval >= 100) config.global.checkIntervalMs = interval;

  console.log(green("\n✓ 全局设置已更新（需保存后生效）"));
}

async function configExchanges(): Promise<void> {
  while (true) {
    console.log(bold("\n── 交易所 API 配置 ──\n"));
    const configured = Object.keys(config.exchanges).filter(
      (k) => config.exchanges[k as keyof typeof config.exchanges],
    );
    console.log(`当前已配置: ${configured.length > 0 ? configured.join(", ") : dim("(无)")}`);
    console.log();
    console.log("  1. 配置 Hyperliquid");
    console.log("  2. 配置 Binance");
    console.log("  3. 配置 OKX");
    console.log("  4. 配置 Bybit");
    console.log("  5. 删除交易所配置");
    console.log("  0. 返回");

    const choice = (await ask(cyan("\n请选择: "))).trim();

    switch (choice) {
      case "1": {
        console.log(bold("\n配置 Hyperliquid\n"));
        const pk = (await ask(cyan("Private Key: "))).trim();
        if (pk) {
          config.exchanges.hyperliquid = { privateKey: pk };
          console.log(green("✓ Hyperliquid 已配置"));
        }
        break;
      }
      case "2": {
        console.log(bold("\n配置 Binance\n"));
        const apiKey = (await ask(cyan("API Key: "))).trim();
        const apiSecret = (await ask(cyan("API Secret: "))).trim();
        if (apiKey && apiSecret) {
          config.exchanges.binance = { apiKey, apiSecret };
          console.log(green("✓ Binance 已配置"));
        }
        break;
      }
      case "3": {
        console.log(bold("\n配置 OKX\n"));
        const apiKey = (await ask(cyan("API Key: "))).trim();
        const apiSecret = (await ask(cyan("API Secret: "))).trim();
        const passphrase = (await ask(cyan("Passphrase: "))).trim();
        if (apiKey && apiSecret && passphrase) {
          config.exchanges.okx = { apiKey, apiSecret, passphrase };
          console.log(green("✓ OKX 已配置"));
        }
        break;
      }
      case "4": {
        console.log(bold("\n配置 Bybit\n"));
        const apiKey = (await ask(cyan("API Key: "))).trim();
        const apiSecret = (await ask(cyan("API Secret: "))).trim();
        if (apiKey && apiSecret) {
          config.exchanges.bybit = { apiKey, apiSecret };
          console.log(green("✓ Bybit 已配置"));
        }
        break;
      }
      case "5": {
        const configured2 = Object.keys(config.exchanges).filter(
          (k) => config.exchanges[k as keyof typeof config.exchanges],
        );
        if (configured2.length === 0) {
          console.log(dim("没有已配置的交易所"));
          break;
        }
        configured2.forEach((k, i) => console.log(`  ${i + 1}. ${k}`));
        const delChoice = (await ask(cyan("删除哪个: "))).trim();
        const delIdx = parseInt(delChoice) - 1;
        if (delIdx >= 0 && delIdx < configured2.length) {
          const key = configured2[delIdx] as keyof typeof config.exchanges;
          delete config.exchanges[key];
          console.log(green(`✓ 已删除 ${configured2[delIdx]}`));
        }
        break;
      }
      case "0": return;
    }
  }
}

async function configTelegram(): Promise<void> {
  console.log(bold("\n── Telegram 配置 ──\n"));
  console.log(dim(`当前: botToken=${mask(config.telegram.botToken)}, chatId=${config.telegram.chatId || dim("(未配置)")}\n`));

  const token = (await ask(cyan("Bot Token (回车跳过): "))).trim();
  if (token) config.telegram.botToken = token;

  const chatId = (await ask(cyan("Chat ID (回车跳过): "))).trim();
  if (chatId) config.telegram.chatId = chatId;

  if (config.telegram.botToken && config.telegram.chatId) {
    const testNow = (await ask(yellow("立即发送测试消息? (y/N): "))).trim().toLowerCase();
    if (testNow === "y") {
      try {
        const notifier = new TelegramNotifier(config.telegram.botToken, config.telegram.chatId);
        await notifier.notifyError("FlipTrader 配置测试 — 通知功能正常 ✓");
        console.log(green("✓ 测试消息已发送"));
      } catch (e: any) {
        console.log(red(`✗ 发送失败: ${e.message}`));
      }
    }
  }

  console.log(green("\n✓ Telegram 设置已更新（需保存后生效）"));
}

async function configTargets(): Promise<void> {
  while (true) {
    console.log(bold("\n── 跟单目标管理 ──\n"));
    if (config.targets.length === 0) {
      console.log(dim("  暂无目标"));
    } else {
      const rows = config.targets.map((t, i) => [
        String(i + 1),
        t.name,
        t.address.slice(0, 10) + "...",
        t.exchange,
        `${t.leverage}x`,
        t.sizeMode,
        String(t.sizeValue),
        t.enabled ? green("启用") : red("禁用"),
      ]);
      printTable(["#", "名称", "地址", "交易所", "杠杆", "模式", "值", "状态"], rows);
    }
    console.log();
    console.log("  1. 添加目标");
    console.log("  2. 编辑目标");
    console.log("  3. 删除目标");
    console.log("  4. 切换启用/禁用");
    console.log("  0. 返回");

    const choice = (await ask(cyan("\n请选择: "))).trim();

    switch (choice) {
      case "1": await addTarget(); break;
      case "2": await editTarget(); break;
      case "3": await deleteTarget(); break;
      case "4": await toggleTarget(); break;
      case "0": return;
      default: console.log(red("无效选择"));
    }
  }
}

async function addTarget(): Promise<void> {
  console.log(bold("\n添加跟单目标\n"));

  const name = (await ask(cyan("名称 (如 whale-1): "))).trim();
  if (!name) { console.log(red("名称不能为空")); return; }
  if (config.targets.some((t) => t.name === name)) {
    console.log(red(`名称 "${name}" 已存在`));
    return;
  }

  const address = (await ask(cyan("Hyperliquid 地址 (0x...): "))).trim();
  if (!address) { console.log(red("地址不能为空")); return; }

  const configured = Object.keys(config.exchanges).filter(
    (k) => config.exchanges[k as keyof typeof config.exchanges],
  );
  if (configured.length === 0) {
    console.log(red("请先配置至少一个交易所 API"));
    return;
  }
  console.log(`可用交易所: ${configured.map((k, i) => `${i + 1}.${k}`).join("  ")}`);
  const exChoice = (await ask(cyan("选择交易所编号: "))).trim();
  const exIdx = parseInt(exChoice) - 1;
  if (isNaN(exIdx) || exIdx < 0 || exIdx >= configured.length) {
    console.log(red("无效选择"));
    return;
  }
  const exchange = configured[exIdx] as ExchangeId;

  const leverage = parseInt(await askWithDefault("杠杆倍数", "10"));
  if (isNaN(leverage) || leverage <= 0) { console.log(red("杠杆必须 > 0")); return; }

  console.log("仓位模式: 1.fixedRatio  2.equalSize  3.fixedAmount");
  const modeChoice = (await askWithDefault("选择", "1")).trim();
  const modeMap: Record<string, SizeMode> = { "1": "fixedRatio", "2": "equalSize", "3": "fixedAmount" };
  const sizeMode = modeMap[modeChoice] ?? "fixedRatio";

  const defaultSizeValue = sizeMode === "fixedRatio" ? "0.1" : sizeMode === "fixedAmount" ? "500" : "1";
  const sizeValue = parseFloat(await askWithDefault("仓位值", defaultSizeValue));
  if (isNaN(sizeValue) || sizeValue <= 0) { console.log(red("仓位值必须 > 0")); return; }

  const perCoinCap = parseFloat(await askWithDefault("单币种上限 (USDT)", "10000"));
  if (isNaN(perCoinCap) || perCoinCap <= 0) { console.log(red("上限必须 > 0")); return; }

  config.targets.push({
    name,
    address,
    exchange,
    leverage,
    sizeMode,
    sizeValue,
    perCoinCap,
    enabled: true,
  });

  console.log(green(`\n✓ 目标 "${name}" 已添加（需保存后生效）`));
}

async function editTarget(): Promise<void> {
  if (config.targets.length === 0) { console.log(dim("暂无目标")); return; }
  config.targets.forEach((t, i) => console.log(`  ${i + 1}. ${t.name}`));
  const idx = parseInt((await ask(cyan("编辑哪个: "))).trim()) - 1;
  if (isNaN(idx) || idx < 0 || idx >= config.targets.length) { console.log(red("无效选择")); return; }

  const t = config.targets[idx];
  console.log(bold(`\n编辑 "${t.name}" (回车保持当前值)\n`));

  const address = (await askWithDefault("地址", t.address)).trim();
  if (address) t.address = address;

  const leverageStr = await askWithDefault("杠杆", String(t.leverage));
  const lev = parseInt(leverageStr);
  if (!isNaN(lev) && lev > 0) t.leverage = lev;

  console.log(`当前模式: ${t.sizeMode}, 值: ${t.sizeValue}`);
  console.log("仓位模式: 1.fixedRatio  2.equalSize  3.fixedAmount");
  const modeChoice = (await askWithDefault("选择", t.sizeMode === "fixedRatio" ? "1" : t.sizeMode === "equalSize" ? "2" : "3")).trim();
  const modeMap: Record<string, SizeMode> = { "1": "fixedRatio", "2": "equalSize", "3": "fixedAmount" };
  if (modeMap[modeChoice]) t.sizeMode = modeMap[modeChoice];

  const svStr = await askWithDefault("仓位值", String(t.sizeValue));
  const sv = parseFloat(svStr);
  if (!isNaN(sv) && sv > 0) t.sizeValue = sv;

  const capStr = await askWithDefault("单币种上限", String(t.perCoinCap));
  const cap = parseFloat(capStr);
  if (!isNaN(cap) && cap > 0) t.perCoinCap = cap;

  console.log(green(`\n✓ 目标 "${t.name}" 已更新（需保存后生效）`));
}

async function deleteTarget(): Promise<void> {
  if (config.targets.length === 0) { console.log(dim("暂无目标")); return; }
  config.targets.forEach((t, i) => console.log(`  ${i + 1}. ${t.name}`));
  const idx = parseInt((await ask(cyan("删除哪个: "))).trim()) - 1;
  if (isNaN(idx) || idx < 0 || idx >= config.targets.length) { console.log(red("无效选择")); return; }
  const name = config.targets[idx].name;
  const confirm = (await ask(yellow(`确认删除 "${name}"? (y/N): `))).trim().toLowerCase();
  if (confirm === "y") {
    config.targets.splice(idx, 1);
    console.log(green(`✓ 已删除 "${name}"`));
  }
}

async function toggleTarget(): Promise<void> {
  if (config.targets.length === 0) { console.log(dim("暂无目标")); return; }
  config.targets.forEach((t, i) => console.log(`  ${i + 1}. ${t.name} — ${t.enabled ? green("启用") : red("禁用")}`));
  const idx = parseInt((await ask(cyan("切换哪个: "))).trim()) - 1;
  if (isNaN(idx) || idx < 0 || idx >= config.targets.length) { console.log(red("无效选择")); return; }
  config.targets[idx].enabled = !config.targets[idx].enabled;
  console.log(green(`✓ "${config.targets[idx].name}" → ${config.targets[idx].enabled ? "启用" : "禁用"}`));
}

// ─── 1. Exchange Connectivity ───────────────────────────────────
async function testConnectivity(): Promise<void> {
  console.log(bold("\n── 交易所连通性测试 ──\n"));
  if (adapters.size === 0) { console.log(red("未配置任何交易所，请先在 [0.配置管理] 中添加")); return; }
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
  if (adapters.size === 0) { console.log(red("未配置任何交易所")); return; }
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
  if (adapters.size === 0) { console.log(red("未配置任何交易所")); return; }
  const totalRows: string[][] = [];

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
    console.log(red("没有启用的 target，请先在 [0.配置管理] 中添加"));
    return;
  }

  targets.forEach((t, i) => console.log(`  ${i + 1}. ${t.name} (${t.address.slice(0, 10)}...)`));
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
  if (!config.telegram.botToken || !config.telegram.chatId) {
    console.log(red("Telegram 未配置，请先在 [0.配置管理] 中设置"));
    return;
  }
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
  if (adapters.size === 0) { console.log(red("未配置任何交易所")); return; }
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

  let book;
  try {
    book = await adapter.getBookTop(symbol);
    console.log(dim(`当前盘口: bid=${book.bid} ask=${book.ask}`));
  } catch (e: any) {
    console.log(red(`获取盘口失败: ${e.message}`));
    return;
  }

  const safePrice = side === "buy"
    ? Math.floor(book.bid * 0.5 * 100) / 100
    : Math.ceil(book.ask * 2 * 100) / 100;
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

  try {
    console.log(dim("\n[1/4] 设置保证金模式..."));
    await adapter.ensureIsolatedMargin(symbol, 1);
    console.log(green("  ✓ 保证金模式已设置"));
  } catch (e: any) {
    console.log(yellow(`  ⚠ ${e.message?.slice(0, 60)} (可能已设置，继续)`));
  }

  let orderId: string;
  try {
    console.log(dim("[2/4] 下单..."));
    orderId = await adapter.placePostOnly(symbol, side, size, safePrice, false);
    console.log(green(`  ✓ 订单已创建: ${orderId}`));
  } catch (e: any) {
    console.log(red(`  ✗ 下单失败: ${e.message}`));
    return;
  }

  try {
    console.log(dim("[3/4] 查询订单状态..."));
    const status = await adapter.getOrderStatus(symbol, orderId);
    console.log(green(`  ✓ 状态: ${status.status}, filled: ${status.filled}, remaining: ${status.remaining}`));
  } catch (e: any) {
    console.log(yellow(`  ⚠ 查询失败: ${e.message?.slice(0, 60)}`));
  }

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

  printTable(["配置项", "值"], [
    ["network", config.global.network],
    ["totalPositionCap", String(config.global.totalPositionCap)],
    ["checkIntervalMs", String(config.global.checkIntervalMs)],
  ]);

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

  console.log(bold("\n跟单目标:"));
  if (config.targets.length > 0) {
    const tRows = config.targets.map((t) => [
      t.name,
      t.address.length > 10 ? t.address.slice(0, 10) + "..." : t.address,
      t.exchange,
      `${t.leverage}x`,
      t.sizeMode,
      String(t.sizeValue),
      String(t.perCoinCap),
      t.enabled ? green("启用") : red("禁用"),
    ]);
    printTable(["名称", "地址", "交易所", "杠杆", "模式", "值", "单币上限", "状态"], tRows);
  } else {
    console.log(dim("  暂无目标"));
  }

  console.log(bold("\nTelegram:"));
  printTable(["配置项", "值"], [
    ["botToken", mask(config.telegram.botToken)],
    ["chatId", config.telegram.chatId || dim("(未配置)")],
  ]);
}

// ─── Main ───────────────────────────────────────────────────────
async function main(): Promise<void> {
  configPath = process.argv[2] ?? "config.yaml";

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  // 尝试加载配置，不存在则用默认空配置
  if (existsSync(configPath)) {
    try {
      config = loadConfig(configPath);
      console.log(green(`\n✓ 已加载配置: ${configPath}`));
    } catch (e: any) {
      console.log(yellow(`\n⚠ 配置文件加载失败: ${e.message}`));
      console.log(dim("使用默认空配置，请在 [0.配置管理] 中设置\n"));
      config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
    }
  } else {
    console.log(yellow(`\n⚠ 未找到 ${configPath}，使用默认空配置`));
    console.log(dim("请先进入 [0.配置管理] 配置交易所 API 和跟单目标\n"));
    config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  rebuildAdapters();

  const isTestnet = config.global.network === "testnet";
  if (isTestnet) {
    console.log(yellow("⚠ TESTNET 模式\n"));
  }

  console.log(bold(`FlipTrader CLI — ${adapters.size} 个交易所, ${config.targets.filter((t) => t.enabled).length} 个目标\n`));

  const handlers: Record<string, () => Promise<void> | void> = {
    "0": configMenu,
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
      console.log(dim("\n再见\n"));
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
      if (choice !== "0") {
        await ask(dim("\n按 Enter 返回菜单..."));
      }
    } else {
      console.log(red("无效选择"));
    }
  }
}

main().catch((e: any) => {
  console.error(red(`fatal: ${e.message}`));
  process.exit(1);
});
