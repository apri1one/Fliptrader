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
import { reverseMapCoin } from "./utils/coinMapping.js";
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

  // Start monitor
  const monitor = new HyperliquidMonitor(enabledTargets);

  // H5: 初始仓位写入 tracker
  monitor.setInitialPositionHandler((targetName, positions) => {
    for (const pos of positions) {
      const side: "B" | "A" = pos.szi > 0 ? "B" : "A";
      tracker.applyFill(targetName, pos.coin, side, Math.abs(pos.szi), pos.entryPx);
      log.info(TAG, `loaded initial position: ${targetName} ${pos.coin} ${pos.szi > 0 ? "LONG" : "SHORT"} ${Math.abs(pos.szi)} @ ${pos.entryPx}`);
    }
  });

  monitor.onFill((event) => {
    orderManager.handleFill(event).catch((e: Error) => {
      log.error(TAG, `handleFill error: ${e.message}`);
      notifier.notifyError(
        `handleFill error for ${event.targetName}: ${e.message}`,
      );
    });
  });

  // 同步自身在各交易所的真实仓位
  for (const [exchangeId, adapter] of adapters) {
    try {
      const positions = await adapter.fetchAllPositions();
      const myKey = `my-${exchangeId}`;
      for (const pos of positions) {
        const hlCoin = reverseMapCoin(pos.symbol);
        const side: "B" | "A" = pos.side === "long" ? "B" : "A";
        const book = await adapter.getBookTop(pos.symbol);
        const price = pos.side === "long" ? book.bid : book.ask;
        tracker.applyFill(myKey, hlCoin, side, pos.size, price);
        log.info(TAG, `synced my position: ${myKey} ${hlCoin} ${pos.side} ${pos.size}`);
      }
    } catch (e: any) {
      log.error(TAG, `failed to sync positions for ${exchangeId}: ${e.message}`);
    }
  }

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
