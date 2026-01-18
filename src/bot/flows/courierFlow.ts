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
import { getProductsMap, formatProductName, normalizeProductId } from "../../utils/products";
import { getUsername as loadUsername } from "../../utils/users";
import { updateRange } from "../../infra/sheets/SheetsClient";

function getDateString(offset: number) {
  const d = new Date(Date.now() + offset * 86400000);
  return d.toISOString().slice(0, 10);
}

function sheetsApiAuthed() {
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  const cleanKey = String(key || "")
    .replace(/\r\n/g, "\n")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim()
    .replace(/^"+|"+$/g, "");
  const auth = new google.auth.JWT({ email, key: cleanKey, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  return google.sheets({ version: "v4", auth });
}

async function updateOrderInSheets(orderId: number, updates: Record<string, any>, cityCodeOverride?: string): Promise<boolean> {
  const api = sheetsApiAuthed();
  const sheet = env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const city = String(cityCodeOverride || shopConfig.cityCode);
  const name = env.GOOGLE_SHEETS_MODE === "TABS_PER_CITY" ? `orders_${city}` : "orders";
  try {
    console.log("──────────────────────────────");
    console.log("📝 updateOrderInSheets НАЧАЛО");
    console.log("  Sheet:", name);
    console.log("  Order:", orderId);
    console.log("  Updates:", updates);
    console.log("  📋 Загрузка из Sheets...");
    const vr = await batchGet([`${name}!A:Z`]);
    const values = vr[0]?.values || [];
    console.log("  📋 Строк получено:", values.length);
    if (!values.length) {
      console.log("  ❌ Sheet пустой!");
      console.log("──────────────────────────────");
      return false;
    }
    const headers = (values[0] || []).map(String);
    console.log("  📋 Headers:", headers);
    const orderIdIdx = headers.findIndex((h) => h === "order_id" || h === "Order ID" || h.toLowerCase() === "orderid");
    console.log("  📋 order_id index:", orderIdIdx);
    if (orderIdIdx === -1) {
      console.log("  ❌ order_id колонка не найдена!");
      console.log("──────────────────────────────");
      return false;
    }
    console.log("  🔍 Ищем заказ #", orderId);
    let rowIndex = -1;
    for (let i = 1; i < values.length; i++) {
      const cellValue = values[i][orderIdIdx];
      console.log(`    Строка ${i}: order_id = ${cellValue}`);
      if (Number(cellValue) === Number(orderId)) { rowIndex = i; console.log(`  ✅ НАЙДЕНО в строке ${i}`); break; }
    }
    if (rowIndex === -1) {
      console.log("  ❌ Заказ не найден в Sheets!");
      console.log("──────────────────────────────");
      return false;
    }
    const row = [...values[rowIndex]];
    console.log("  📝 Строка ДО:", row.slice(0, 10));
    for (const [key, value] of Object.entries(updates)) {
      const colIdx = headers.findIndex((h) => h === key || h.toLowerCase() === key.toLowerCase() || h.replace(/\s/g, "_").toLowerCase() === key.toLowerCase());
      console.log(`  📝 Обновление ${key}: колонка ${colIdx} (${headers[colIdx]}) →`, value);
      if (colIdx >= 0) { row[colIdx] = String(value); console.log("    ✅ Обновлено"); } else { console.log("    ⚠️ Колонка не найдена"); }
    }
    console.log("  📝 Строка ПОСЛЕ:", row.slice(0, 10));
    const range = `${name}!A${rowIndex + 1}:Z${rowIndex + 1}`;
    console.log("  💾 Запись в range:", range);
    await updateRange(range, [row]);
    console.log("  ✅ Записано в Sheets");
    console.log("✅ updateOrderInSheets УСПЕХ");
    console.log("──────────────────────────────");
    return true;
  } catch (error: any) {
    console.log("❌ updateOrderInSheets ОШИБКА:", error);
    try { console.log("  Stack:", error?.stack); } catch {}
    console.log("──────────────────────────────");
    return false;
  }
}

const productsCityCache: Map<string, { ts: number; map: Map<string, string> }> = new Map();
const PRODUCTS_CACHE_TTL_MS = 5 * 60 * 1000;

async function getProductsMapByCity(cityCode: string): Promise<Map<string, string>> {
  const now = Date.now();
  const cached = productsCityCache.get(cityCode);
  if (cached && (now - cached.ts) < PRODUCTS_CACHE_TTL_MS) return cached.map;
  const candidates = [
    `products_${cityCode}`,
    `Products_${cityCode}`,
    "products",
    "Products"
  ];
  const map = new Map<string, string>();
  for (const table of candidates) {
    try {
      console.log("🔄 Пробуем загрузить", table);
      const vr = await batchGet([`${table}!A:Z`]);
      const values = vr[0]?.values || [];
      const headers = values[0] || [];
      if (!values.length) { console.log(`  ⚠️ ${table} пустая`); continue; }
      console.log("  📋", table, "headers:", headers);
      const rows = values.slice(1);
      const idIdx = headers.indexOf("product_id") >= 0 ? headers.indexOf("product_id")
        : (headers.indexOf("id") >= 0 ? headers.indexOf("id")
        : (headers.indexOf("ID") >= 0 ? headers.indexOf("ID") : 0));
      const nameIdx = headers.indexOf("name") >= 0 ? headers.indexOf("name")
        : (headers.indexOf("product_name") >= 0 ? headers.indexOf("product_name")
        : (headers.indexOf("Name") >= 0 ? headers.indexOf("Name") : 1));
      for (const r of rows) {
        const id = String(r[idIdx] || "").trim();
        const name = String(r[nameIdx] || "").trim();
        if (id && name) {
          map.set(id, name);
          map.set(id.trim(), name);
          map.set(id.toLowerCase(), name);
          const numId = parseInt(id, 10);
          if (!Number.isNaN(numId)) map.set(String(numId), name);
        }
      }
      console.log(`  ✅ ${table}: загружено ${map.size} товаров`);
    } catch (e) {
      console.log(`  ⚠️ ${table} не найдена`);
    }
  }
  console.log("📦 ИТОГО товаров:", map.size);
  console.log("📦 Примеры:", Array.from(map.entries()).slice(0, 5));
  productsCityCache.set(cityCode, { ts: now, map });
  return map;
}

async function syncOrdersFromSheets(courierId?: number, cityCode?: string) {
  try {
    const city = String(cityCode || shopConfig.cityCode);
    const sheet = env.GOOGLE_SHEETS_MODE === "TABS_PER_CITY" ? `orders_${city}` : "orders";
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
    const userIdx = (idx("user_id") >= 0 ? idx("user_id") : idx("user_tg_id"));
    const usernameIdx = idx("username");
    const statusIdx = idx("status");
    const dateIdx = idx("delivery_date");
    const timeIdx = (idx("delivery_time") >= 0 ? idx("delivery_time") : idx("slot_time"));
    const totalIdx = idx("total_amount") >= 0 ? idx("total_amount") : idx("total");
    const itemsIdx = (() => {
      const i = headers.findIndex((h) => {
        const s = String(h).trim();
        const sl = s.toLowerCase();
        return s === "items (JSON)" || s === "items" || sl.includes("items") || s.includes("JSON");
      });
      try { console.log("📋 Headers:", headers); console.log("📋 Items column:", i, "=", i >= 0 ? headers[i] : "N/A"); } catch {}
      return i;
    })();
    const courierIdx = idx("courier_id");
    const validDates = [getDateString(0), getDateString(1), getDateString(2)];
    const db = getDb();
    const pmap = await getProductsMapByCity(city);
    console.log("═══ SYNC START ═══");
    console.log("Курьер:", courierId);
    console.log("Город:", city);
    try {
      const beforeSync = db.prepare("SELECT order_id, status FROM orders WHERE courier_id = ?").all(Number(courierId || 0)) as any[];
      console.log("SQLite ДО sync:", beforeSync);
    } catch {}
    const tx = db.transaction(() => {
      for (const r of rows) {
        const st = String(statusIdx >= 0 ? r[statusIdx] || "" : "").toLowerCase();
        const dd = String(dateIdx >= 0 ? r[dateIdx] || "" : "");
        if (!["pending","confirmed","courier_assigned"].includes(st)) continue;
        if (!validDates.includes(dd)) continue;
        if (courierId != null) {
          const cidSheet = Number(courierIdx >= 0 ? r[courierIdx] || 0 : 0);
          if (cidSheet !== Number(courierId)) continue;
        }
        const oid = Number(idIdx >= 0 ? r[idIdx] || 0 : 0);
        const uid = Number(userIdx >= 0 ? r[userIdx] || 0 : 0);
        const uname = String(usernameIdx >= 0 ? r[usernameIdx] || "" : "");
        const tt = String(timeIdx >= 0 ? r[timeIdx] || "" : "");
        const tot = Number(totalIdx >= 0 ? r[totalIdx] || 0 : 0);
        const itemsRaw = String(itemsIdx >= 0 ? r[itemsIdx] || "[]" : "[]");
        try {
          console.log(`🔍 Order #${oid} items from Sheets:`, { raw: itemsRaw, type: typeof itemsRaw, length: itemsRaw.length });
          try { const parsed = JSON.parse(itemsRaw); console.log("✅ Parsed items:", parsed); } catch (e) { console.log("❌ Parse error:", String(e)); }
        } catch {}
        const courierIdVal = Number(courierIdx >= 0 ? r[courierIdx] || 0 : 0);
        let itemsEnriched = itemsRaw;
        try {
          const arr = JSON.parse(itemsRaw || "[]");
          if (Array.isArray(arr) && arr.length > 0) {
            itemsEnriched = JSON.stringify(arr.map((it: any) => {
              const pid = Number(it.product_id);
              let name = pmap.get(String(pid)) || pmap.get(String(it.product_id)) || null;
              if (!name) {
                try {
                  const db = getDb();
                  const row = db.prepare("SELECT title FROM products WHERE product_id = ? OR id = ?").get(String(it.product_id), String(it.product_id)) as any;
                  if (row && row.title) name = String(row.title);
                } catch {}
              }
              name = name || `Товар #${it.product_id}`;
              const qty = it.quantity ?? it.qty ?? 1;
              return { ...it, name, quantity: qty };
            }));
          }
          console.log("📝 Enriched items:", itemsEnriched);
        } catch {}
        const existing = db.prepare("SELECT order_id, status FROM orders WHERE order_id = ?").get(oid) as any;
        if (existing && (String(existing.status).toLowerCase() === "delivered" || String(existing.status).toLowerCase() === "cancelled")) {
          console.log(`⏭️ #${oid}: статус ${existing.status} защищён от перезаписи`);
        } else {
          db.prepare("INSERT INTO orders(order_id, user_id, items_json, total_without_discount, total_with_discount, discount_total, status, reserve_timestamp, expiry_timestamp, delivery_date, delivery_exact_time, courier_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET user_id=excluded.user_id, items_json=excluded.items_json, total_with_discount=excluded.total_with_discount, status=excluded.status, delivery_date=excluded.delivery_date, delivery_exact_time=excluded.delivery_exact_time, courier_id=excluded.courier_id")
            .run(oid, uid, itemsEnriched, tot, tot, 0, st, new Date().toISOString(), new Date().toISOString(), dd, tt, courierIdVal);
          if (uname) db.prepare("INSERT OR IGNORE INTO users(user_id, username, first_seen) VALUES (?,?,?)").run(uid, uname, new Date().toISOString());
        }
      }
    });
    tx();
    try {
      const afterSync = db.prepare("SELECT order_id, status FROM orders WHERE courier_id = ?").all(Number(courierId || 0)) as any[];
      console.log("SQLite ПОСЛЕ sync:", afterSync);
    } catch {}
    console.log("═══ SYNC END ═══");
  } catch (e) {
    try { logger.warn("syncOrdersFromSheets error", { error: String(e) }); } catch {}
  }
}

function itemsText(itemsJson: string, products: any[], pmap?: Map<string, any>): string {
  let out = "";
  try {
    const list = JSON.parse(String(itemsJson || "[]"));
    const arr = list.map((i: any) => {
      const p = products.find((x) => x.product_id === i.product_id);
      let name = p ? `${p.brand ? `${String(p.brand).toUpperCase()} · ` : ""}${p.title}` : (i.name ? i.name : "");
      if (!name && pmap) {
        const prod = pmap.get(String(i.product_id)) || pmap.get(String(String(i.product_id).toLowerCase())) || pmap.get(String(parseInt(String(i.product_id), 10)));
        if (prod) name = formatProductName(prod);
      }
      name = name || `Товар #${i.product_id}`;
      const qty = Number(i.qty || i.quantity || 0);
      return `${name} × ${qty}`;
    });
    out = arr.length > 3 ? arr.slice(0,3).join(", ") + "..." : arr.join(", ");
  } catch {}
  return out;
}

const lastPanelMessageId: Map<number, number> = new Map();

async function refreshCourierPanel(bot: TelegramBot, chatId: number, messageId: number | undefined, courierId: number): Promise<number | undefined> {
  const db = getDb();
  const map = db.prepare("SELECT tg_id, courier_id FROM couriers WHERE tg_id = ? OR courier_id = ?").get(courierId, courierId) as any;
  const idA = Number(map?.tg_id || courierId);
  const idB = Number(map?.courier_id || courierId);
  const startDate = getDateString(-1);
  const endDate = getDateString(2);
  const rows = db.prepare("SELECT o.order_id, o.user_id, o.items_json, o.total_with_discount, o.delivery_date, o.delivery_exact_time, u.username FROM orders o LEFT JOIN users u ON o.user_id=u.user_id WHERE o.courier_id IN (?, ?) AND o.status IN ('pending','confirmed','courier_assigned') AND o.status NOT IN ('cancelled','delivered') AND o.delivery_date >= ? AND o.delivery_date <= ? ORDER BY o.delivery_date ASC, o.order_id DESC").all(idA, idB, startDate, endDate) as any[];
  // Resolve city for product mapping
  let cityCode = shopConfig.cityCode;
  try {
    const rowCity = db.prepare("SELECT city_code FROM couriers WHERE tg_id = ? OR courier_id = ?").get(courierId, courierId) as any;
    if (rowCity && rowCity.city_code) cityCode = String(rowCity.city_code);
  } catch {}
  const products = await getProducts();
  const pmapProducts = await getProductsMap(cityCode);
  for (const r of rows) {
    if (!r.username) {
      try {
        const uname = await loadUsername(Number(r.user_id || 0), bot);
        r.username = uname?.startsWith("@") ? uname.slice(1) : null;
      } catch {}
    }
  }
  const sec = {
    [getDateString(0)]: [] as any[],
    [getDateString(1)]: [] as any[],
    [getDateString(2)]: [] as any[]
  };
  for (const r of rows) {
    if (sec[r.delivery_date]) sec[r.delivery_date].push(r);
  }
  const months = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
  const fmtDate = (s: string) => { try { const d = new Date(s); return `${d.getDate()} ${months[d.getMonth()]}`; } catch { return s; } };
  const mk = (r: any) => {
    const uname = r.username ? `@${r.username}` : "Клиент";
    const it = itemsText(String(r.items_json||"[]"), products, pmapProducts);
    const time = String(r.delivery_exact_time||"").split(" ").pop() || "?";
    const total = Number(r.total_with_discount||0).toFixed(2);
    return `📦 #${r.order_id} ${uname} · ${time}\n${it}\n💰 ${total}€`;
  };
  const lines: string[] = [];
  const addSec = (title: string, date: string) => {
    lines.push(`📅 ${title} · ${fmtDate(date)}`);
    lines.push("");
    for (const r of sec[date]) { lines.push(mk(r)); lines.push(""); }
    lines.push("───────────────────────────────");
    lines.push("");
  };
  addSec("СЕГОДНЯ", getDateString(0));
  addSec("ЗАВТРА", getDateString(1));
  addSec("ПОСЛЕЗАВТРА", getDateString(2));
  const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
  for (const date of [getDateString(0), getDateString(1), getDateString(2)]) {
    for (const r of sec[date]) {
      keyboard.push([
        { text: `✅ Выдано #${r.order_id}`, callback_data: encodeCb(`courier_issue:${r.order_id}`) },
        { text: `❌ Отменить #${r.order_id}`, callback_data: encodeCb(`courier_not_issued:${r.order_id}`) }
      ]);
    }
  }
  keyboard.push([{ text: "🔄 Обновить", callback_data: encodeCb("courier_refresh") }]);
  keyboard.push([{ text: "🏠 Главное меню", callback_data: encodeCb("back:main") }]);
  try {
    if (messageId) {
      await bot.editMessageText(lines.join("\n"), { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard } });
      lastPanelMessageId.set(courierId, messageId);
      return messageId;
    } else {
      const msg = await bot.sendMessage(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: keyboard } });
      lastPanelMessageId.set(courierId, msg.message_id);
      return msg.message_id;
    }
  } catch {
    const msg = await bot.sendMessage(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: keyboard } });
    lastPanelMessageId.set(courierId, msg.message_id);
    return msg.message_id;
  }
}

