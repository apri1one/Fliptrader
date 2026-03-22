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
