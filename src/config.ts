import { readFileSync } from "fs";
import { parse } from "yaml";

export type SizeMode = "fixedRatio" | "equalSize" | "fixedAmount";
export type ExchangeId = "hyperliquid" | "binance" | "okx" | "bybit";

export interface TargetConfig {
  name: string;
  address: string;
  exchange: ExchangeId;
  leverage: number;
  sizeMode: SizeMode;
  sizeValue: number;
  perCoinCap: number;
  enabled: boolean;
}

export interface AppConfig {
  global: {
    network: "mainnet" | "testnet";
    totalPositionCap: number;
    checkIntervalMs: number;
  };
  exchanges: {
    hyperliquid?: { privateKey: string };
    binance?: { apiKey: string; apiSecret: string };
    okx?: { apiKey: string; apiSecret: string; passphrase: string };
    bybit?: { apiKey: string; apiSecret: string };
  };
  telegram: {
    botToken: string;
    chatId: string;
  };
  targets: TargetConfig[];
}

const VALID_SIZE_MODES: SizeMode[] = ["fixedRatio", "equalSize", "fixedAmount"];
const VALID_EXCHANGES: ExchangeId[] = ["hyperliquid", "binance", "okx", "bybit"];

export function parseConfig(yamlStr: string): AppConfig {
  return parse(yamlStr) as AppConfig;
}

export function loadConfig(path: string): AppConfig {
  const raw = readFileSync(path, "utf-8");
  const config = parseConfig(raw);
  validateConfig(config);
  return config;
}

export function validateConfig(config: AppConfig): void {
  if (!config.targets || config.targets.length === 0) {
    throw new Error("config: targets must have at least one entry");
  }
  for (const t of config.targets) {
    if (!VALID_EXCHANGES.includes(t.exchange)) {
      throw new Error(`config: invalid exchange "${t.exchange}" for target "${t.name}"`);
    }
    if (!VALID_SIZE_MODES.includes(t.sizeMode)) {
      throw new Error(`config: invalid sizeMode "${t.sizeMode}" for target "${t.name}"`);
    }
    if (t.sizeValue <= 0) {
      throw new Error(`config: sizeValue must be > 0 for target "${t.name}"`);
    }
    if (t.perCoinCap <= 0) {
      throw new Error(`config: perCoinCap must be > 0 for target "${t.name}"`);
    }
    if (t.leverage <= 0) {
      throw new Error(`config: leverage must be > 0 for target "${t.name}"`);
    }
    if (!config.exchanges[t.exchange]) {
      throw new Error(`config: exchange "${t.exchange}" credentials missing for target "${t.name}"`);
    }
  }
}
