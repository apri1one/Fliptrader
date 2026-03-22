/**
 * Dry Run — 反向跟单逻辑验证
 *
 * 用法: npx tsx scripts/dry-run.ts <address> [options]
 * 示例: npx tsx scripts/dry-run.ts 0x020ca66c30bec2c4fe3861a94e4db4a498a35872
 *
 * 选项:
 *   --exchange <name>    目标交易所 (默认: okx)
 *   --mode <mode>        仓位模式: fixedRatio | equalSize | fixedAmount (默认: fixedRatio)
 *   --value <n>          仓位值 (默认: 0.1)
 *   --leverage <n>       杠杆 (默认: 10)
 *   --per-coin-cap <n>   单品种硬顶 USDC (默认: 10000)
 *   --total-cap <n>      总仓位硬顶 USDC (默认: 50000)
 *
 * 不会实际下单，只打印模拟决策。
 */

import WebSocket from "ws";

// ─── ANSI Colors ────────────────────────────────────────────────────────────
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const BG_GREEN = "\x1b[42m\x1b[30m";
const BG_RED = "\x1b[41m\x1b[37m";
const BG_YELLOW = "\x1b[43m\x1b[30m";

// ─── Constants ──────────────────────────────────────────────────────────────
const HL_INFO_URL = "https://api.hyperliquid.xyz/info";
const HL_WS_URL = "wss://api.hyperliquid.xyz/ws";

// ─── 币种映射 ───────────────────────────────────────────────────────────────
const EXCHANGE_SYMBOL_MAP: Record<string, (coin: string) => string> = {
  hyperliquid: (coin) => `${coin}/USDC:USDC`,
  binance: (coin) => `${coin}/USDT:USDT`,
  okx: (coin) => `${coin}/USDT:USDT`,
  bybit: (coin) => `${coin}/USDT:USDT`,
};

// ─── CLI 参数解析 ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const address = args.find((a) => a.startsWith("0x"));

if (!address) {
  console.error("Usage: npx tsx scripts/dry-run.ts <address> [options]");
  process.exit(1);
}

function getArg(flag: string, defaultVal: string): string {
  const idx = args.indexOf(flag);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : defaultVal;
}

const config = {
  exchange: getArg("--exchange", "okx"),
  sizeMode: getArg("--mode", "fixedRatio") as "fixedRatio" | "equalSize" | "fixedAmount",
  sizeValue: parseFloat(getArg("--value", "0.1")),
  leverage: parseInt(getArg("--leverage", "10")),
  perCoinCap: parseFloat(getArg("--per-coin-cap", "10000")),
  totalCap: parseFloat(getArg("--total-cap", "50000")),
};

