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
    try {
      const db = getDb();
      const bot = getBot();
      const today = new Date().toISOString().slice(0,10);
      const rows = db.prepare("SELECT items_json, payment_method FROM orders WHERE status='delivered' AND substr(delivered_timestamp,1,10)=?").all(today) as any[];
      const { getProducts } = await import("../data");
      const products = await getProducts();
      const byBrand: Record<string, string[]> = {};
      const cashTotals: number[] = [];
      const cardTotals: number[] = [];
      for (const r of rows) {
        const pm = String(r.payment_method || '').toLowerCase() === 'card' ? 'card' : 'cash';
        let orderSum = 0;
        const items = JSON.parse(r.items_json || '[]');
        for (const i of items) {
          const p = products.find((x) => x.product_id === i.product_id);
          if (!p) continue;
          const brand = p.brand ? p.brand : (p.category === 'electronics' ? 'ELECTRONICS' : 'LIQUIDS');
          const arr = byBrand[brand] || [];
          for (let k = 0; k < Number(i.qty); k++) arr.push(`- ${p.title} (${Number(i.price).toFixed(1)}€)`);
          byBrand[brand] = arr;
          orderSum += Number(i.price) * Number(i.qty);
        }
        if (pm === 'cash') cashTotals.push(orderSum); else cardTotals.push(orderSum);
      }
      const dd = new Date();
      const dateLabel = `${String(dd.getDate()).padStart(2,'0')}.${String(dd.getMonth()+1).padStart(2,'0')}`;
      const lines: string[] = [];
      lines.push(dateLabel);
      const brandOrder = Object.keys(byBrand);
      for (const b of brandOrder) {
        lines.push('');
        lines.push(b);
        for (const row of byBrand[b]) lines.push(row);
      }
      const sumCash = cashTotals.reduce((s,n)=>s+n,0);
      const sumCard = cardTotals.reduce((s,n)=>s+n,0);
      const sumAll = sumCash + sumCard;
      const cashExpr = cashTotals.length ? `(${cashTotals[0].toFixed(0)}€)` + (cashTotals.slice(1).length ? 
        cashTotals.slice(1).map(n=>`+ ${n.toFixed(0)}€`).join(' ') : '') : '0€';
      lines.push('');
      lines.push(`Cash: ${cashExpr}`);
      lines.push(`Card: ${cardTotals.map(n=>`${n.toFixed(0)}€`).join(' + ') || '0€'}`);
      lines.push('');
      lines.push(`Итого за день: ${sumAll.toFixed(0)} евро общая, ${sumCash.toFixed(0)} кэш ${sumCard.toFixed(0)} карта`);
      const adminIds = (process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(s=>Number(s.trim())).filter(x=>x);
      for (const id of adminIds) {
        try { await bot.sendMessage(id, lines.join('\n')); } catch {}
      }
    } catch (e) {
      logger.error("Admin daily report error", { error: String(e) });
    }
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
}
