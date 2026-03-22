/**
 * Hyperliquid Monitor Test Script
 *
 * 用法: npx tsx scripts/monitor-test.ts <address>
 * 示例: npx tsx scripts/monitor-test.ts 0x020ca66c30bec2c4fe3861a94e4db4a498a35872
 *
 * 功能:
 *   1. REST 查询当前持仓、挂单、最近成交
 *   2. WebSocket 订阅实时成交推送
 */

import WebSocket from 'ws'

// ─── ANSI Colors ────────────────────────────────────────────────────────────

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const YELLOW = '\x1b[33m'
const CYAN = '\x1b[36m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

// ─── Constants ──────────────────────────────────────────────────────────────

const REST_URL = 'https://api.hyperliquid.xyz/info'
const WS_URL = 'wss://api.hyperliquid.xyz/ws'

// ─── CLI Argument ───────────────────────────────────────────────────────────

const address = process.argv[2]
if (!address) {
  console.error(`${RED}错误: 请提供 Hyperliquid 地址作为参数${RESET}`)
  console.error(`用法: npx tsx scripts/monitor-test.ts <address>`)
  process.exit(1)
}

if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
  console.error(`${RED}错误: 无效的以太坊地址格式${RESET}`)
  process.exit(1)
}

const shortAddr = `${address.slice(0, 6)}...${address.slice(-4)}`

// ─── Helpers ────────────────────────────────────────────────────────────────

