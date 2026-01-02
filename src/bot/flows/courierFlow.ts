import TelegramBot from "node-telegram-bot-api";
import { getDb } from "../../infra/db/sqlite";
import { setDelivered, getOrderById } from "../../domain/orders/OrderService";
import { getProducts } from "../../infra/data";
import { encodeCb, decodeCb } from "../cb";
import { logger } from "../../infra/logger";

export function registerCourierFlow(bot: TelegramBot) {
  bot.onText(/\/courier/, async (msg) => {
    const chatId = msg.chat.id;
    const myList = getDb()
      .prepare("SELECT o.order_id, o.user_id, o.delivery_interval, o.delivery_exact_time, u.username FROM orders o LEFT JOIN users u ON o.user_id=u.user_id WHERE o.status IN ('pending','courier_assigned') AND o.courier_id = ? ORDER BY o.order_id DESC LIMIT 100")
      .all(msg.from?.id) as any[];
    const lines = myList.map((o) => `#${o.order_id} ${o.username ? "@" + o.username : "Клиент"} · ${o.delivery_exact_time || "?"}`);
    const keyboard = myList.map((o) => [
      { text: `Выдача ${o.order_id}`, callback_data: encodeCb(`courier_issue:${o.order_id}`) },
      { text: `Не выдано ${o.order_id}`, callback_data: encodeCb(`courier_not_issued:${o.order_id}`) }
    ]);
    keyboard.push([
      { text: "Интервал 12-14", callback_data: "set_interval:12-14" },
      { text: "14-16", callback_data: "set_interval:14-16" },
      { text: "16-18", callback_data: "set_interval:16-18" },
      { text: "18-20", callback_data: "set_interval:18-20" }
    ]);
    keyboard.push([{ text: "🏠 Главное меню", callback_data: encodeCb("back:main") }]);
    await bot.sendMessage(chatId, lines.join("\n") || "Нет заказов", { reply_markup: { inline_keyboard: keyboard } });
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
    if (data.startsWith("courier_issue:")) {
      const id = Number(data.split(":")[1]);
      await setDelivered(id, q.from.id);
      try {
        await bot.deleteMessage(chatId, q.message?.message_id as number);
      } catch {
        try { await bot.editMessageText(`Заказ #${id} выдан`, { chat_id: chatId, message_id: q.message?.message_id as number }); } catch {}
      }
      try {
        const myList = getDb()
          .prepare("SELECT o.order_id, o.user_id, o.delivery_interval, o.delivery_exact_time, u.username FROM orders o LEFT JOIN users u ON o.user_id=u.user_id WHERE o.status IN ('pending','courier_assigned') AND o.courier_id = ? ORDER BY o.order_id DESC LIMIT 100")
          .all(q.from.id) as any[];
        const lines2 = myList.map((o) => `#${o.order_id} ${o.username ? "@" + o.username : "Клиент"} · ${o.delivery_exact_time || "?"}`);
        const keyboard2 = myList.map((o) => [
          { text: `Выдача ${o.order_id}`, callback_data: encodeCb(`courier_issue:${o.order_id}`) },
          { text: `Не выдано ${o.order_id}`, callback_data: encodeCb(`courier_not_issued:${o.order_id}`) }
        ]);
        keyboard2.push([
          { text: "Интервал 12-14", callback_data: "set_interval:12-14" },
          { text: "14-16", callback_data: "set_interval:14-16" },
          { text: "16-18", callback_data: "set_interval:16-18" },
          { text: "18-20", callback_data: "set_interval:18-20" }
        ]);
        keyboard2.push([{ text: "🏠 Главное меню", callback_data: encodeCb("back:main") }]);
        await bot.sendMessage(chatId, lines2.join("\n") || "Нет заказов", { reply_markup: { inline_keyboard: keyboard2 } });
      } catch {}
      const order = await getOrderById(id);
      console.log('ORDER FROM DB', order);
      if (order) {
        try {
          await bot.sendMessage(order.user_id, "Спасибо за заказ! Приходите к нам ещё.");
          setTimeout(async () => {
            try {
              const products = await getProducts();
              const liqu = products.filter((p) => p.active && p.category === "liquids");
              const primaryId = order.items.find((i) => liqu.find((p) => p.product_id === i.product_id))?.product_id;
              const primary = liqu.find((p) => p.product_id === primaryId) || liqu[0];
              const similar = liqu.find((p) => p.upsell_group_id && primary && p.upsell_group_id === primary.upsell_group_id && p.product_id !== primary.product_id) || liqu[1] || primary;
              const rows = [[
                { text: `Похожий: ${similar.title} · 15.00 €`, callback_data: encodeCb(`add_upsell:${similar.product_id}`) }
              ], [
                { text: "Перейти к каталогу", callback_data: encodeCb("menu_catalog") }
              ]];
              await bot.sendMessage(order.user_id, "Как вам прошлый вкус? Хотите попробовать похожий?", { reply_markup: { inline_keyboard: rows } });
            } catch {}
          }, 60_000);
        } catch {}
      }
    } else if (data.startsWith("courier_not_issued:")) {
      const id = Number(data.split(":")[1]);
      try {
        const { setNotIssued, getOrderById } = await import("../../domain/orders/OrderService");
        await setNotIssued(id);
        const order = await getOrderById(id);
        if (order) {
          try { await bot.sendMessage(order.user_id, "❗ Заказ не выдан и удалён из очереди. Оформите новый заказ при необходимости." ); } catch {}
        }
        const myList = getDb()
          .prepare("SELECT o.order_id, o.user_id, o.delivery_interval, o.delivery_exact_time, u.username FROM orders o LEFT JOIN users u ON o.user_id=u.user_id WHERE o.status IN ('pending','courier_assigned') AND o.courier_id = ? ORDER BY o.order_id DESC LIMIT 100")
          .all(q.from.id) as any[];
        const lines2 = myList.map((o) => `#${o.order_id} ${o.username ? "@" + o.username : "Клиент"} · ${o.delivery_exact_time || "?"}`);
        const keyboard2 = myList.map((o) => [
          { text: `Выдача ${o.order_id}`, callback_data: encodeCb(`courier_issue:${o.order_id}`) },
          { text: `Не выдано ${o.order_id}`, callback_data: encodeCb(`courier_not_issued:${o.order_id}`) }
        ]);
        keyboard2.push([
          { text: "Интервал 12-14", callback_data: "set_interval:12-14" },
          { text: "14-16", callback_data: "set_interval:14-16" },
          { text: "16-18", callback_data: "set_interval:16-18" },
          { text: "18-20", callback_data: "set_interval:18-20" }
        ]);
        keyboard2.push([{ text: "🏠 Главное меню", callback_data: encodeCb("back:main") }]);
        await bot.sendMessage(chatId, lines2.join("\n") || "Нет заказов", { reply_markup: { inline_keyboard: keyboard2 } });
      } catch {}
    } else if (data.startsWith("set_interval:")) {
      const interval = data.split(":")[1];
      // store courier interval via Sheets/data layer
      // reuse existing setCourierInterval from CourierService through admin or direct; here we update user-specific tg_id as courier_id
      const db = getDb();
      const existing = db
        .prepare("SELECT courier_id FROM couriers WHERE tg_id = ?")
        .get(q.from.id) as any;
      const courierId = existing?.courier_id || q.from.id;
      try {
        const { setCourierInterval } = await import("../../domain/couriers/CourierService");
        await setCourierInterval(courierId, interval);
      } catch {}
      await bot.sendMessage(chatId, `Интервал установлен: ${interval}`);
    }
  });
}
