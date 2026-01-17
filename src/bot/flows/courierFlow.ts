import TelegramBot from "node-telegram-bot-api";
import { getDb } from "../../infra/db/sqlite";
import { setDelivered, getOrderById } from "../../domain/orders/OrderService";
import { getProducts } from "../../infra/data";
import { encodeCb, decodeCb } from "../cb";
import { logger } from "../../infra/logger";
import { batchGet } from "../../infra/sheets/SheetsClient";
import { shopConfig } from "../../config/shopConfig";
import { env } from "../../infra/config";
import { google } from "googleapis";

function getDateString(offset: number) {
  const d = new Date(Date.now() + offset * 86400000);
  return d.toISOString().slice(0, 10);
}

async function updateOrderInSheets(orderId: number, updates: Record<string, any>) {
  const api = google.sheets({ version: "v4" });
  const sheet = env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const name = env.GOOGLE_SHEETS_MODE === "TABS_PER_CITY" ? `orders_${shopConfig.cityCode}` : "orders";
  const resp = await api.spreadsheets.values.get({ spreadsheetId: sheet, range: `${name}!A:Z` });
  const values = resp.data.values || [];
  if (!values.length) return;
  const headers = values[0].map(String);
  const idx = (n: string) => headers.indexOf(n);
  const idIdx = idx("order_id");
  if (idIdx < 0) return;
  let rowIndex = -1;
  for (let i = 1; i < values.length; i++) {
    const r = values[i];
    if (Number(r[idIdx]) === Number(orderId)) { rowIndex = i; break; }
  }
  if (rowIndex < 0) return;
  const row = [...values[rowIndex]];
  for (const [k, v] of Object.entries(updates)) {
    const ci = idx(k);
    if (ci >= 0) row[ci] = String(v);
  }
  const range = `${name}!A${rowIndex + 1}:Z${rowIndex + 1}`;
  await api.spreadsheets.values.update({
    spreadsheetId: sheet,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });
}

async function syncOrdersFromSheets() {
  try {
    const sheet = env.GOOGLE_SHEETS_MODE === "TABS_PER_CITY" ? `orders_${shopConfig.cityCode}` : "orders";
    const vr = await batchGet([`${sheet}!A:Z`]);
    const values = vr[0]?.values || [];
    const headers = values[0] || [];
    const rows = values.slice(1);
    const idx = (name: string) => headers.indexOf(name);
    const idxAny = (...names: string[]) => {
      for (const n of names) { const i = headers.indexOf(n); if (i >= 0) return i; }
      return -1;
    };
    const idIdx = idx("order_id");
    const userIdx = idx("user_id");
    const usernameIdx = idx("username");
    const statusIdx = idx("status");
    const dateIdx = idx("delivery_date");
    const timeIdx = idx("delivery_time");
    const totalIdx = idx("total_amount") >= 0 ? idx("total_amount") : idx("total");
    const itemsIdx = idxAny("items_json","items");
    const courierIdx = idx("courier_id");
    const validDates = [getDateString(0), getDateString(1), getDateString(2)];
    const db = getDb();
    const tx = db.transaction(() => {
      for (const r of rows) {
        const st = String(statusIdx >= 0 ? r[statusIdx] || "" : "").toLowerCase();
        const dd = String(dateIdx >= 0 ? r[dateIdx] || "" : "");
        if (!["pending","confirmed","courier_assigned"].includes(st)) continue;
        if (!validDates.includes(dd)) continue;
        const oid = Number(idIdx >= 0 ? r[idIdx] || 0 : 0);
        const uid = Number(userIdx >= 0 ? r[userIdx] || 0 : 0);
        const uname = String(usernameIdx >= 0 ? r[usernameIdx] || "" : "");
        const tt = String(timeIdx >= 0 ? r[timeIdx] || "" : "");
        const tot = Number(totalIdx >= 0 ? r[totalIdx] || 0 : 0);
        const items = String(itemsIdx >= 0 ? r[itemsIdx] || "[]" : "[]");
        const courierId = Number(courierIdx >= 0 ? r[courierIdx] || 0 : 0);
        db.prepare("INSERT INTO orders(order_id, user_id, items_json, total_without_discount, total_with_discount, discount_total, status, reserve_timestamp, expiry_timestamp, delivery_date, delivery_exact_time, courier_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET user_id=excluded.user_id, items_json=excluded.items_json, total_with_discount=excluded.total_with_discount, status=excluded.status, delivery_date=excluded.delivery_date, delivery_exact_time=excluded.delivery_exact_time, courier_id=excluded.courier_id")
          .run(oid, uid, items, tot, tot, 0, st, new Date().toISOString(), new Date().toISOString(), dd, tt, courierId);
        if (uname) db.prepare("INSERT OR IGNORE INTO users(user_id, username, first_seen) VALUES (?,?,?)").run(uid, uname, new Date().toISOString());
      }
    });
    tx();
  } catch (e) {
    try { logger.warn("syncOrdersFromSheets error", { error: String(e) }); } catch {}
  }
}

function itemsText(itemsJson: string, products: any[]): string {
  let out = "";
  try {
    const list = JSON.parse(String(itemsJson || "[]"));
    const arr = list.map((i: any) => {
      if (i && typeof i.name === "string" && (i.quantity != null)) {
        return `${i.name} × ${Number(i.quantity || 0)}`;
      }
      const p = products.find((x) => x.product_id === i.product_id);
      const name = p ? p.title : (i.name ? i.name : `#${i.product_id}`);
      const qty = Number(i.qty || i.quantity || 0);
      return `${name} × ${qty}`;
    });
    out = arr.length > 3 ? arr.slice(0,3).join(", ") + "..." : arr.join(", ");
  } catch {}
  return out;
}

