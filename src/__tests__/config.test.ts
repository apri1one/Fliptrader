import { describe, it, expect } from "vitest";
import { parseConfig, validateConfig, type AppConfig } from "../config.js";

const VALID_YAML = `
global:
  network: mainnet
  totalPositionCap: 50000
  checkIntervalMs: 1000
exchanges:
  hyperliquid:
    privateKey: "0xabc"
  binance:
    apiKey: "key"
    apiSecret: "secret"
  okx:
    apiKey: "key"
    apiSecret: "secret"
    passphrase: "pass"
  bybit:
    apiKey: "key"
    apiSecret: "secret"
telegram:
  botToken: "token"
  chatId: "123"
targets:
  - name: whale-1
    address: "0xabc0000000000000000000000000000000000001"
    exchange: okx
    leverage: 10
    sizeMode: fixedRatio
    sizeValue: 0.1
    perCoinCap: 10000
    enabled: true
`;

describe("parseConfig", () => {
  it("parses valid YAML into AppConfig", () => {
    const config = parseConfig(VALID_YAML);
    expect(config.global.totalPositionCap).toBe(50000);
    expect(config.targets).toHaveLength(1);
    expect(config.targets[0].exchange).toBe("okx");
  });
});

describe("validateConfig", () => {
  it("throws on missing targets", () => {
    const config = parseConfig(VALID_YAML);
    config.targets = [];
    expect(() => validateConfig(config)).toThrow("targets");
  });

  it("throws on invalid sizeMode", () => {
    const config = parseConfig(VALID_YAML);
    config.targets[0].sizeMode = "invalid" as any;
    expect(() => validateConfig(config)).toThrow("sizeMode");
  });

  it("throws on invalid exchange", () => {
    const config = parseConfig(VALID_YAML);
    config.targets[0].exchange = "kraken" as any;
    expect(() => validateConfig(config)).toThrow("exchange");
  });

  it("passes valid config", () => {
    const config = parseConfig(VALID_YAML);
    expect(() => validateConfig(config)).not.toThrow();
  });
});