export function registerCourierFlow(bot: TelegramBot) {
  try { setInterval(() => { syncOrdersFromSheets(undefined, shopConfig.cityCode); }, 5 * 60 * 1000); } catch {}
  bot.onText(/\/courier/, async (msg) => {
    const chatId = msg.chat.id;
    let cityCode = shopConfig.cityCode;
    try {
      const db = getDb();
      const row = db.prepare("SELECT city_code FROM couriers WHERE tg_id = ? OR courier_id = ?").get(msg.from?.id, msg.from?.id) as any;
      if (row && row.city_code) cityCode = String(row.city_code);
    } catch {}
    await syncOrdersFromSheets(msg.from?.id, cityCode);
    try {
      const db = getDb();
      const map = db.prepare("SELECT tg_id, courier_id FROM couriers WHERE tg_id = ? OR courier_id = ?").get(msg.from?.id, msg.from?.id) as any;
      const idA = Number(map?.tg_id || msg.from?.id);
      const idB = Number(map?.courier_id || msg.from?.id);
      const schema = db.prepare("PRAGMA table_info(orders)").all();
      console.log("🔍 Orders table schema:", schema);
      const sample = db.prepare("SELECT order_id, user_id, items_json AS items, total_with_discount AS total, delivery_exact_time AS delivery_time FROM orders WHERE courier_id IN (?,?) ORDER BY order_id DESC LIMIT 3").all(idA, idB) as any[];
      console.log("🔍 DEBUG ORDERS:", sample.map((o) => ({ id: o.order_id, items: o.items, itemsType: typeof o.items, itemsLength: (o.items || "").length })));
    } catch (e) {
      console.log("❌ DEBUG error:", String(e));
    }
    const existingId = lastPanelMessageId.get(msg.from?.id || 0);
    const mid = await refreshCourierPanel(bot, chatId, existingId, msg.from?.id || 0);
    if (mid) lastPanelMessageId.set(msg.from?.id || 0, mid);
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
      try {
        let cityCode = shopConfig.cityCode;
        try {
          const db = getDb();
          const row = db.prepare("SELECT city_code FROM couriers WHERE tg_id = ? OR courier_id = ?").get(q.from.id, q.from.id) as any;
          if (row && row.city_code) cityCode = String(row.city_code);
        } catch {}
        console.log("🔄 Вызов updateOrderInSheets(delivered)...");
        const ok = await updateOrderInSheets(id, { status: "delivered", delivered_at: new Date().toISOString(), delivered_by: String(q.from.id) }, cityCode);
        console.log("📋 Sheets результат:", ok);
        await syncOrdersFromSheets(q.from.id, cityCode);
      } catch (e) { console.log("❌ Ошибка обновления Sheets(delivered):", e); }
      await refreshCourierPanel(bot, chatId, q.message?.message_id, q.from.id);
      const order = await getOrderById(id);
      if (order) { try { await bot.sendMessage(order.user_id, "Спасибо за заказ! Приходите к нам ещё."); } catch {} }
    } else if (data.startsWith("courier_not_issued:")) {
      const id = Number(data.split(":")[1]);
      try {
        const { setNotIssued, getOrderById } = await import("../../domain/orders/OrderService");
        await setNotIssued(id);
        try {
          let cityCode = shopConfig.cityCode;
          try {
            const db = getDb();
            const row = db.prepare("SELECT city_code FROM couriers WHERE tg_id = ? OR courier_id = ?").get(q.from.id, q.from.id) as any;
            if (row && row.city_code) cityCode = String(row.city_code);
          } catch {}
          console.log("🔄 Вызов updateOrderInSheets(cancelled)...");
          const ok = await updateOrderInSheets(id, { status: "cancelled", cancelled_at: new Date().toISOString(), cancelled_by: String(q.from.id) }, cityCode);
          console.log("📋 Sheets результат:", ok);
          await syncOrdersFromSheets(q.from.id, cityCode);
        } catch (e) { console.log("❌ Ошибка обновления Sheets(cancelled):", e); }
        const order = await getOrderById(id);
        if (order) {
          try { await bot.sendMessage(order.user_id, "❗ Заказ не выдан и удалён из очереди. Оформите новый заказ при необходимости." ); } catch {}
        }
        await refreshCourierPanel(bot, chatId, q.message?.message_id, q.from.id);
      } catch {}
    }
  });
}