const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`;

// ─── Position Tracker (简化内联版) ──────────────────────────────────────────
const myPositions = new Map<string, { rawSize: number; lastPrice: number }>();

function applyMyFill(coin: string, side: "buy" | "sell", size: number, price: number) {
  const current = myPositions.get(coin) ?? { rawSize: 0, lastPrice: price };
  const delta = side === "buy" ? size : -size;
  current.rawSize += delta;
  current.lastPrice = price;
  if (Math.abs(current.rawSize) < 1e-12) {
    myPositions.delete(coin);
  } else {
    myPositions.set(coin, current);
  }
}

function getMyCoinNotional(coin: string): number {
  const pos = myPositions.get(coin);
  if (!pos) return 0;
  return Math.abs(pos.rawSize) * pos.lastPrice;
}

function getMyTotalNotional(): number {
  let total = 0;
  for (const [, pos] of myPositions) {
    total += Math.abs(pos.rawSize) * pos.lastPrice;
  }
  return total;
}

// ─── 计算下单量 ─────────────────────────────────────────────────────────────
function calcOrderSize(fillSize: number, price: number): number {
  switch (config.sizeMode) {
    case "fixedRatio":
      return fillSize * config.sizeValue;
    case "equalSize":
      return fillSize;
    case "fixedAmount":
      return config.sizeValue / price;
  }
}

// ─── 风控检查 ────────────────────────────────────────────────────────────────
interface RiskResult {
  allowed: boolean;
  adjustedSize: number;
  reason?: string;
}

function checkRisk(coin: string, orderSize: number, price: number): RiskResult {
  const orderNotional = orderSize * price;
  const currentCoinNotional = getMyCoinNotional(coin);
  const currentTotalNotional = getMyTotalNotional();
  const coinRemaining = config.perCoinCap - currentCoinNotional;
  const totalRemaining = config.totalCap - currentTotalNotional;

  if (coinRemaining <= 0) {
    return { allowed: false, adjustedSize: 0, reason: `品种硬顶已满 (${currentCoinNotional.toFixed(0)}/${config.perCoinCap})` };
  }
  if (totalRemaining <= 0) {
    return { allowed: false, adjustedSize: 0, reason: `总硬顶已满 (${currentTotalNotional.toFixed(0)}/${config.totalCap})` };
  }

  let adjustedNotional = orderNotional;
  let truncated = false;

  if (currentCoinNotional + adjustedNotional > config.perCoinCap) {
    adjustedNotional = coinRemaining;
    truncated = true;
  }
  if (currentTotalNotional + adjustedNotional > config.totalCap) {
    adjustedNotional = totalRemaining;
    truncated = true;
  }

  return {
    allowed: true,
    adjustedSize: adjustedNotional / price,
    reason: truncated ? "截断到硬顶" : undefined,
  };
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function formatUsd(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function nowTime(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

function printMyPositions() {
  if (myPositions.size === 0) {
    console.log(`  ${DIM}(无模拟持仓)${RESET}`);
    return;
  }
  for (const [coin, pos] of myPositions) {
    const side = pos.rawSize > 0 ? "LONG" : "SHORT";
    const sideColor = pos.rawSize > 0 ? GREEN : RED;
    const notional = Math.abs(pos.rawSize) * pos.lastPrice;
    console.log(
      `  ${coin}: ${sideColor}${BOLD}${side}${RESET} ${Math.abs(pos.rawSize).toFixed(4)} @ ${pos.lastPrice.toFixed(2)} (名义: $${notional.toFixed(2)})`
    );
  }
}

// ─── 处理成交事件 ────────────────────────────────────────────────────────────
let fillCount = 0;

function handleFill(fill: any) {
  fillCount++;
  const price = parseFloat(fill.px);
  const fillSize = parseFloat(fill.sz);
  const pnl = parseFloat(fill.closedPnl);
  const isOpen = pnl === 0;

  // 目标动作
  const targetSide = fill.side === "B" ? "BUY" : "SELL";
  const targetIcon = fill.side === "B" ? "🟢" : "🔴";

  // 我方反向
  const reverseSide: "buy" | "sell" = fill.side === "B" ? "sell" : "buy";
  const reverseLabel = reverseSide === "buy" ? "做多" : "做空";
  const reverseColor = reverseSide === "buy" ? GREEN : RED;

  // 计算下单量
  let orderSize = calcOrderSize(fillSize, price);
  const symbol = EXCHANGE_SYMBOL_MAP[config.exchange](fill.coin);

  console.log(`\n${DIM}${"─".repeat(70)}${RESET}`);
  console.log(`${DIM}[${nowTime()}]${RESET} ${BOLD}信号 #${fillCount}${RESET}`);

  // 打印目标动作
  console.log(
    `  ${targetIcon} 目标 ${targetSide} ${fillSize.toFixed(4)} ${fill.coin} @ ${price.toFixed(2)} | ${isOpen ? `${CYAN}开仓${RESET}` : `${YELLOW}平仓${RESET} (PnL: ${pnl >= 0 ? GREEN : RED}${formatUsd(pnl)}${RESET})`}`
  );

  // 风控检查（只对开仓检查）
  if (isOpen) {
    const risk = checkRisk(fill.coin, orderSize, price);

    if (!risk.allowed) {
      console.log(`  ${BG_RED} 风控拒绝 ${RESET} ${risk.reason}`);
      console.log(`  ${DIM}不下单${RESET}`);
      return;
    }

    if (risk.reason) {
      console.log(`  ${BG_YELLOW} 风控截断 ${RESET} ${risk.reason}: ${orderSize.toFixed(4)} → ${risk.adjustedSize.toFixed(4)}`);
      orderSize = risk.adjustedSize;
    }
  }

  const notional = orderSize * price;

  // 打印模拟下单
  console.log(
    `  ${reverseColor}${BOLD}▶ 模拟下单${RESET} ${reverseColor}${reverseLabel}${RESET} ${orderSize.toFixed(4)} ${fill.coin} on ${MAGENTA}${config.exchange.toUpperCase()}${RESET}`
  );
  console.log(
    `    符号: ${symbol} | 杠杆: ${config.leverage}x 逐仓 | 名义: $${notional.toFixed(2)} | ${isOpen ? "开仓" : "平仓(reduceOnly)"}`
  );
  console.log(
    `    下单方式: ${config.exchange === "okx" ? "OKX 原生 chase 算法单" : "追逐限价 (post-only bid1/ask1, 每秒重挂)"}`
  );

  // 模拟成交，更新持仓
  applyMyFill(fill.coin, reverseSide, orderSize, price);

  // 打印当前模拟持仓
  console.log(`  ${DIM}── 我的模拟持仓 ──${RESET}`);
  printMyPositions();
  console.log(`  ${DIM}总名义: $${getMyTotalNotional().toFixed(2)} / $${config.totalCap}${RESET}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${BOLD}${CYAN}${"═".repeat(60)}${RESET}`);
  console.log(`${BOLD}${CYAN}  Dry Run — 反向跟单模拟${RESET}`);
  console.log(`${BOLD}${CYAN}${"═".repeat(60)}${RESET}\n`);

  console.log(`${BOLD}配置:${RESET}`);
  console.log(`  目标地址:     ${shortAddr}`);
  console.log(`  交易所:       ${MAGENTA}${config.exchange.toUpperCase()}${RESET}`);
  console.log(`  仓位模式:     ${config.sizeMode} = ${config.sizeValue}`);
  console.log(`  杠杆:         ${config.leverage}x 逐仓`);
  console.log(`  单品种硬顶:   $${config.perCoinCap.toLocaleString()}`);
  console.log(`  总仓位硬顶:   $${config.totalCap.toLocaleString()}`);
  console.log(`  下单方式:     ${config.exchange === "okx" ? "OKX 原生 chase" : "追逐限价"}`);

  // 先拉取目标当前持仓
  console.log(`\n${BOLD}目标当前持仓:${RESET}`);
  try {
    const res = await fetch(HL_INFO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "clearinghouseState", user: address }),
    });
    const data = await res.json() as any;
    const positions = (data.assetPositions ?? []).filter(
      (ap: any) => parseFloat(ap.position.szi) !== 0
    );
    if (positions.length === 0) {
      console.log(`  ${DIM}(无持仓)${RESET}`);
    } else {
      for (const ap of positions) {
        const p = ap.position;
        const szi = parseFloat(p.szi);
        const side = szi > 0 ? "LONG" : "SHORT";
        const sideColor = szi > 0 ? GREEN : RED;
        console.log(
          `  ${p.coin}: ${sideColor}${BOLD}${side}${RESET} ${Math.abs(szi).toFixed(4)} @ ${parseFloat(p.entryPx).toFixed(2)} | ${p.leverage.value}x`
        );
      }
    }
  } catch (e: any) {
    console.error(`  ${RED}查询失败: ${e.message}${RESET}`);
  }

  // 启动 WebSocket
  startWs();
}

