import TelegramBot from "node-telegram-bot-api";
import { env } from "../infra/config";
import { logger } from "../infra/logger";
import { registerClientFlow } from "./flows/clientFlow";
import { registerCourierFlow } from "./flows/courierFlow";
import { registerAdminFlow } from "./flows/adminFlow";

let bot: TelegramBot;

export async function startBot() {
  bot = new TelegramBot(env.TELEGRAM_BOT_TOKEN, { polling: true });
  registerClientFlow(bot);
  registerCourierFlow(bot);
  registerAdminFlow(bot);
  logger.info("Bot started");
}

export function getBot() {
  return bot;
}
