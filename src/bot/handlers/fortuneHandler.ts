import TelegramBot from "node-telegram-bot-api";
import { getProducts } from "../../infra/data";
import { getDb } from "../../infra/db/sqlite";
import { carts, userStates, userRerollCount } from "../../infra/storage/InMemoryStorage";
import { Product } from "../../core/types";
import { getLiquidUnitPrice } from "../../services/PriceService";
import { shopConfig } from "../../config/shopConfig";
import { encodeCb } from "../cb";

async function computeCartTotals(userId: number, products: Product[]) {
  const items = carts.get(userId) || [];
  const baseline = await getLiquidUnitPrice(1, shopConfig.cityCode);
  let savings = 0;
  for (const it of items) {
    const p = products.find((x) => x.product_id === it.product_id);
    if (p && p.category === "liquids" && it.price < baseline) savings += (baseline - it.price) * it.qty;
  }
  const total = items.reduce((s, it) => s + Number(it.price) * Number(it.qty), 0);
  const liquQty = items.reduce((s, it) => {
    const p = products.find((x) => x.product_id === it.product_id);
    return s + (p && p.category === "liquids" ? it.qty : 0);
  }, 0);
  const nextPrice = await getLiquidUnitPrice(liquQty + 1, shopConfig.cityCode);
  const cartLines = items.map((i) => {
    const p = products.find((x) => x.product_id === i.product_id);
    const t = p ? p.title : `#${i.product_id}`;
    const icon = p && p.category === "electronics" ? "💨" : "💧";
    return `${icon} ${t} x${i.qty} · ${i.price.toFixed(2)} €`;
  }).join("\n");
  return { items, savings: Math.round(savings * 100) / 100, total: Math.round(total * 100) / 100, liquQty, nextPrice, cartLines };
}

async function motivation(liquQty: number, nextPrice: number) {
  const p1 = await getLiquidUnitPrice(1, shopConfig.cityCode);
  const p3 = await getLiquidUnitPrice(3, shopConfig.cityCode);
  if (liquQty === 1) {
    const save = Math.max(0, Math.round((p1 * 2 - nextPrice * 2)));
    return `🔥 Выгодное предложение:\nДобавь ещё один вкус и получи две жидкости по ${nextPrice.toFixed(2)}€ (экономия ${save} €)`;
  }
  if (liquQty === 2) return `🎉 Цены пересчитаны!\n\n🔥 Добавь третий: по ${p3.toFixed(2)}€ каждая`;
  return `🎉 Отлично! Максимальная выгода!\n💡 Каждый следующий вкус тоже по ${p3.toFixed(2)} €`;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race<T>([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Operation timeout")), ms)) as Promise<T>
  ]);
}

export async function showHybridUpsellWithGuidance(bot: TelegramBot, chatId: number, messageId: number, userId: number, category: "liquids" | "electronics", excludeIds: number[]) {
  const products = await withTimeout(getProducts(), 5000);
  const { cartLines, total, savings, liquQty, nextPrice } = await computeCartTotals(userId, products);
  const rerollCount = userRerollCount.get(userId) || 0;
  const rerollsLeft = Math.max(0, 3 - rerollCount);
  const totalUpsells = (carts.get(userId) || []).reduce((s, it) => s + (it.is_upsell ? it.qty : 0), 0);
  if (rerollCount >= 3 || totalUpsells >= 5) {
    const kb = [
      [{ text: `✅ Оформить заказ`, callback_data: encodeCb("confirm_order_start") }],
      [{ text: `➕ Добавить ещё вкусы`, callback_data: encodeCb("catalog_liquids") }]
    ];
    const txt = `✅ Отлично! Вкус добавлен в корзину:\n\n${cartLines || "Корзина пустая"}\n\n💰 Итого: ${total.toFixed(2)} €${savings>0?`\n💚 Экономия: ${savings.toFixed(2)} €`:''}`;
    try { await bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: kb }, parse_mode: "HTML" }); } catch {}
    return;
  }
  const excludeSet = new Set<number>(excludeIds);
  const cart = carts.get(userId) || [];
  for (const it of cart) excludeSet.add(it.product_id);
  const available = products.filter(p => p.active && p.category === category && p.qty_available > 0 && !excludeSet.has(p.product_id));
  if (available.length < 2) {
    const kb = [
      [{ text: `📖 Открыть каталог (${nextPrice.toFixed(2)} €)`, callback_data: encodeCb(`upsell_catalog:${category}:${nextPrice}`) }],
      [{ text: `✅ Оформить заказ`, callback_data: encodeCb("confirm_order_start") }]
    ];
    const txt = `✅ Отлично! Вкус добавлен в корзину:\n\n${cartLines || "Корзина пустая"}\n\n💰 Итого: ${total.toFixed(2)} €${savings>0?`\n💚 Экономия: ${savings.toFixed(2)} €`:''}`;
    try { await bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: kb }, parse_mode: "HTML" }); } catch {}
    return;
  }
  const shuffled = available.sort(() => Math.random() - 0.5);
  const upsell1 = shuffled[0];
  const upsell2 = shuffled[1];
  try {
    const db = getDb();
    db.prepare("INSERT INTO upsell_events(user_id, product_id, event_type, timestamp) VALUES (?,?,?,?)").run(userId, upsell1.product_id, "offered", Date.now());
    db.prepare("INSERT INTO upsell_events(user_id, product_id, event_type, timestamp) VALUES (?,?,?,?)").run(userId, upsell2.product_id, "offered", Date.now());
  } catch {}
  userStates.set(userId, { state: "fortune_upsell", data: { category, excludeSkus: Array.from(excludeSet), shown: [upsell1.product_id, upsell2.product_id] }, lastActivity: Date.now() });
  const txt = `✅ Вкус добавлен в корзину:\n\n${cartLines || "Корзина пустая"}\n\n💰 Итого: ${total.toFixed(2)} €${savings>0?`\n💚 Экономия: ${savings.toFixed(2)} €`:''}\n\n${await motivation(liquQty, nextPrice)}\n\n━━━━━━━━━━━━━━━━\n👇 Выбери ещё один вкус:`;
  const suffix = (p: Product) => (p.qty_available > 0 && p.qty_available <= 3) ? ` (только ${p.qty_available}❗️)` : "";
  const kb = [
    [{ text: `💧 ${upsell1.title}${suffix(upsell1)} — ${nextPrice.toFixed(2)} €`, callback_data: encodeCb(`fortune_add:${upsell1.product_id}`) }],
    [{ text: `💧 ${upsell2.title}${suffix(upsell2)} — ${nextPrice.toFixed(2)} €`, callback_data: encodeCb(`fortune_add:${upsell2.product_id}`) }]
  ];
  if (rerollCount < 3) kb.push([{ text: `🎲 Крутить фортуну (ещё ${rerollsLeft})`, callback_data: encodeCb(`fortune_reroll:${category}`) }]);
  kb.push([{ text: `📖 Весь каталог (${nextPrice.toFixed(2)} €)`, callback_data: encodeCb(`upsell_catalog:${category}:${nextPrice}`) }]);
  kb.push([{ text: "✅ Хватит, оформить заказ", callback_data: encodeCb("view_cart") }]);
  try { await bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: kb }, parse_mode: "HTML" }); } catch {}
}
