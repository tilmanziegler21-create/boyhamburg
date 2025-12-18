import express from "express";
import { logger } from "../infra/logger";
import { getQtyReservedSnapshot } from "../domain/inventory/InventoryService";
import { env, useSheets } from "../infra/config";
import { testSheetsAuth } from "../infra/sheets/SheetsClient";

export async function startHttpServer() {
  const app = express();
  app.get("/health", (_req, res) => {
    const sheetsStatus = useSheets ? (testSheetsAuth() ? "OK" : "FAIL") : "DISABLED";
    res.json({ ok: true, backend: env.DATA_BACKEND, sheets_auth: sheetsStatus });
  });
  app.get("/metrics", (_req, res) => {
    res.json({ qty_reserved: getQtyReservedSnapshot() });
  });
  const port = process.env.PORT ? Number(process.env.PORT) : 3000;
  app.listen(port, () => logger.info("HTTP server started", { port }));
}
