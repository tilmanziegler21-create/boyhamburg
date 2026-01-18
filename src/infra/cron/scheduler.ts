import cron from "node-cron";
import { getDb } from "../db/sqlite";
import { expireOrder } from "../../domain/orders/OrderService";
import { computeDailyMetrics, writeDailyMetricsRow } from "../../domain/metrics/MetricsService";
import { formatDate } from "../../core/time";
import { logger } from "../logger";
import { getBot } from "../../bot/Bot";
import { updateUser } from "../data";
import { getBackend, getDefaultCity } from "../backend";
import { purgeNotIssuedOlderThan } from "../../domain/orders/OrderService";
import { NOT_ISSUED_DELETE_AFTER_MINUTES } from "../../core/constants";
import { shopConfig } from "../../config/shopConfig";
import { ReportService } from "../../services/ReportService";
import { batchGet } from "../sheets/SheetsClient";
import { getProducts } from "../data";

export async function generateDailySummaryText(): Promise<string> {
  const db = getDb();
  const today = new Date().toISOString().slice(0, 10);
  const start = Date.parse(`${today}T00:00:00.000Z`);
  const end = start + 86400000;
  const rs = new ReportService();
  const report = await rs.getTodayReport(shopConfig.cityCode);
  const pay = db
    .prepare(
      "SELECT payment_method, SUM(total_with_discount) AS sum FROM orders WHERE status='delivered' AND ((delivered_at_ms >= ? AND delivered_at_ms < ?) OR (delivered_at_ms IS NULL AND substr(delivered_timestamp,1,10)=?)) GROUP BY payment_method"
    )
    .all(start, end, today) as any[];
  const cash = Number(
    (pay.find((x) => String(x.payment_method || "").toLowerCase() === "cash")?.sum) || 0
  );
  const card = Number(
    (pay.find((x) => String(x.payment_method || "").toLowerCase() === "card")?.sum) || 0
  );
  let upsellOffered = 0,
    upsellAccepted = 0,
    upsellRerolls = 0,
    upsellRevenue = 0;
  try {
    const offeredRows = db
      .prepare(
        "SELECT COUNT(1) AS c FROM upsell_events WHERE event_type='offered' AND timestamp >= ? AND timestamp < ?"
      )
      .get(start, end) as any;
    const acceptedRows = db
      .prepare(
        "SELECT COUNT(1) AS c FROM upsell_events WHERE event_type='accepted' AND timestamp >= ? AND timestamp < ?"
      )
      .get(start, end) as any;
    const rerollRows = db
      .prepare(
        "SELECT COUNT(1) AS c FROM upsell_events WHERE event_type='reroll' AND timestamp >= ? AND timestamp < ?"
      )
      .get(start, end) as any;
    upsellOffered = Number(offeredRows?.c || 0);
    upsellAccepted = Number(acceptedRows?.c || 0);
    upsellRerolls = Number(rerollRows?.c || 0);
    const rows = db
      .prepare(
        "SELECT items_json FROM orders WHERE status='delivered' AND ((delivered_at_ms >= ? AND delivered_at_ms < ?) OR (delivered_at_ms IS NULL AND substr(delivered_timestamp,1,10)=?))"
      )
      .all(start, end, today) as any[];
    for (const r of rows) {
      const items = JSON.parse(String(r.items_json || "[]"));
      for (const i of items) if (i.is_upsell) upsellRevenue += Number(i.price) * Number(i.qty || 1);
    }
  } catch {}
  const effectiveOffers = Math.max(upsellOffered - upsellRerolls, 1);
  const conv = Math.round((upsellAccepted / effectiveOffers) * 1000) / 10;
  const itemsBlock =
    Object.entries(report.itemsSold || {})
      .map(([name, count]) => `• ${name}: ${count} шт`)
      .join("\n") || "(нет данных)";
  const summary = [
    `📊 Отчёт за сегодня (${report.date})`,
    ``,
    `🏪 Магазин: ${shopConfig.shopName}`,
    `🏙 Город: ${shopConfig.cityCode}`,
    `📦 Заказов: ${report.orders}`,
    `💰 Выручка: ${report.revenue.toFixed(2)}€`,
    `💵 Доля (5%): ${report.yourShare.toFixed(2)}€`,
    `🔥 Топ товар: ${report.topItem}`,
    ``,
    `💳 Способы оплаты:`,
    `Cash: ${cash.toFixed(2)}€`,
    `Card: ${card.toFixed(2)}€`,
    ``,
    `🎲 Upsell (геймификация):`,
    `Предложено: ${upsellOffered}`,
    `Рероллов: ${upsellRerolls}`,
    `Принято: ${upsellAccepted}`,
    `Конверсия: ${conv}%`,
    `Доп. выручка: ${upsellRevenue.toFixed(2)}€`,
    ``,
    `📦 Продано товаров:`,
    `${itemsBlock}`,
  ].join("\n");
  return summary;
}

