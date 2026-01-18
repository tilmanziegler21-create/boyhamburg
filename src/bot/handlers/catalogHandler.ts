import TelegramBot from "node-telegram-bot-api";
import { getProducts } from "../../infra/data";
import { formatProductName } from "../../utils/products";
import { carts, userStates } from "../../infra/storage/InMemoryStorage";
import { getDb } from "../../infra/db/sqlite";
import { encodeCb } from "../cb";

function renderCart(userId: number, products: Awaited<ReturnType<typeof getProducts>>) {
  const items = carts.get(userId) || [];
  const lines = items.map((i) => {
    const p = products.find((x) => x.product_id === i.product_id);
    const t = p ? formatProductName(p as any) : `#${i.product_id}`;
    const icon = p && p.category === "electronics" ? "💨" : "💧";
    return `${icon} ${t} x${i.qty} · ${i.price.toFixed(2)} €`;
  }).join("\n") || "Корзина пустая";
  const total = items.reduce((s, it) => s + Number(it.price) * Number(it.qty), 0);
  let savings = 0;
  for (const it of items) {
    const p = products.find((x) => x.product_id === it.product_id);
    if (p && p.category === "liquids" && it.price < 18) savings += (18 - it.price) * it.qty;
  }
  return { lines, total: Math.round(total * 100) / 100, savings: Math.round(savings * 100) / 100 };
}

export async function showUpsellCatalog(bot: TelegramBot, chatId: number, messageId: number, userId: number, category: "liquids" | "electronics", price: number) {
  const products = await getProducts();
  const cart = carts.get(userId) || [];
  const cartIds = cart.map(i => i.product_id);
  const state = userStates.get(userId);
  const prevExcluded = Array.isArray(state?.data?.excludeSkus) ? state.data.excludeSkus : [];
  const exclude = new Set<number>([...cartIds, ...prevExcluded]);
  const available = products.filter(p => p.active && p.category === category && p.qty_available > 0 && !exclude.has(p.product_id));
  available.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  const { lines, total, savings } = renderCart(userId, products);
  const txt = `✅ Твоя корзина:\n\n${lines}\n\n💰 Итого: ${total.toFixed(2)} €${savings>0?`\n💚 Экономия: ${savings.toFixed(2)} €`:''}\n\n📖 Полный каталог вкусов\n\nЦена следующего вкуса: ${Number(price).toFixed(2)} €`;
  const kb: TelegramBot.InlineKeyboardButton[][] = [];
  const suffix = (p: any) => (p.qty_available > 0 && p.qty_available <= 3) ? ` (только ${p.qty_available}❗️)` : "";
  for (let i = 0; i < available.length; i += 2) {
    const row: TelegramBot.InlineKeyboardButton[] = [];
    const p1 = available[i];
    try { getDb().prepare("INSERT INTO upsell_events(user_id, product_id, event_type, timestamp) VALUES (?,?,?,?)").run(userId, p1.product_id, "offered", Date.now()); } catch {}
    row.push({ text: `💧 ${p1.title}${suffix(p1)}`, callback_data: encodeCb(`catalog_add:${p1.product_id}`) });
    if (i + 1 < available.length) {
      const p2 = available[i + 1];
      try { getDb().prepare("INSERT INTO upsell_events(user_id, product_id, event_type, timestamp) VALUES (?,?,?,?)").run(userId, p2.product_id, "offered", Date.now()); } catch {}
      row.push({ text: `💧 ${p2.title}${suffix(p2)}`, callback_data: encodeCb(`catalog_add:${p2.product_id}`) });
    }
    kb.push(row);
  }
  kb.push([{ text: "⬅️ Корзина", callback_data: encodeCb("view_cart") }]);
  kb.push([{ text: "✅ Оформить заказ", callback_data: encodeCb("confirm_order") }]);
  try { await bot.editMessageText(txt, { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: kb }, parse_mode: "HTML" }); } catch {}
}
