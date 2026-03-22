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