export async function sendDailySummary() {
  try {
    const bot = getBot();
    const summary = await generateDailySummaryText();
    const adminIds = (process.env.TELEGRAM_ADMIN_IDS || "")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((x) => x);
    for (const id of adminIds) {
      try {
        await bot.sendMessage(id, summary);
      } catch {}
    }
    try {
      const city = shopConfig.cityCode;
      const sheet = (process.env.GOOGLE_SHEETS_MODE === "TABS_PER_CITY") ? `orders_${city}` : "orders";
      const vr = await batchGet([`${sheet}!A:Z`]);
      const values = vr[0]?.values || [];
      const headers = values[0] || [];
      const rows = values.slice(1);
      const idx = (name: string) => headers.indexOf(name);
      const deliveredAtIdx = (idx("delivered_at") >= 0 ? idx("delivered_at") : idx("delivered_timestamp"));
      const statusIdx = idx("status");
      const itemsIdx = idx("items_json");
      const today = new Date().toISOString().slice(0,10);
      const deliveredRows = rows.filter(r => {
        const d = String(deliveredAtIdx>=0 ? r[deliveredAtIdx]||"" : "").slice(0,10);
        const st = String(statusIdx>=0 ? r[statusIdx]||"" : "").toLowerCase();
        return d===today && st==="delivered";
      });
      const products = await getProducts();
      const map: Record<number, { qty: number; sum: number; title: string; brand: string }> = {};
      for (const r of deliveredRows) {
        const itemsJson = String(itemsIdx>=0 ? r[itemsIdx]||"[]" : "[]");
        try {
          const items = JSON.parse(itemsJson) as Array<{ product_id: number; qty: number; price: number }>;
          for (const it of items) {
            const p = products.find(x=>x.product_id===it.product_id);
            const key = it.product_id;
            const cur = map[key] || { qty: 0, sum: 0, title: p ? p.title : `#${key}`, brand: p?.brand || "" };
            cur.qty += Number(it.qty||0);
            cur.sum += Number(it.price||0) * Number(it.qty||0);
            map[key] = cur;
          }
        } catch {}
      }
      const sorted = Object.entries(map).sort((a,b)=>b[1].qty - a[1].qty);
      const lines: string[] = [];
      lines.push("📦 Продажи (доставленные)");
      lines.push("");
      for (const [, v] of sorted.slice(0, 20)) {
        const brandPart = v.brand ? `${v.brand} · ` : "";
        lines.push(`• ${brandPart}${v.title} — ${v.qty} шт · ${(v.sum).toFixed(2)}€`);
      }
      if (sorted.length) {
        const top = sorted[0][1];
        const brandPart = top.brand ? `${top.brand} · ` : "";
        lines.push("");
        lines.push(`🔥 Топ вкус: ${brandPart}${top.title} — ${top.qty} шт`);
      }
      const detail = lines.join("\n");
      for (const id of adminIds) {
        try { await bot.sendMessage(id, detail); } catch {}
      }
    } catch (e) {
      logger.warn("Daily detail summary error", { error: String(e) });
    }
  } catch (e) {
    logger.error("Admin daily report error", { error: String(e) });
  }
}

