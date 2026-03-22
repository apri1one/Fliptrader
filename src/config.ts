import { readFileSync } from "fs";
import { parse } from "yaml";

export type SizeMode = "fixedRatio" | "equalSize" | "fixedAmount" | "leverageRatio";
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

const VALID_SIZE_MODES: SizeMode[] = ["fixedRatio", "equalSize", "fixedAmount", "leverageRatio"];
const VALID_EXCHANGES: ExchangeId[] = ["hyperliquid", "binance", "okx", "bybit"];

// S-C1: 解析环境变量引用 ${ENV_VAR}，避免明文存储密钥
function resolveEnvVars(obj: unknown): unknown {
  if (typeof obj === "string") {
    return obj.replace(/\$\{(\w+)\}/g, (match, name) => {
      const val = process.env[name];
      if (val === undefined) {
        throw new Error(`config: environment variable \${${name}} not set`);
      }
      return val;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(resolveEnvVars);
  }
  if (typeof obj === "object" && obj !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value);
    }
    return result;
  }
  return obj;
}

export function parseConfig(yamlStr: string): AppConfig {
  const raw = parse(yamlStr);
  return resolveEnvVars(raw) as AppConfig;
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
  if (!config.global.checkIntervalMs || config.global.checkIntervalMs < 100) {
    throw new Error("config: checkIntervalMs must be >= 100");
  }
  const names = new Set<string>();
  for (const t of config.targets) {
    if (!t.name || typeof t.name !== "string") {
      throw new Error("config: target name must be a non-empty string");
    }
    if (names.has(t.name)) {
      throw new Error(`config: duplicate target name "${t.name}"`);
    }
    names.add(t.name);
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
    if (!t.address || typeof t.address !== "string") {
      throw new Error(`config: invalid address for target "${t.name}"`);
    }
    if (!config.exchanges[t.exchange]) {
      throw new Error(`config: exchange "${t.exchange}" credentials missing for target "${t.name}"`);
    }
  }
}