async function refreshCourierPanel(bot: TelegramBot, chatId: number, messageId: number | undefined, courierId: number) {
  const db = getDb();
  const map = db.prepare("SELECT tg_id, courier_id FROM couriers WHERE tg_id = ? OR courier_id = ?").get(courierId, courierId) as any;
  const idA = Number(map?.tg_id || courierId);
  const idB = Number(map?.courier_id || courierId);
  const today = getDateString(0);
  const dayAfter = getDateString(2);
  const rows = db.prepare("SELECT o.order_id, o.user_id, o.items_json, o.total_with_discount, o.delivery_date, o.delivery_exact_time, u.username FROM orders o LEFT JOIN users u ON o.user_id=u.user_id WHERE o.courier_id IN (?, ?) AND o.status IN ('pending','confirmed','courier_assigned') AND o.delivery_date >= ? AND o.delivery_date <= ? ORDER BY o.delivery_date ASC, o.order_id DESC").all(idA, idB, today, dayAfter) as any[];
  const products = await getProducts();
  const sec = {
    [getDateString(0)]: [] as any[],
    [getDateString(1)]: [] as any[],
    [getDateString(2)]: [] as any[]
  };
  for (const r of rows) {
    if (sec[r.delivery_date]) sec[r.delivery_date].push(r);
  }
  const mk = (r: any) => {
    const uname = r.username ? `@${r.username}` : "Клиент";
    const it = itemsText(String(r.items_json||"[]"), products);
    const time = String(r.delivery_exact_time||"").split(" ").pop() || "?";
    const total = Number(r.total_with_discount||0).toFixed(2);
    return `📦 #${r.order_id} ${uname}\n📋 ${it}\n⏰ ${time} · 💰 ${total}€`;
  };
  const lines: string[] = [];
  lines.push("═══════════════════════════════");
  lines.push("     ПАНЕЛЬ КУРЬЕРА");
  lines.push("═══════════════════════════════");
  const addSec = (title: string, date: string) => {
    lines.push(`📅 ${title}`);
    for (const r of sec[date]) lines.push(mk(r));
    lines.push("───────────────────────────────");
  };
  addSec("ЗАКАЗЫ НА СЕГОДНЯ", getDateString(0));
  addSec("ЗАКАЗЫ НА ЗАВТРА", getDateString(1));
  addSec("ЗАКАЗЫ НА ПОСЛЕЗАВТРА", getDateString(2));
  const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
  for (const date of [getDateString(0), getDateString(1), getDateString(2)]) {
    for (const r of sec[date]) {
      keyboard.push([
        { text: `✅ Выдано #${r.order_id}`, callback_data: encodeCb(`courier_issue:${r.order_id}`) },
        { text: `❌ Не выдано #${r.order_id}`, callback_data: encodeCb(`courier_not_issued:${r.order_id}`) }
      ]);
    }
  }
  keyboard.push([{ text: "🔄 Обновить", callback_data: encodeCb("courier_refresh") }]);
  keyboard.push([{ text: "🏠 Главное меню", callback_data: encodeCb("back:main") }]);
  try {
    if (messageId) await bot.editMessageText(lines.join("\n"), { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
    else await bot.sendMessage(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: keyboard } });
  } catch {
    await bot.sendMessage(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: keyboard } });
  }
}

export function registerCourierFlow(bot: TelegramBot) {
  try { setInterval(syncOrdersFromSheets, 5 * 60 * 1000); } catch {}
  bot.onText(/\/courier/, async (msg) => {
    const chatId = msg.chat.id;
    await syncOrdersFromSheets();
    await refreshCourierPanel(bot, chatId, undefined, msg.from?.id || 0);
  });

  bot.on("callback_query", async (q) => {
    try { await bot.answerCallbackQuery(q.id); } catch {}
    try { logger.info("COURIER_CLICK", { data: q.data, courier_id: q.from?.id }); } catch {}
    let data = q.data || "";
    data = decodeCb(data);
    if (data === "__expired__") {
      const chatId = q.message?.chat.id || 0;
      await bot.sendMessage(chatId, "Кнопка устарела. Откройте /courier для актуального списка.");
      return;
    }
    const chatId = q.message?.chat.id || 0;
    if (data === "courier_refresh") {
      await refreshCourierPanel(bot, chatId, q.message?.message_id, q.from.id);
    } else if (data.startsWith("courier_issue:")) {
      const id = Number(data.split(":")[1]);
      await setDelivered(id, q.from.id);
      try { await updateOrderInSheets(id, { status: "delivered", delivered_at: new Date().toISOString(), delivered_by: String(q.from.id) }); } catch {}
      await refreshCourierPanel(bot, chatId, q.message?.message_id, q.from.id);
      const order = await getOrderById(id);
      if (order) { try { await bot.sendMessage(order.user_id, "Спасибо за заказ! Приходите к нам ещё."); } catch {} }
    } else if (data.startsWith("courier_not_issued:")) {
      const id = Number(data.split(":")[1]);
      try {
        const { setNotIssued, getOrderById } = await import("../../domain/orders/OrderService");
        await setNotIssued(id);
        try { await updateOrderInSheets(id, { status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: String(q.from.id) }); } catch {}
        const order = await getOrderById(id);
        if (order) {
          try { await bot.sendMessage(order.user_id, "❗ Заказ не выдан и удалён из очереди. Оформите новый заказ при необходимости." ); } catch {}
        }
        await refreshCourierPanel(bot, chatId, q.message?.message_id, q.from.id);
      } catch {}
    }
  });
}