export async function registerCron() {
  const timezone = "Europe/Berlin";
  cron.schedule("*/1 * * * *", async () => {
    const db = getDb();
    const nowIso = new Date().toISOString();
    const rows = db.prepare("SELECT order_id FROM orders WHERE status='buffer' AND expiry_timestamp < ?").all(nowIso) as any[];
    for (const r of rows) await expireOrder(Number(r.order_id));
  }, { timezone });

  cron.schedule("0 10 * * *", async () => {
    const db = getDb();
    const users = db.prepare("SELECT user_id FROM users WHERE next_reminder_date = ?").all(formatDate(new Date())) as any[];
    const bot = getBot();
    for (const u of users) {
      try {
        db.prepare("UPDATE users SET segment = ? WHERE user_id = ?").run("sale10", Number(u.user_id));
        try { await updateUser(Number(u.user_id), { segment: "sale10" } as any); } catch {}
        await bot.sendMessage(Number(u.user_id), "🔔 Напоминание: время повторить заказ! Скидка 10% на все жидкости по ссылке ниже. Нажмите, чтобы начать.");
      } catch {}
    }
  }, { timezone });

  cron.schedule("5 10 * * *", async () => {
    const db = getDb();
    const bot = getBot();
    const target = formatDate(new Date(Date.now() - 3 * 86400000));
    const rows = db.prepare("SELECT user_id FROM users WHERE last_purchase_date IS NULL AND first_seen = ?").all(target) as any[];
    for (const r of rows) {
      try { await bot.sendMessage(Number(r.user_id), "👋 Возвращайтесь — посмотрите каталог и соберите заказ. Жидкости ELFIC/CHASER и электроника. Нажмите /start или кнопку ниже."); } catch {}
    }
  }, { timezone });

  cron.schedule("0 22 * * *", async () => {
    await sendDailySummary();
  }, { timezone });

  cron.schedule("0 0 * * *", async () => {
    try {
      const date = formatDate(new Date());
      const row = await computeDailyMetrics(date);
      await writeDailyMetricsRow(row);
      const backend = getBackend();
      for (const city of (process.env.CITY_CODES || "FFM").split(",")) {
        await backend.upsertDailyMetrics(date, city.trim(), row);
      }
      logger.info("Metrics written", { date });
    } catch (e) {
      logger.error("Metrics error", { error: String(e) });
    }
  }, { timezone });

  cron.schedule("0 0 * * *", async () => {
    const db = getDb();
    try {
      db.prepare("UPDATE orders SET delivery_exact_time = NULL WHERE status <> 'delivered'").run();
      logger.info("Daily slot cleanup done");
    } catch (e) {
      logger.error("Daily slot cleanup error", { error: String(e) });
    }
  }, { timezone });

  cron.schedule("*/5 * * * *", async () => {
    try {
      const db = getDb();
      const rows = db.prepare("SELECT order_id FROM orders WHERE status='delivered' AND sheets_committed=0").all() as any[];
      const backend = getBackend();
      logger.info("Repair job", { pending: rows.length });
      for (const r of rows) {
        try {
          await backend.commitDelivery(Number(r.order_id));
          db.prepare("UPDATE orders SET sheets_committed=1 WHERE order_id = ?").run(Number(r.order_id));
        } catch (e) {
          logger.warn("Repair commit failed", { order_id: r.order_id, error: String(e) });
        }
      }
    } catch (e) {
      logger.error("Repair job error", { error: String(e) });
    }
  }, { timezone });

  cron.schedule("*/10 * * * *", async () => {
    try {
      const n = await purgeNotIssuedOlderThan(NOT_ISSUED_DELETE_AFTER_MINUTES);
      if (n > 0) logger.info("Purged not_issued orders", { count: n });
    } catch (e) {
      logger.error("Purge not_issued error", { error: String(e) });
    }
  }, { timezone });

  cron.schedule("0 * * * *", async () => {
    try {
      const db = getDb();
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const rows = db.prepare("SELECT order_id FROM orders WHERE status='pending' AND reserve_timestamp < ?").all(cutoff) as any[];
      const sheet = (process.env.GOOGLE_SHEETS_MODE === "TABS_PER_CITY") ? `orders_${shopConfig.cityCode}` : "orders";
      const { batchGet } = await import("../sheets/SheetsClient");
      const { google } = await import("googleapis");
      const api = google.sheets({ version: "v4" });
      const values = (await batchGet([`${sheet}!A:Z`]))[0]?.values || [];
      const headers = values[0] || [];
      const idx = (n: string) => headers.indexOf(n);
      const idIdx = idx("order_id"), statusIdx = idx("status"), cancelledAtIdx = idx("cancelled_at"), cancelledReasonIdx = idx("cancelled_reason");
      const updated: number[] = [];
      const tx = db.transaction(() => {
        for (const r of rows) {
          db.prepare("UPDATE orders SET status='cancelled' WHERE order_id=?").run(Number(r.order_id));
          updated.push(Number(r.order_id));
        }
      });
      tx();
      if (updated.length && idIdx >= 0) {
        for (let i = 1; i < values.length; i++) {
          const oid = Number(values[i][idIdx]);
          if (updated.includes(oid)) {
            const row = [...values[i]];
            if (statusIdx >= 0) row[statusIdx] = "cancelled";
            if (cancelledAtIdx >= 0) row[cancelledAtIdx] = new Date().toISOString();
            if (cancelledReasonIdx >= 0) row[cancelledReasonIdx] = "auto_expired";
            await api.spreadsheets.values.update({
              spreadsheetId: process.env.GOOGLE_SHEETS_SPREADSHEET_ID!,
              range: `${sheet}!A${i + 1}:Z${i + 1}`,
              valueInputOption: "RAW",
              requestBody: { values: [row] }
            });
          }
        }
      }
      if (updated.length) logger.info("Auto-cancelled expired pending orders", { count: updated.length });
    } catch (e) {
      logger.error("Auto-cancel expired error", { error: String(e) });
    }
  }, { timezone });

  cron.schedule("*/15 * * * *", async () => {
    try {
      const db = getDb();
      const backend = getBackend();
      const today = new Date().toISOString().slice(0,10);
      const dayAfter = new Date(Date.now() + 2 * 86400000).toISOString().slice(0,10);
      const rows = db.prepare("SELECT order_id, items_json FROM orders WHERE status IN ('pending','confirmed','courier_assigned') AND delivery_date >= ? AND delivery_date <= ?").all(today, dayAfter) as any[];
      for (const r of rows) {
        try {
          await backend.updateOrderDetails?.(Number(r.order_id), { items: String(r.items_json || "[]") } as any);
        } catch (e) {
          logger.warn("Update items to Sheets failed", { order_id: r.order_id, error: String(e) });
        }
      }
      logger.info("Synced items to Sheets for upcoming orders", { count: rows.length });
    } catch (e) {
      logger.error("Items sync to Sheets error", { error: String(e) });
    }
  }, { timezone });
}
