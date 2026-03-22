import { describe, it, expect } from "vitest";
import { RiskManager } from "../risk/RiskManager.js";

describe("RiskManager", () => {
  it("allows order within limits", () => {
    const rm = new RiskManager(50000);
    const result = rm.check({
      coin: "BTC",
      orderNotional: 5000,
      currentCoinNotional: 0,
      perCoinCap: 10000,
      currentTotalNotional: 0,
    });
    expect(result.allowed).toBe(true);
    expect(result.adjustedNotional).toBe(5000);
  });

  it("truncates to per-coin cap", () => {
    const rm = new RiskManager(50000);
    const result = rm.check({
      coin: "BTC",
      orderNotional: 8000,
      currentCoinNotional: 6000,
      perCoinCap: 10000,
      currentTotalNotional: 6000,
    });
    expect(result.allowed).toBe(true);
    expect(result.adjustedNotional).toBe(4000);
  });

  it("truncates to total cap", () => {
    const rm = new RiskManager(50000);
    const result = rm.check({
      coin: "ETH",
      orderNotional: 20000,
      currentCoinNotional: 0,
      perCoinCap: 30000,
      currentTotalNotional: 40000,
    });
    expect(result.allowed).toBe(true);
    expect(result.adjustedNotional).toBe(10000);
  });

  it("rejects when coin cap already reached", () => {
    const rm = new RiskManager(50000);
    const result = rm.check({
      coin: "BTC",
      orderNotional: 1000,
      currentCoinNotional: 10000,
      perCoinCap: 10000,
      currentTotalNotional: 10000,
    });
    expect(result.allowed).toBe(false);
  });

  it("rejects when total cap already reached", () => {
    const rm = new RiskManager(50000);
    const result = rm.check({
      coin: "BTC",
      orderNotional: 1000,
      currentCoinNotional: 0,
      perCoinCap: 10000,
      currentTotalNotional: 50000,
    });
    expect(result.allowed).toBe(false);
  });
});