async function postInfo(body: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(REST_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`)
  }
  return res.json()
}

function formatNum(n: number | string, decimals = 2): string {
  const v = typeof n === 'string' ? parseFloat(n) : n
  if (Number.isNaN(v)) return String(n)
  return v.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  })
}

function formatUsd(n: number | string): string {
  const v = typeof n === 'string' ? parseFloat(n) : n
  if (Number.isNaN(v)) return String(n)
  const sign = v >= 0 ? '+' : ''
  return `${sign}$${formatNum(Math.abs(v))}`
}

function colorSide(side: string): string {
  return side === 'BUY' || side === 'B'
    ? `${GREEN}${BOLD}BUY${RESET}`
    : `${RED}${BOLD}SELL${RESET}`
}

function normalizeSide(raw: string): 'BUY' | 'SELL' {
  return raw === 'B' || raw.toUpperCase() === 'BUY' ? 'BUY' : 'SELL'
}

function pad(s: string, len: number): string {
  // 需要扣除 ANSI 转义序列的长度来正确对齐
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, '')
  const padding = Math.max(0, len - stripped.length)
  return s + ' '.repeat(padding)
}

function rpad(s: string, len: number): string {
  const stripped = s.replace(/\x1b\[[0-9;]*m/g, '')
  const padding = Math.max(0, len - stripped.length)
  return ' '.repeat(padding) + s
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts)
  return d.toISOString().replace('T', ' ').slice(0, 19)
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  return d.toTimeString().slice(0, 8)
}

function printHeader(): void {
  const line = '═'.repeat(55)
  console.log(`\n${CYAN}${line}${RESET}`)
  console.log(`${CYAN}  Hyperliquid Monitor — ${BOLD}${shortAddr}${RESET}`)
  console.log(`${CYAN}${line}${RESET}\n`)
}

// ─── Table Drawing ──────────────────────────────────────────────────────────

interface Column {
  header: string
  width: number
  align?: 'left' | 'right'
}

function drawTable(columns: Column[], rows: string[][]): void {
  const top =
    '┌' + columns.map((c) => '─'.repeat(c.width + 2)).join('┬') + '┐'
  const mid =
    '├' + columns.map((c) => '─'.repeat(c.width + 2)).join('┼') + '┤'
  const bot =
    '└' + columns.map((c) => '─'.repeat(c.width + 2)).join('┴') + '┘'

  const fmtRow = (cells: string[]) =>
    '│' +
    cells
      .map((cell, i) => {
        const col = columns[i]
        const fn = col.align === 'right' ? rpad : pad
        return ` ${fn(cell, col.width)} `
      })
      .join('│') +
    '│'

  console.log(top)
  console.log(fmtRow(columns.map((c) => `${BOLD}${c.header}${RESET}`)))
  console.log(mid)
  for (const row of rows) {
    console.log(fmtRow(row))
  }
  console.log(bot)
}

// ─── REST: clearinghouseState ───────────────────────────────────────────────

interface Position {
  coin: string
  szi: string
  entryPx: string
  leverage: { type: string; value: number }
  liquidationPx: string | null
  unrealizedPnl: string
  positionValue: string
  marginUsed: string
}

interface AssetPosition {
  position: Position
  type: string
}

interface ClearinghouseState {
  assetPositions: AssetPosition[]
  marginSummary: {
    accountValue: string
    totalMarginUsed: string
    totalNtlPos: string
  }
  crossMarginSummary: {
    accountValue: string
    totalMarginUsed: string
    totalNtlPos: string
  }
}

async function printPositions(): Promise<void> {
  console.log(`${BOLD}${CYAN}当前持仓${RESET}`)

  const data = (await postInfo({
    type: 'clearinghouseState',
    user: address,
  })) as ClearinghouseState

  const positions = data.assetPositions.filter(
    (ap) => parseFloat(ap.position.szi) !== 0,
  )

  if (positions.length === 0) {
    console.log(`${DIM}  (无持仓)${RESET}\n`)
    return
  }

  const columns: Column[] = [
    { header: '品种', width: 8 },
    { header: '方向', width: 8 },
    { header: '数量', width: 12, align: 'right' },
    { header: '入场价', width: 12, align: 'right' },
    { header: '标记价', width: 12, align: 'right' },
    { header: '未实现盈亏', width: 14, align: 'right' },
    { header: '杠杆', width: 6 },
  ]

  const rows = positions.map((ap) => {
    const p = ap.position
    const size = parseFloat(p.szi)
    const side = size > 0 ? 'LONG' : 'SHORT'
    const sideColored =
      size > 0
        ? `${GREEN}${BOLD}LONG${RESET}`
        : `${RED}${BOLD}SHORT${RESET}`
    const pnl = parseFloat(p.unrealizedPnl)
    const pnlStr =
      pnl >= 0
        ? `${GREEN}${formatUsd(pnl)}${RESET}`
        : `${RED}${formatUsd(pnl)}${RESET}`
    const lev = `${p.leverage.value}x`

    // 标记价 ≈ 入场价 + unrealizedPnl / size
    const entryPx = parseFloat(p.entryPx)
    const markPx = size !== 0 ? entryPx + pnl / size : entryPx

    return [
      p.coin,
      sideColored,
      formatNum(Math.abs(size), 4),
      formatNum(entryPx, 2),
      formatNum(markPx, 2),
      pnlStr,
      lev,
    ]
  })

  drawTable(columns, rows)

  // 账户摘要
  const ms = data.marginSummary
  console.log(
    `  ${DIM}账户价值: $${formatNum(ms.accountValue)} | 已用保证金: $${formatNum(ms.totalMarginUsed)} | 持仓名义: $${formatNum(ms.totalNtlPos)}${RESET}`,
  )
  console.log()
}

// ─── REST: openOrders ───────────────────────────────────────────────────────

interface OpenOrder {
  coin: string
  side: string // "B" | "A"
  sz: string
  limitPx: string
  timestamp: number
  oid: number
}

async function printOpenOrders(): Promise<void> {
  const orders = (await postInfo({
    type: 'openOrders',
    user: address,
  })) as OpenOrder[]

  console.log(`${BOLD}${CYAN}当前挂单 (${orders.length})${RESET}`)

  if (orders.length === 0) {
    console.log(`${DIM}  (无挂单)${RESET}\n`)
    return
  }

  const columns: Column[] = [
    { header: '品种', width: 8 },
    { header: '方向', width: 8 },
    { header: '数量', width: 12, align: 'right' },
    { header: '价格', width: 14, align: 'right' },
    { header: '时间', width: 20 },
  ]

  const rows = orders.map((o) => {
    const side = normalizeSide(o.side)
    return [
      o.coin,
      colorSide(side),
      formatNum(o.sz, 4),
      formatNum(o.limitPx, 2),
      formatTimestamp(o.timestamp),
    ]
  })

  drawTable(columns, rows)
  console.log()
}

// ─── REST: userFills ────────────────────────────────────────────────────────

interface Fill {
  coin: string
  side: string // "B" | "A"
  px: string
  sz: string
  time: number
  closedPnl: string
  fee: string
  tid: number
}

async function printRecentFills(): Promise<void> {
  const fills = (await postInfo({
    type: 'userFills',
    user: address,
  })) as Fill[]

  const recent = fills.slice(0, 10)

  console.log(`${BOLD}${CYAN}最近成交 (显示最近 ${recent.length} 笔)${RESET}`)

  if (recent.length === 0) {
    console.log(`${DIM}  (无成交记录)${RESET}\n`)
    return
  }

  const columns: Column[] = [
    { header: '时间', width: 20 },
    { header: '品种', width: 8 },
    { header: '方向', width: 8 },
    { header: '数量', width: 12, align: 'right' },
    { header: '价格', width: 14, align: 'right' },
    { header: '已实现盈亏', width: 14, align: 'right' },
    { header: '手续费', width: 10, align: 'right' },
  ]

  const rows = recent.map((f) => {
    const side = normalizeSide(f.side)
    const pnl = parseFloat(f.closedPnl)
    const pnlStr =
      pnl === 0
        ? `${DIM}$0.00${RESET}`
        : pnl > 0
          ? `${GREEN}${formatUsd(pnl)}${RESET}`
          : `${RED}${formatUsd(pnl)}${RESET}`

    return [
      formatTimestamp(f.time),
      f.coin,
      colorSide(side),
      formatNum(f.sz, 4),
      formatNum(f.px, 2),
      pnlStr,
      `$${formatNum(f.fee, 4)}`,
    ]
  })

  drawTable(columns, rows)
  console.log()
}

// ─── WebSocket: Real-time Fills ─────────────────────────────────────────────

function startWebSocket(): WebSocket {
  console.log(`${YELLOW}正在连接 WebSocket...${RESET}`)

  const ws = new WebSocket(WS_URL)

  ws.on('open', () => {
    console.log(`${GREEN}${BOLD}WebSocket 已连接，正在订阅...${RESET}`)

    const sub = {
      method: 'subscribe',
      subscription: {
        type: 'userFills',
        user: address,
      },
    }
    ws.send(JSON.stringify(sub))
    console.log(
      `${GREEN}已订阅 userFills，等待实时成交...${RESET}\n`,
    )
  })

  ws.on('message', (raw: WebSocket.Data) => {
    try {
      const msg = JSON.parse(raw.toString()) as {
        channel?: string
        data?: {
          isSnapshot?: boolean
          fills?: Fill[]
        }
      }

      // 跳过订阅确认等非数据消息
      if (!msg.channel || !msg.data) return

      // 跳过初始快照
      if (msg.data.isSnapshot) {
        console.log(
          `${DIM}  (收到历史快照，已跳过 ${msg.data.fills?.length ?? 0} 条)${RESET}`,
        )
        return
      }

      const fills = msg.data.fills
      if (!fills || fills.length === 0) return

      for (const f of fills) {
        const side = normalizeSide(f.side)
        const pnl = parseFloat(f.closedPnl)
        const isClose = pnl !== 0
        const time = formatTime(f.time)

        const icon = side === 'BUY' ? '🟢' : '🔴'
        const sideStr =
          side === 'BUY'
            ? `${GREEN}${BOLD}BUY ${RESET}`
            : `${RED}${BOLD}SELL${RESET}`
        const label = isClose
          ? `${RED}CLOSE${RESET}`
          : `${GREEN}OPEN${RESET}`
        const pnlPart = isClose
          ? ` (PnL: ${pnl >= 0 ? GREEN : RED}${formatUsd(pnl)}${RESET})`
          : ''

        console.log(
          `[${time}] ${icon} ${sideStr} ${rpad(formatNum(f.sz, 4), 10)} ${pad(f.coin, 6)} @ ${rpad(formatNum(f.px, 2), 12)} | ${label}${pnlPart}`,
        )
      }
    } catch {
      // 非 JSON 消息，忽略
    }
  })

  ws.on('close', (code: number, reason: Buffer) => {
    console.log(
      `\n${YELLOW}WebSocket 已断开 (code=${code}, reason=${reason.toString()})${RESET}`,
    )
  })

  ws.on('error', (err: Error) => {
    console.error(`${RED}WebSocket 错误: ${err.message}${RESET}`)
  })

  return ws
}

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

let ws: WebSocket | null = null

function shutdown(): void {
  console.log(`\n${YELLOW}正在关闭...${RESET}`)
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.close(1000, 'client shutdown')
  }
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printHeader()

  try {
    await printPositions()
  } catch (err) {
    console.error(
      `${RED}查询持仓失败: ${err instanceof Error ? err.message : err}${RESET}\n`,
    )
  }

  try {
    await printOpenOrders()
  } catch (err) {
    console.error(
      `${RED}查询挂单失败: ${err instanceof Error ? err.message : err}${RESET}\n`,
    )
  }

  try {
    await printRecentFills()
  } catch (err) {
    console.error(
      `${RED}查询成交记录失败: ${err instanceof Error ? err.message : err}${RESET}\n`,
    )
  }

  // 启动 WebSocket 实时监听
  ws = startWebSocket()
}

main().catch((err) => {
  console.error(`${RED}致命错误: ${err instanceof Error ? err.message : err}${RESET}`)
  process.exit(1)
})