let currentWs: WebSocket | null = null;

function startWs() {
  console.log(`\n${YELLOW}连接 WebSocket...${RESET}`);

  const ws = new WebSocket(HL_WS_URL);
  currentWs = ws;

  ws.on("open", () => {
    console.log(`${GREEN}${BOLD}✓ 已连接${RESET}`);
    ws.send(JSON.stringify({
      method: "subscribe",
      subscription: { type: "userFills", user: address },
    }));
    console.log(`${GREEN}✓ 已订阅 userFills${RESET}`);
    console.log(`\n${BOLD}等待目标成交信号... (Ctrl+C 退出)${RESET}`);
  });

  ws.on("message", (raw: Buffer) => {
    try {
      const msg = JSON.parse(raw.toString());
      if (msg.channel !== "userFills") return;
      if (msg.data?.isSnapshot) {
        console.log(`${DIM}(收到历史快照 ${msg.data.fills?.length ?? 0} 条，跳过)${RESET}`);
        return;
      }
      for (const fill of msg.data?.fills ?? []) {
        handleFill(fill);
      }
    } catch {
      // ignore
    }
  });

  ws.on("close", () => {
    console.log(`\n${YELLOW}WebSocket 断开，3秒后重连...${RESET}`);
    setTimeout(() => startWs(), 3000);
  });

  ws.on("error", (err) => {
    console.error(`${RED}WebSocket 错误: ${err.message}${RESET}`);
  });
}

process.on("SIGINT", () => {
  console.log(`\n\n${BOLD}${"═".repeat(60)}${RESET}`);
  console.log(`${BOLD}  Dry Run 结束 — 共处理 ${fillCount} 个信号${RESET}`);
  console.log(`${BOLD}${"═".repeat(60)}${RESET}`);
  console.log(`\n${BOLD}最终模拟持仓:${RESET}`);
  printMyPositions();
  console.log(`${BOLD}总名义: $${getMyTotalNotional().toFixed(2)} / $${config.totalCap}${RESET}\n`);
  currentWs?.close();
  process.exit(0);
});

main().catch((e) => {
  console.error(`${RED}致命错误: ${e.message}${RESET}`);
  process.exit(1);
});
