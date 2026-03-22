// src/index.ts
import { loadConfig, type ExchangeId } from "./config.js";
import { HyperliquidMonitor } from "./monitor/HyperliquidMonitor.js";
import { PositionTracker } from "./tracker/PositionTracker.js";
import { RiskManager } from "./risk/RiskManager.js";
import { OrderManager } from "./order/OrderManager.js";
import { TelegramNotifier } from "./notify/TelegramNotifier.js";
import { HyperliquidAdapter } from "./exchange/HyperliquidAdapter.js";
import { BinanceAdapter } from "./exchange/BinanceAdapter.js";
import { OKXAdapter } from "./exchange/OKXAdapter.js";
import { BybitAdapter } from "./exchange/BybitAdapter.js";
import type { ExchangeAdapter } from "./exchange/types.js";
import * as log from "./utils/logger.js";

const TAG = "Main";

async function main() {
  const configPath = process.argv[2] ?? "config.yaml";
  log.info(TAG, `loading config from ${configPath}`);
  const config = loadConfig(configPath);

  // Initialize exchange adapters
  const adapters = new Map<ExchangeId, ExchangeAdapter>();

  if (config.exchanges.hyperliquid) {
    adapters.set(
      "hyperliquid",
      new HyperliquidAdapter(config.exchanges.hyperliquid.privateKey),
    );
  }
  if (config.exchanges.binance) {
    adapters.set(
      "binance",
      new BinanceAdapter(
        config.exchanges.binance.apiKey,
        config.exchanges.binance.apiSecret,
      ),
    );
  }
  if (config.exchanges.okx) {
    adapters.set(
      "okx",
      new OKXAdapter(
        config.exchanges.okx.apiKey,
        config.exchanges.okx.apiSecret,
        config.exchanges.okx.passphrase,
      ),
    );
  }
  if (config.exchanges.bybit) {
    adapters.set(
      "bybit",
      new BybitAdapter(
        config.exchanges.bybit.apiKey,
        config.exchanges.bybit.apiSecret,
      ),
    );
  }

  // Validate all target exchanges have adapters
  const enabledTargets = config.targets.filter((t) => t.enabled);
  for (const target of enabledTargets) {
    if (!adapters.has(target.exchange)) {
      throw new Error(
        `exchange "${target.exchange}" not configured but required by target "${target.name}"`,
      );
    }
  }

  // Initialize modules
  const tracker = new PositionTracker();
  const risk = new RiskManager(config.global.totalPositionCap);
  const notifier = new TelegramNotifier(
    config.telegram.botToken,
    config.telegram.chatId,
  );

  const orderManager = new OrderManager(
    adapters,
    enabledTargets,
    tracker,
    risk,
    config.global.checkIntervalMs,
  );

  // Wire order result notifications
  orderManager.setOrderResultHandler((target, coin, result, side, isOpen) => {
    const targetConfig = enabledTargets.find((t) => t.name === target);
    notifier.notifyOrder(
      target,
      coin,
      side,
      isOpen,
      result,
      targetConfig?.exchange ?? "unknown",
    );
  });

  // Start monitor (constructor filters enabled targets internally)
  const monitor = new HyperliquidMonitor(enabledTargets);
  monitor.onFill((event) => {
    orderManager.handleFill(event).catch((e: Error) => {
      log.error(TAG, `handleFill error: ${e.message}`);
      notifier.notifyError(
        `handleFill error for ${event.targetName}: ${e.message}`,
      );
    });
  });

  await monitor.start();

  log.info(
    TAG,
    `hype-bot started, monitoring ${enabledTargets.length} targets`,
  );

  // Graceful shutdown
  const shutdown = () => {
    log.info(TAG, "shutting down...");
    monitor.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e: Error) => {
  log.error(TAG, `fatal: ${e.message}`);
  process.exit(1);
});
