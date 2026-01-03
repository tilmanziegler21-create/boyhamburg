import TelegramBot, { CallbackQuery } from "node-telegram-bot-api";
import { ensureUser } from "../../domain/users/UserService";
import { getProducts, refreshProductsCache } from "../../infra/data";
import { getUserSegment } from "../../domain/users/UserService";
import { OrderItem, Product } from "../../core/types";
import { createOrder, confirmOrder, setDeliverySlot, getOrderById, previewTotals, setOrderCourier, setCourierAssigned, setPaymentMethod } from "../../domain/orders/OrderService";
import { getActiveCouriers } from "../../domain/couriers/CourierService";
import { generateTimeSlots, validateSlot, getOccupiedSlots, isSlotAvailable } from "../../domain/delivery/DeliveryService";
import { env } from "../../infra/config";
import { encodeCb, decodeCb } from "../cb";
import { logger } from "../../infra/logger";
import { getDb } from "../../infra/db/sqlite";
import { formatDate, addDays } from "../../core/time";

const carts: Map<number, OrderItem[]> = new Map();
const lastMainMsg: Map<number, number> = new Map();

function fmtMoney(n: number) {
  return `${n.toFixed(2)} €`;
}

function addToCart(user_id: number, p: Product, isUpsell: boolean, priceOverride?: number) {
  const cart = carts.get(user_id) || [];
  const idx = cart.findIndex((c) => c.product_id === p.product_id);
  if (idx >= 0) cart[idx].qty += 1;
  else cart.push({ product_id: p.product_id, qty: 1, price: priceOverride ?? p.price, is_upsell: isUpsell });
  carts.set(user_id, cart);
  recalcLiquidPrices(user_id);
}

function renderCart(items: OrderItem[], products: Product[]) {
  const lines = items.map((i) => {
    const p = products.find((x) => x.product_id === i.product_id);
    const t = p ? p.title : `#${i.product_id}`;
    const icon = p && p.category === "electronics" ? "💨" : "💧";
    return `${icon} ${t} x${i.qty} · ${i.price.toFixed(2)} €`;
  });
  return lines.join("\n") || "Корзина пустая";
}

async function recalcLiquidPrices(user_id: number) {
  const cart = carts.get(user_id) || [];
  if (cart.length === 0) return;
  const products = await getProducts();
  let liquCount = 0;
  for (const it of cart) {
    const p = products.find((x) => x.product_id === it.product_id);
    if (p && p.category === "liquids") liquCount += it.qty;
  }
  let unit = liquCount >= 3 ? 15 : (liquCount === 2 ? 16 : 18);
  const seg = getUserSegment(user_id);
  if (seg === "sale10") unit = Math.round(unit * 0.9 * 100) / 100;
  for (const it of cart) {
    const p = products.find((x) => x.product_id === it.product_id);
    if (p && p.category === "liquids") it.price = unit;
  }
  carts.set(user_id, cart);
}

