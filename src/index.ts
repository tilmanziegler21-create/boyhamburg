import 'dotenv/config';
import { logger } from "./infra/logger";
import { startHttpServer } from "./server/http";
import { startBot } from "./bot/Bot";
import { initDb } from "./infra/db/sqlite";
import { registerCron } from "./infra/cron/scheduler";
import { getDefaultCity } from "./infra/backend";
import { validateSheetsSchemaOrThrow } from "./infra/sheets/SchemaValidator";
import { useSheets } from "./infra/config";

async function main() {
  await initDb();
  if (useSheets) {
    const city = getDefaultCity();
    await validateSheetsSchemaOrThrow(city);
  }
  await startHttpServer();
  await startBot();
  await registerCron();
  logger.info("App started");
}

main().catch((e) => {
  logger.error("Fatal", { error: String(e) });
  process.exit(1);
});
