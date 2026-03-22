import TelegramBot from "node-telegram-bot-api";
import type { OrderResult } from "../exchange/types.js";
import * as log from "../utils/logger.js";

const TAG = "Telegram";

export class TelegramNotifier {
  private bot: TelegramBot;
  private chatId: string;

  constructor(botToken: string, chatId: string) {
    this.bot = new TelegramBot(botToken);
    this.chatId = chatId;
  }

  async notifyOrder(
    targetName: string,
    coin: string,
    side: "buy" | "sell",
    isOpen: boolean,
    result: OrderResult,
    exchange: string,
  ): Promise<void> {
    const action = isOpen ? "反向开仓" : "反向平仓";
    const sideText = side === "buy" ? "做多" : "做空";
    const statusText = result.status === "filled" ? "已成交" : "部分成交";

    const msg = [
      `📊 *${action}*`,
      `目标: \`${targetName}\``,
      `交易所: ${exchange}`,
      `品种: ${coin}`,
      `方向: ${sideText}`,
      `数量: ${result.filledSize}`,
      `均价: ${result.avgPrice.toFixed(2)}`,
      `状态: ${statusText}`,
    ].join("\n");

    try {
      await this.bot.sendMessage(this.chatId, msg, { parse_mode: "Markdown" });
    } catch (e: any) {
      log.error(TAG, `send failed: ${e.message}`);
    }
  }

  async notifyError(message: string): Promise<void> {
    try {
      await this.bot.sendMessage(this.chatId, `⚠️ *异常*\n${message}`, { parse_mode: "Markdown" });
    } catch (e: any) {
      log.error(TAG, `send failed: ${e.message}`);
    }
  }
}