export function registerClientFlow(bot: TelegramBot) {
  bot.onText(/\/start/, async (msg) => {
    const user_id = msg.from?.id || 0;
    const username = msg.from?.username || "";
    await ensureUser(user_id, username);
    const rows: TelegramBot.InlineKeyboardButton[][] = [
      [{ text: "🛍️ Каталог", callback_data: "menu_catalog" }],
      [{ text: "🛒 Корзина", callback_data: encodeCb("cart_open") }],
      [{ text: "❓ Как заказать?", callback_data: "menu_howto" }],
      [{ text: "👥 Группа в Telegram", url: env.GROUP_URL || "https://t.me/+OiFfOVteCMFhYjZi" }],
      [{ text: "⭐ Отзывы", url: env.REVIEWS_URL || "https://t.me/" }]
    ];
    const admins = (env.TELEGRAM_ADMIN_IDS || "").split(",").map((s) => Number(s.trim())).filter((x) => x);
    if (admins.includes(user_id) || user_id === 8358091146) rows.push([{ text: "Админ", callback_data: "admin_open" }]);
    const prev = lastMainMsg.get(user_id);
    if (prev) { try { await bot.deleteMessage(msg.chat.id, prev); } catch {} }
    const sent = await bot.sendMessage(
      msg.chat.id,
      "🍬 <b>Добро пожаловать</b>\n\n� Премиальные жидкости с быстрой и удобной выдачей\nELFIC / CHASER — оригинальная продукция, стабильное качество и вкусы, которые выбирают снова\n\n💶 Понятные цены без сюрпризов:\n• 1 шт — 18 €\n• 2 шт — 32 €\n• 3 шт — 45 €\n\n🚚 Курьерская выдача — выбираете удобный слот\n⭐ Реальные отзывы и постоянные клиенты\n\n👇 Выберите действие ниже и соберите заказ за минуту",
      { reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" }
    );
    lastMainMsg.set(user_id, sent.message_id);
  });

  bot.on("callback_query", async (q: CallbackQuery) => {
    try { await bot.answerCallbackQuery(q.id); } catch {}
    let data = q.data || "";
    data = decodeCb(data);
    try { logger.info("CLIENT_CLICK", { data }); } catch {}
    if (data === "__expired__") {
      const chatId = q.message?.chat.id || 0;
      await bot.sendMessage(chatId, "Кнопка устарела. Нажмите /start, чтобы обновить меню.");
      return;
    }
    const chatId = q.message?.chat.id || 0;
    const messageId = q.message?.message_id as number;
    const user_id = q.from.id;
    if (data === "back:main") {
      const rows = [
        [{ text: "🛍️ Каталог", callback_data: "menu_catalog" }],
        [{ text: "🛒 Корзина", callback_data: encodeCb("cart_open") }],
        [{ text: "❓ Как заказать?", callback_data: "menu_howto" }],
        [{ text: "👥 Группа в Telegram", url: env.GROUP_URL || "https://t.me/+OiFfOVteCMFhYjZi" }],
        [{ text: "⭐ Отзывы", url: env.REVIEWS_URL || "https://t.me/" }]
      ];
      try {
      try { await bot.deleteMessage(chatId, messageId); } catch {}
      await bot.sendMessage(chatId, "Добро пожаловать! ✨\n\n🔥 Премиальные вкусы и быстрая выдача — соберите корзину за минуту.\n\n💨 Ассортимент: ELFIC / CHASER\n\n💶 Цены на жидкости:\n• 1 шт — 18 €\n• 2 шт — 32 €\n• 3 шт — 45 €\n\n🚚 Удобный слот у курьера\n⭐ Проверенное качество и отзывы\n\n👇 Выберите действие ниже и начните сейчас", { reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
      } catch {
        await bot.sendMessage(chatId, "Добро пожаловать! ✨\n\n🔥 Премиальные вкусы и быстрая выдача — соберите корзину за минуту.\n\n💨 Ассортимент: ELFIC / CHASER\n\n💶 Цены на жидкости:\n• 1 шт — 18 €\n• 2 шт — 32 €\n• 3 шт — 45 €\n\n🚚 Удобный слот у курьера\n⭐ Проверенное качество и отзывы\n\n👇 Выберите действие ниже и начните сейчас", { reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
      }
      return;
    }
    if (data === "menu_catalog") {
      const rows = [
        [{ text: "💧 Жидкости", callback_data: encodeCb("catalog_liquids") }],
        [{ text: "💨 Электроника", callback_data: encodeCb("catalog_electronics") }],
        [{ text: "🛒 Корзина", callback_data: encodeCb("cart_open") }],
        [{ text: "⬅️ Назад", callback_data: encodeCb("back:main") }]
      ];
      try {
      try { await bot.deleteMessage(chatId, messageId); } catch {}
      await bot.sendMessage(chatId, "🎯 <b>Каталог вкусов</b>\n\nВыберите бренд и вкус — добавление в корзину в один клик.\nНичего лишнего, всё быстро и понятно.\n\n💶 Цена считается автоматически по количеству:\n1 → 18 €\n2 → 32 €\n3 → 45 €\n\n🔥 Чем больше берёте — тем выгоднее\n\n👇 Нажмите на товар, чтобы добавить в корзину", { reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
      } catch {
        await bot.sendMessage(chatId, "<b>📦 Каталог</b>\n\nКаталог вкусов\n\nВыберите бренд и вкус — добавляйте в корзину в один клик.\n\n💶 Цена считается автоматически по количеству:\n<b>1 → 18 € • 2 → 32 € • 3 → 45 €</b>\n\n🔥 Чем больше — тем выгоднее\n\n👇 Нажмите на товар, чтобы добавить в корзину", { reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
      }
      return;
    }
    if (data === "menu_howto") {
      const rows = [[{ text: "⬅️ Назад", callback_data: "back:main" }], [{ text: "🏠 Главное меню", callback_data: encodeCb("back:main") }]];
      try { await bot.deleteMessage(chatId, messageId); } catch {}
      await bot.sendMessage(chatId, "<b>❓ Как заказать</b>\n\n1️⃣ Нажмите «Каталог»\n2️⃣ Выберите вкус и добавьте в корзину\n3️⃣ Перейдите в «Корзину»\n4️⃣ Подтвердите заказ\n5️⃣ Согласуйте удобный слот с курьером\n\n⏱ Весь процесс занимает 1–2 минуты\n\nЕсли возникнут вопросы — мы всегда на связи 👌", { reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
      return;
    }
    if (data === "catalog_liquids") {
      const products = await getProducts();
      const liquids = products.filter((p) => p.active && p.category === "liquids");
      const brandsSet = new Set<string>();
      for (const p of liquids) if (p.brand) brandsSet.add(p.brand);
      const brands = Array.from(brandsSet);
      const order = ["ELFIC", "CHASER"]; // приоритет
      brands.sort((a, b) => order.indexOf(a) - order.indexOf(b));
      if (brands.length === 0) {
        // fallback: постраничный список всех жидкостей
        const page = 0;
        const per = 10;
        const start = page * per;
        const slice = liquids.slice(start, start + per);
        const rows: { text: string; callback_data: string }[][] = slice.map((a) => [{ text: `💧 ${a.title} · ${fmtMoney(a.price)}`, callback_data: encodeCb(`add_item:${a.product_id}`) }]);
        const nav: { text: string; callback_data: string }[] = [];
        if (start + per < liquids.length) nav.push({ text: "▶️", callback_data: encodeCb(`catalog_liquids:page:${page + 1}`) });
        if (nav.length) rows.push(nav);
        rows.push([{ text: "⬅️ Назад", callback_data: encodeCb("back:main") }]);
      try { await bot.deleteMessage(chatId, messageId); } catch {}
      await bot.sendMessage(chatId, "📦 <b>Каталог вкусов</b>\nВыберите позицию.\n\n💶 Цены: <b>1 → 18€ · 2 → 32€ · 3 → 45€</b>\n\n👇 Нажмите на товар, чтобы добавить в корзину", { reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
      } else {
        const rows: { text: string; callback_data: string }[][] = brands.map((b) => [{ text: `💧 ${b}`, callback_data: encodeCb(`liq_brand:${b}`) }]);
        rows.push([{ text: "⬅️ Назад", callback_data: encodeCb("back:main") }]);
      try { await bot.deleteMessage(chatId, messageId); } catch {}
      await bot.sendMessage(chatId, "🧪 <b>Выбор бренда</b>\n\n💶 Цена считается автоматически:\n1 — 18 € • 2 — 32 € • 3 — 45 €\n\n🔥 Чем больше — тем выгоднее\n\n👇 Нажмите на товар, чтобы добавить в корзину", { reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
      }
      return;
    }
    if (data.startsWith("catalog_liquids:page:")) {
      const page = Number(data.split(":")[2] || 0);
      const per = 10;
      const products = await getProducts();
      const liquids = products.filter((p) => p.active && p.category === "liquids");
      const start = page * per;
      const slice = liquids.slice(start, start + per);
      const rows: { text: string; callback_data: string }[][] = slice.map((a) => [{ text: `💧 ${a.title} · ${fmtMoney(a.price)}`, callback_data: encodeCb(`add_item:${a.product_id}`) }]);
      const nav: { text: string; callback_data: string }[] = [];
      if (page > 0) nav.push({ text: "◀️", callback_data: encodeCb(`catalog_liquids:page:${page - 1}`) });
      if (start + per < liquids.length) nav.push({ text: "▶️", callback_data: encodeCb(`catalog_liquids:page:${page + 1}`) });
      if (nav.length) rows.push(nav);
      rows.push([{ text: "⬅️ Назад", callback_data: encodeCb("back:main") }]);
      try { await bot.deleteMessage(chatId, messageId); } catch {}
      await bot.sendMessage(chatId, "🎯 <b>Каталог вкусов</b>\nВыберите позицию.\n\n💶 Цена считается автоматически по количеству:\n1 → 18 €\n2 → 32 €\n3 → 45 €\n\n👇 Нажмите на товар, чтобы добавить в корзину", { reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
      return;
    }
    if (data === "catalog_electronics") {
      const products = await getProducts();
      const list = products.filter((p) => p.active && p.category === "electronics");
      const brandsSet = new Set<string>();
      for (const p of list) if (p.brand) brandsSet.add(p.brand);
      const brands = Array.from(brandsSet);
      if (brands.length > 0) {
        const rows: { text: string; callback_data: string }[][] = brands.map((b) => [{ text: `💨 ${b}`, callback_data: encodeCb(`elec_brand:${b}`) }]);
        rows.push([{ text: "⬅️ Назад", callback_data: encodeCb("back:main") }]);
        try { await bot.deleteMessage(chatId, messageId); } catch {}
        await bot.sendMessage(chatId, "🧪 <b>Выбор бренда (электроника)</b>\n\n👇 Выберите бренд, затем вкус", { reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
      } else {
        const page = 0;
        const per = 10;
        const start = page * per;
        const slice = list.slice(start, start + per);
        const rows: { text: string; callback_data: string }[][] = slice.map((a) => [{ text: `💨 ${a.title} · ${fmtMoney(a.price)}`, callback_data: encodeCb(`add_item:${a.product_id}`) }]);
        const nav: { text: string; callback_data: string }[] = [];
        if (start + per < list.length) nav.push({ text: "▶️", callback_data: encodeCb(`catalog_electronics:page:${page + 1}`) });
        if (nav.length) rows.push(nav);
        rows.push([{ text: "⬅️ Назад", callback_data: encodeCb("back:main") }]);
        try { await bot.deleteMessage(chatId, messageId); } catch {}
        await bot.sendMessage(chatId, "📦 <b>Каталог электроники</b>\nВыберите позицию.\n\n👇 Нажмите на товар, чтобы добавить в корзину", { reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
      }
      return;
    }
    if (data.startsWith("catalog_electronics:page:")) {
      const page = Number(data.split(":")[2] || 0);
      const per = 10;
      const products = await getProducts();
      const list = products.filter((p) => p.active && p.category === "electronics");
      const start = page * per;
      const slice = list.slice(start, start + per);
      const rows: { text: string; callback_data: string }[][] = slice.map((a) => [{ text: `💨 ${a.title} · ${fmtMoney(a.price)}`, callback_data: encodeCb(`add_item:${a.product_id}`) }]);
      const nav: { text: string; callback_data: string }[] = [];
      if (page > 0) nav.push({ text: "◀️", callback_data: encodeCb(`catalog_electronics:page:${page - 1}`) });
      if (start + per < list.length) nav.push({ text: "▶️", callback_data: encodeCb(`catalog_electronics:page:${page + 1}`) });
      if (nav.length) rows.push(nav);
      rows.push([{ text: "⬅️ Назад", callback_data: encodeCb("back:main") }]);
      try { await bot.deleteMessage(chatId, messageId); } catch {}
      await bot.sendMessage(chatId, "📦 <b>Каталог электроники</b>\nВыберите позицию.", { reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
      return;
    }
    if (data.startsWith("elec_brand:")) {
      const parts = data.split(":");
      const brand = parts[1];
      const page = parts[3] ? Number(parts[3]) : 0;
      const per = 10;
      const products = await getProducts();
      const list = products.filter((p) => p.active && p.category === "electronics" && (p.brand || "") === brand);
      const start = page * per;
      const slice = list.slice(start, start + per);
      const rows: { text: string; callback_data: string }[][] = slice.map((a) => [{ text: `💨 ${a.title} · ${fmtMoney(a.price)}`, callback_data: encodeCb(`add_item:${a.product_id}`) }]);
      const nav: { text: string; callback_data: string }[] = [];
      if (page > 0) nav.push({ text: "◀️", callback_data: encodeCb(`elec_brand:${brand}:page:${page - 1}`) });
      if (start + per < list.length) nav.push({ text: "▶️", callback_data: encodeCb(`elec_brand:${brand}:page:${page + 1}`) });
      if (nav.length) rows.push(nav);
      rows.push([{ text: "🛒 Корзина", callback_data: encodeCb("cart_open") }]);
      rows.push([{ text: "⬅️ Назад", callback_data: encodeCb("back:main") }]);
      try { await bot.deleteMessage(chatId, messageId); } catch {}
      await bot.sendMessage(chatId, `<b>${brand}</b> 💨`, { reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
      return;
    }
    if (data.startsWith("liq_brand:")) {
      const parts = data.split(":");
      const brand = parts[1];
      const page = parts[3] ? Number(parts[3]) : 0;
      const per = 10;
      const products = await getProducts();
      const list = products.filter((p) => p.active && p.category === "liquids" && (p.brand || "") === brand);
      const start = page * per;
      const slice = list.slice(start, start + per);
      const rows: { text: string; callback_data: string }[][] = slice.map((a) => [{ text: `💧 ${a.title} · ${fmtMoney(a.price)}`, callback_data: encodeCb(`add_item:${a.product_id}`) }]);
      const nav: { text: string; callback_data: string }[] = [];
      if (page > 0) nav.push({ text: "◀️", callback_data: encodeCb(`liq_brand:${brand}:page:${page - 1}`) });
      if (start + per < list.length) nav.push({ text: "▶️", callback_data: encodeCb(`liq_brand:${brand}:page:${page + 1}`) });
      if (nav.length) rows.push(nav);
      rows.push([{ text: "🛒 Корзина", callback_data: encodeCb("cart_open") }]);
      rows.push([{ text: "⬅️ Назад", callback_data: encodeCb("back:main") }]);
      try { await bot.deleteMessage(chatId, messageId); } catch {}
      await bot.sendMessage(chatId, `<b>${brand}</b> 💧\n\n💶 Цены: <b>1 → 18€ · 2 → 32€ · 3 → 45€</b>\n\n👇 Нажмите на товар, чтобы добавить в корзину`, { reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
      return;
    }
    if (data === "back:menu_catalog") {
      const rows = [
        [{ text: "🛍️ Каталог", callback_data: "menu_catalog" }],
        [{ text: "🛒 Корзина", callback_data: encodeCb("cart_open") }],
        [{ text: "❓ Как заказать?", callback_data: "menu_howto" }],
        [{ text: "👥 Группа в Telegram", url: env.GROUP_URL || "https://t.me/+OiFfOVteCMFhYjZi" }],
        [{ text: "⭐ Отзывы", url: env.REVIEWS_URL || "https://t.me/" }]
      ];
      try { await bot.deleteMessage(chatId, messageId); } catch {}
      await bot.sendMessage(chatId, "🍬 <b>Добро пожаловать</b>\n\n� Премиальные жидкости с быстрой и удобной выдачей\nELFIC / CHASER — оригинальная продукция, стабильное качество и вкусы, которые выбирают снова\n\n💶 Понятные цены без сюрпризов:\n• 1 шт — 18 €\n• 2 шт — 32 €\n• 3 шт — 45 €\n\n🚚 Курьерская выдача — выбираете удобный слот\n⭐ Реальные отзывы и постоянные клиенты\n\n👇 Выберите действие ниже и соберите заказ за минуту", { reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
      return;
    }
    if (data.startsWith("add_item:")) {
      const pid = Number(data.split(":")[1]);
      const products = await getProducts();
      const p = products.find((x) => x.product_id === pid);
      if (!p) return;
      addToCart(user_id, p, false);
      const items = carts.get(user_id) || [];
      const totals = await previewTotals(user_id, items);
      let savings = 0;
      for (const i of items) {
        const ip = products.find((x) => x.product_id === i.product_id);
        if (ip && ip.category === "liquids" && i.price < 18) savings += (18 - i.price) * i.qty;
      }
      savings = Math.round(savings * 100) / 100;
      const baseKeyboard: { text: string; callback_data: string }[][] = [[{ text: `✅ Подтвердить заказ · ${totals.total_with_discount.toFixed(2)} €`, callback_data: encodeCb("confirm_order") }], [{ text: "🛒 Корзина", callback_data: encodeCb("cart_open") }]];
      let finalKeyboard = baseKeyboard;
      if (p.category === "liquids") {
        const productsAll = await refreshProductsCache();
        const available = productsAll.filter((x) => x.active && x.category === "liquids" && !items.find((i) => i.product_id === x.product_id));
        for (let i = available.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = available[i]; available[i] = available[j]; available[j] = t; }
        const pick = available.slice(0, 2);
        try { getDb().prepare("INSERT INTO events(date, type, user_id, payload) VALUES (?,?,?,?)").run(new Date().toISOString(), "upsell_offer", user_id, JSON.stringify({ suggestions: pick.map(x=>x.product_id) })); } catch {}
        let liquCount = 0; for (const it of items) { const ip = products.find((x) => x.product_id === it.product_id); if (ip && ip.category === "liquids") liquCount += it.qty; }
        const nextLabel = liquCount >= 2 ? "15.00 €" : "16.00 €";
        const rows: { text: string; callback_data: string }[][] = pick.map((s) => [{ text: `➕ ${s.title} — ${nextLabel}`, callback_data: encodeCb(`add_upsell:${s.product_id}`) }]);
        rows.push([{ text: "🧪 Выбор бренда", callback_data: encodeCb("catalog_liquids") }]);
        finalKeyboard = rows.concat(finalKeyboard);
      }
      let liquCountNow = 0; for (const it of items) { const ip = products.find((x) => x.product_id === it.product_id); if (ip && ip.category === "liquids") liquCountNow += it.qty; }
      const currentUnit = liquCountNow === 1 ? "18.00 €" : (liquCountNow === 2 ? "16.00 €" : "15.00 €");
      const nextUnit = liquCountNow >= 2 ? "15.00 €" : "16.00 €";
      const textLiquids = `💧 ${p.title} добавлен\n${liquCountNow} шт — ${currentUnit}\n\n🔥 Следующий вкус — ${nextUnit}\n🔥 От 3 шт — по 15 € за каждую\n\nИтого: <b>${totals.total_with_discount.toFixed(2)} €</b>${savings > 0 ? ` · Экономия: ${savings.toFixed(2)} €` : ""}`;
      const textElectronics = `💨 ${p.title} добавлен — ${fmtMoney(p.price)}\n${renderCart(items, products)}\n\nИтого: <b>${totals.total_with_discount.toFixed(2)} €</b>`;
      const outText = p.category === "liquids" ? textLiquids : textElectronics;
      try {
        await bot.editMessageText(outText, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: finalKeyboard }, parse_mode: "HTML" });
      } catch {
        await bot.sendMessage(chatId, outText, { reply_markup: { inline_keyboard: finalKeyboard }, parse_mode: "HTML" });
      }
    } else if (data === "show_upsell") {
      const products = await refreshProductsCache();
      const cart = carts.get(user_id) || [];
      const groups = new Set<number>();
      for (const it of cart) {
        const p = products.find((x) => x.product_id === it.product_id);
        if (p && typeof p.upsell_group_id === "number") groups.add(p.upsell_group_id);
      }
      const sug = products.filter((p) => p.active && p.upsell_group_id != null && groups.has(p.upsell_group_id as number)).slice(0, 6);
      const rows: { text: string; callback_data: string }[][] = sug.slice(0, 3).map((p) => [{ text: `🔥 Добавить вкус: ${p.title} · ${p.category === "liquids" ? "16.00 €" : fmtMoney(p.price)}`, callback_data: `add_upsell:${p.product_id}` }]);
      rows.push([{ text: "🧴 Добавить ещё жидкости", callback_data: encodeCb("catalog_liquids") }]);
      await bot.editMessageText("<b>Рекомендуем дополнительно</b> ⭐", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
  } else if (data.startsWith("add_upsell:")) {
    const pid = Number(data.split(":")[1]);
    const products = await getProducts();
    const p = products.find((x) => x.product_id === pid);
    if (!p) return;
    const price = p.category === "liquids" ? 16 : p.price;
    addToCart(user_id, p, true, price);
    try { getDb().prepare("INSERT INTO events(date, type, user_id, payload) VALUES (?,?,?,?)").run(new Date().toISOString(), "upsell_accept", user_id, JSON.stringify({ product_id: pid, price })); } catch {}
    const items = carts.get(user_id) || [];
    const label = p.category === "liquids" ? "16.00 €" : fmtMoney(p.price);
    const totals = await previewTotals(user_id, items);
    let savings2 = 0;
    for (const it of items) {
      const ip = products.find((x) => x.product_id === it.product_id);
      if (ip && ip.category === "liquids" && it.price < 18) savings2 += (18 - it.price) * it.qty;
    }
    savings2 = Math.round(savings2 * 100) / 100;
    const groups = new Set<number>();
    for (const it of items) {
      const ip = products.find((x) => x.product_id === it.product_id);
      if (ip && typeof ip.upsell_group_id === "number") groups.add(ip.upsell_group_id);
    }
    const pool = products.filter((x) => x.active && x.category === "liquids" && !items.find((i) => i.product_id === x.product_id));
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    const more = pool.slice(0, 2);
    let liquCount2 = 0; for (const it of items) { const ip = products.find((x) => x.product_id === it.product_id); if (ip && ip.category === "liquids") liquCount2 += it.qty; }
    const nextLabel2 = liquCount2 >= 2 ? "15.00 €" : "16.00 €";
    const rows: { text: string; callback_data: string }[][] = more.map((m) => [{ text: `➕ Добавить вкус — ${nextLabel2}`, callback_data: encodeCb(`add_upsell:${m.product_id}`) }]);
    rows.push([{ text: `✅ Подтвердить заказ · ${totals.total_with_discount.toFixed(2)} €`, callback_data: encodeCb("confirm_order") }]);
    rows.push([{ text: "🧴 Добавить ещё жидкости", callback_data: encodeCb("catalog_liquids") }]);
    rows.push([{ text: "⬅️ Назад", callback_data: encodeCb("back:main") }]);
    try {
      await bot.editMessageText(`<b>Добавлено в апсел</b>: ${p.title} — ${label}\n${renderCart(items, products)}\n\nИтого: <b>${totals.total_with_discount.toFixed(2)} €</b>${savings2 > 0 ? ` · Экономия: ${savings2.toFixed(2)} €` : ""}`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
    } catch {
      await bot.sendMessage(chatId, `<b>Добавлено в апсел</b>: ${p.title} — ${label}\n${renderCart(items, products)}\n\nИтого: <b>${totals.total_with_discount.toFixed(2)} €</b>${savings2 > 0 ? ` · Экономия: ${savings2.toFixed(2)} €` : ""}`, { reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
    }
  } else if (data.startsWith("add_upsell_discount10:")) {
    const pid = Number(data.split(":")[1]);
    const products = await getProducts();
    const p = products.find((x) => x.product_id === pid);
    if (!p) return;
    addToCart(user_id, p, true);
    try { getDb().prepare("INSERT INTO events(date, type, user_id, payload) VALUES (?,?,?,?)").run(new Date().toISOString(), "upsell_accept", user_id, JSON.stringify({ product_id: pid, price: p.price })); } catch {}
    const items = carts.get(user_id) || [];
    const totals = await previewTotals(user_id, items);
    let savings3 = 0;
    for (const it of items) {
      const ip = products.find((x) => x.product_id === it.product_id);
      if (ip && ip.category === "liquids" && it.price < 18) savings3 += (18 - it.price) * it.qty;
    }
    savings3 = Math.round(savings3 * 100) / 100;
    const liqu = products.filter((x) => x.active && x.category === "liquids" && !items.find((i) => i.product_id === x.product_id));
    const more = liqu.slice(0, 6);
    const rows: { text: string; callback_data: string }[][] = [];
    for (let i = 0; i < more.length; i += 3) {
      const r: { text: string; callback_data: string }[] = [];
      for (let j = i; j < Math.min(i + 3, more.length); j++) r.push({ text: `🔥 ${more[j].title} · скидка 10%`, callback_data: encodeCb(`add_upsell_discount10:${more[j].product_id}`) });
      rows.push(r);
    }
    rows.push([{ text: `✅ Подтвердить заказ · ${totals.total_with_discount.toFixed(2)} €`, callback_data: encodeCb("confirm_order") }]);
    rows.push([{ text: "🧴 Добавить ещё жидкости", callback_data: encodeCb("catalog_liquids") }]);
    rows.push([{ text: "⬅️ Назад", callback_data: encodeCb("back:main") }]);
    try {
      await bot.editMessageText(`<b>Добавлено в апсел</b>: ${p.title} — скидка 10%\n${renderCart(items, products)}\n\nИтого: <b>${totals.total_with_discount.toFixed(2)} €</b>${savings3 > 0 ? ` · Экономия: ${savings3.toFixed(2)} €` : ""}`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
    } catch {
      await bot.sendMessage(chatId, `<b>Добавлено в апсел</b>: ${p.title} — скидка 10%\n${renderCart(items, products)}\n\nИтого: <b>${totals.total_with_discount.toFixed(2)} €</b>${savings3 > 0 ? ` · Экономия: ${savings3.toFixed(2)} €` : ""}`, { reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
    }
    } else if (data === "cart_open") {
      await showCart(bot, chatId, user_id, messageId);
    } else if (data.startsWith("cart_add:")) {
      const parts = data.split(":");
      const pid = Number(parts[1]);
      const n = Number(parts[2] || 1);
      const items = carts.get(user_id) || [];
      const idx = items.findIndex((x) => x.product_id === pid);
      if (idx >= 0) items[idx].qty += n;
      carts.set(user_id, items);
      await recalcLiquidPrices(user_id);
      await showCart(bot, chatId, user_id, messageId);
    } else if (data.startsWith("cart_sub:")) {
      const parts = data.split(":");
      const pid = Number(parts[1]);
      const n = Number(parts[2] || 1);
      const items = carts.get(user_id) || [];
      const idx = items.findIndex((x) => x.product_id === pid);
      if (idx >= 0) items[idx].qty = Math.max(0, items[idx].qty - n);
      if (idx >= 0 && items[idx].qty === 0) items.splice(idx, 1);
      carts.set(user_id, items);
      await recalcLiquidPrices(user_id);
      await showCart(bot, chatId, user_id, messageId);
    } else if (data.startsWith("cart_del:")) {
      const pid = Number(data.split(":")[1]);
      const items = carts.get(user_id) || [];
      const idx = items.findIndex((x) => x.product_id === pid);
      if (idx >= 0) items.splice(idx, 1);
      carts.set(user_id, items);
      await recalcLiquidPrices(user_id);
      await showCart(bot, chatId, user_id, messageId);
    } else if (data === "confirm_order") {
      const items = carts.get(user_id) || [];
      if (items.length === 0) return;
      const order = await createOrder(user_id, items);
      await confirmOrder(order.order_id);
      const couriers = await getActiveCouriers();
      const rows: TelegramBot.InlineKeyboardButton[][] = couriers.map((c) => [{ text: `${c.name} · ${c.last_delivery_interval}`, callback_data: encodeCb(`choose_courier:${order.order_id}|${c.tg_id}`) }]);
      rows.push([{ text: "⬅️ Назад", callback_data: encodeCb("back:main") }]);
      await bot.editMessageText(`<b>Выберите курьера</b> 🚚`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
    } else if (data.startsWith("choose_courier:")) {
      const payload = data.substring("choose_courier:".length);
      const [orderIdStr, courierIdStr] = payload.split("|");
      const order_id = Number(orderIdStr);
      const courier_tg_id = Number(courierIdStr);
      await setOrderCourier(order_id, courier_tg_id);
      await setCourierAssigned(order_id, courier_tg_id);
      const today = formatDate(new Date());
      const tomorrow = formatDate(addDays(new Date(), 1));
      const dayAfter = formatDate(addDays(new Date(), 2));
      const rowsDates: TelegramBot.InlineKeyboardButton[][] = [
        [{ text: `Сегодня (${today})`, callback_data: encodeCb(`select_date:${order_id}|${today}`) }],
        [{ text: `Завтра (${tomorrow})`, callback_data: encodeCb(`select_date:${order_id}|${tomorrow}`) }],
        [{ text: `Послезавтра (${dayAfter})`, callback_data: encodeCb(`select_date:${order_id}|${dayAfter}`) }],
        [{ text: "⬅️ Назад", callback_data: encodeCb(`back:choose_courier:${order_id}`) }],
        [{ text: "🏠 Главное меню", callback_data: encodeCb("back:main") }]
      ];
      await bot.editMessageText(`<b>Выберите день</b> 📅`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rowsDates }, parse_mode: "HTML" });
    } else if (data.startsWith("back:choose_courier:")) {
      const order_id = Number(data.split(":")[2]);
      const couriers = await getActiveCouriers();
      const rows: TelegramBot.InlineKeyboardButton[][] = couriers.map((c) => [{ text: `${c.name} · ${c.last_delivery_interval}`, callback_data: `choose_courier:${order_id}|${c.tg_id}` }]);
      rows.push([{ text: "⬅️ Назад", callback_data: encodeCb("back:main") }]);
      await bot.editMessageText(`<b>Выберите курьера</b>`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: rows }, parse_mode: "HTML" });
    } else if (data.startsWith("select_date:")) {
      const [orderIdStr, dateStr] = data.substring("select_date:".length).split("|");
      const order_id = Number(orderIdStr);
      const orderAssigned = await getOrderById(order_id);
      const couriers = await getActiveCouriers();
      const chosen = couriers.find((c) => c.tg_id === (orderAssigned?.courier_id || -1));
      const interval = chosen?.last_delivery_interval || "14-16";
      const slots = generateTimeSlots(interval);
      const occupied = chosen ? getOccupiedSlots(chosen.tg_id, dateStr) : new Set<string>();
      const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
      for (let i = 0; i < Math.min(slots.length, 21); i += 3) {
        const row: TelegramBot.InlineKeyboardButton[] = [];
        for (let j = i; j < Math.min(i + 3, slots.length); j++) {
          const mark = occupied.has(slots[j]) ? "🔴" : "🟢";
          row.push({ text: `${mark} ${slots[j]}`, callback_data: encodeCb(`select_slot:${order_id}|${slots[j]}|${dateStr}`) });
        }
        keyboard.push(row);
      }
      const backRow: TelegramBot.InlineKeyboardButton[][] = [[{ text: "⬅️ Назад", callback_data: encodeCb(`back:choose_courier:${order_id}`) }], [{ text: "🏠 Главное меню", callback_data: encodeCb("back:main") }]];
      await bot.editMessageText(`<b>Доставка</b>\nДень: ${dateStr}\nИнтервал: ${interval}\nВыберите точное время:`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard.concat(backRow) }, parse_mode: "HTML" });
    } else if (data.startsWith("select_slot:")) {
      const payload = data.substring("select_slot:".length);
      const [orderIdStr, time, dateStr] = payload.split("|");
      const order_id = Number(orderIdStr);
      const couriers = await getActiveCouriers();
      const orderAssigned = await getOrderById(order_id);
      const chosen = couriers.find((c) => c.tg_id === (orderAssigned?.courier_id || -1));
      const interval = chosen?.last_delivery_interval || couriers[0]?.last_delivery_interval || "14:00-16:00";
      const ok = validateSlot(interval, time);
      if (!ok) {
        await bot.editMessageText("<b>Слот недоступен</b>. Выберите другой.", { chat_id: chatId, message_id: messageId, parse_mode: "HTML" });
        return;
      }
      const isFree = chosen ? !getOccupiedSlots(chosen.tg_id, dateStr).has(time) : true;
      if (!isFree) {
        const occ = chosen ? getOccupiedSlots(chosen.tg_id, dateStr) : new Set<string>();
        const slots2 = generateTimeSlots(interval);
        const keyboard2: TelegramBot.InlineKeyboardButton[][] = [];
        for (let i = 0; i < Math.min(slots2.length, 21); i += 3) {
          const row: TelegramBot.InlineKeyboardButton[] = [];
          for (let j = i; j < Math.min(i + 3, slots2.length); j++) {
            const mark = occ.has(slots2[j]) ? "🔴" : "🟢";
            row.push({ text: `${mark} ${slots2[j]}`, callback_data: encodeCb(`select_slot:${order_id}|${slots2[j]}|${dateStr}`) });
          }
          keyboard2.push(row);
        }
        const backRow2: TelegramBot.InlineKeyboardButton[][] = [[{ text: "⬅️ Назад", callback_data: encodeCb(`select_date:${order_id}|${dateStr}`) }], [{ text: "🏠 Главное меню", callback_data: encodeCb("back:main") }]];
        await bot.editMessageText(`<b>Слот занят</b>. Выберите другой.`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: keyboard2.concat(backRow2) }, parse_mode: "HTML" });
        return;
      }
      await setDeliverySlot(order_id, interval, time, dateStr);
      const payKb: TelegramBot.InlineKeyboardButton[][] = [
        [{ text: "💳 Оплата картой", callback_data: encodeCb(`pay:${order_id}|card`) }],
        [{ text: "💵 Наличные", callback_data: encodeCb(`pay:${order_id}|cash`) }]
      ];
      await bot.editMessageText(`✅ <b>Время доставки</b>: ${time}\nДень: ${dateStr}\nИнтервал: ${interval}\nВыберите способ оплаты:`, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: payKb }, parse_mode: "HTML" });
      const order = await getOrderById(order_id);
      const products = await getProducts();
      const lines = (order?.items || []).map((i) => {
        const p = products.find((x) => x.product_id === i.product_id);
        const t = p ? p.title : `#${i.product_id}`;
        return `${t} x${i.qty} · ${(i.price).toFixed(2)} €`;
      }).join("\n");
      const orderAssigned2 = await getOrderById(order_id);
      const notifyTgId = orderAssigned2?.courier_id || null;
      if (notifyTgId) {
      const courierKeyboard: TelegramBot.InlineKeyboardButton[][] = [[
        { text: `📦 Выдано #${order_id}`, callback_data: encodeCb(`courier_issue:${order_id}`) },
        { text: `❗ Не выдано #${order_id}`, callback_data: encodeCb(`courier_not_issued:${order_id}`) }
      ]];
        try {
          const uname = q.from.username ? `@${q.from.username}` : `${q.from.first_name || "Клиент"}`;
          let promoMark = "";
          try {
            const ord = await getOrderById(order_id);
            const { isOrderInPromo } = await import("../../domain/promo/PromoService");
            if (ord && isOrderInPromo(ord.reserve_timestamp)) promoMark = " · скидка 10%";
          } catch {}
          await bot.sendMessage(notifyTgId, `📦 Новый заказ #${order_id} (не выдан${promoMark})\nКлиент: ${uname}\nДень: ${dateStr}\nИнтервал: ${interval}\nВремя: ${time}\n\n${lines}`, { reply_markup: { inline_keyboard: courierKeyboard }, parse_mode: "HTML" });
        } catch {}
      }
      // Контакт для локации будет отправлен после выбора оплаты
    } else if (data.startsWith("pay:")) {
      const [orderIdStr, method] = data.substring(4).split("|");
      const order_id = Number(orderIdStr);
      await setPaymentMethod(order_id, method === "card" ? "card" : "cash");
      carts.delete(user_id);
      const closeKb: TelegramBot.InlineKeyboardButton[][] = [[{ text: "🏠 Главное меню", callback_data: encodeCb("back:main") }]];
      await bot.editMessageText("✅ <b>Оплата выбрана</b>. Заказ оформлен.", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: closeKb }, parse_mode: "HTML" });
      const order3 = await getOrderById(order_id);
      const notifyTgId2 = order3?.courier_id || null;
      const contactKeyboard: TelegramBot.InlineKeyboardButton[][] = [];
      if (notifyTgId2) contactKeyboard.push([{ text: "✉️ Написать курьеру", url: `tg://user?id=${notifyTgId2}` }]);
      contactKeyboard.push([{ text: "✉️ Связь @elfovadim", url: "https://t.me/elfovadim" }]);
      contactKeyboard.push([{ text: "🏠 Главное меню", callback_data: encodeCb("back:main") }]);
      try {
        await bot.sendMessage(chatId, `📍 Попросите у курьера локацию точки выдачи.`, { reply_markup: { inline_keyboard: contactKeyboard }, parse_mode: "HTML" });
      } catch {
        await bot.sendMessage(chatId, `📍 Попросите у курьера локацию точки выдачи.`, { reply_markup: { inline_keyboard: [[{ text: "✉️ Связь @elfovadim", url: "https://t.me/elfovadim" }], [{ text: "🏠 Главное меню", callback_data: encodeCb("back:main") }]] }, parse_mode: "HTML" });
      }
    }
  });
}
function couriersByTgId(ids: number[], list: { tg_id: number }[]) {
  const set = new Set(ids);
  return list.filter((c) => set.has(c.tg_id));
}

async function showCart(bot: TelegramBot, chatId: number, user_id: number, messageId?: number) {
  const items = carts.get(user_id) || [];
  const products = await getProducts();
  const totals = await previewTotals(user_id, items);
  let savings = 0;
  for (const i of items) {
    const p = products.find((x) => x.product_id === i.product_id);
    if (p && p.category === "liquids" && i.price < 18) savings += (18 - i.price) * i.qty;
  }
  savings = Math.round(savings * 100) / 100;
  let liquCount = 0;
  for (const it of items) {
    const p = products.find((x) => x.product_id === it.product_id);
    if (p && p.category === "liquids") liquCount += it.qty;
  }
  const offer = liquCount === 0 ? ""
    : (liquCount === 1 ? "Добавьте ещё 1 для <b>32.00 €</b> (экономия 4 €)"
    : (liquCount === 2 ? "Добавьте ещё 1 для <b>45.00 €</b> (экономия 9 €)"
    : "Цена за жидкость: <b>15.00 €</b>"));
  const lines = items.map((i) => {
    const p = products.find((x) => x.product_id === i.product_id);
    const t = p ? p.title : `#${i.product_id}`;
    const icon = p && p.category === "electronics" ? "💨" : "💧";
    return `${icon} ${t} · ${i.price.toFixed(2)} € x${i.qty}`;
  }).join("\n") || "Корзина пустая";
  const kb: TelegramBot.InlineKeyboardButton[][] = [];
  for (const i of items.slice(0, 10)) {
    kb.push([
      { text: `➖1`, callback_data: encodeCb(`cart_sub:${i.product_id}:1`) },
      { text: `➖2`, callback_data: encodeCb(`cart_sub:${i.product_id}:2`) },
      { text: `➕1`, callback_data: encodeCb(`cart_add:${i.product_id}:1`) },
      { text: `➕2`, callback_data: encodeCb(`cart_add:${i.product_id}:2`) },
      { text: `🗑️`, callback_data: encodeCb(`cart_del:${i.product_id}`) }
    ]);
  }
  try {
    const pool = products.filter((x) => x.active && x.category === "liquids" && !items.find((i) => i.product_id === x.product_id));
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = pool[i]; pool[i] = pool[j]; pool[j] = t; }
    const pick = pool.slice(0, 2);
    const unitNext = liquCount >= 2 ? "15.00 €" : "16.00 €";
    kb.unshift(pick.map((p) => ({ text: `🔥 ${p.title} — ${unitNext}`, callback_data: encodeCb(`add_upsell:${p.product_id}`) })));
  } catch {}
  kb.push([{ text: `✅ Подтвердить · ${totals.total_with_discount.toFixed(2)} €`, callback_data: encodeCb("confirm_order") }]);
  kb.push([{ text: "⬅️ Назад", callback_data: encodeCb("back:main") }]);
  const text = `<b>Корзина</b> 🛒\n${lines}\n\nИтого: <b>${totals.total_with_discount.toFixed(2)} €</b>${savings > 0 ? `\nЭкономия: <b>${savings.toFixed(2)} €</b>` : ""}\n\n💶 Цены: <b>1 → 18€ · 2 → 32€ · 3 → 45€</b>${offer ? `\n${offer}` : ""}`;
  if (typeof messageId === "number") await bot.editMessageText(text, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: kb }, parse_mode: "HTML" });
  else await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: kb }, parse_mode: "HTML" });
}
