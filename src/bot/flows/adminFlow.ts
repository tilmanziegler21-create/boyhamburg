import TelegramBot from "node-telegram-bot-api";
import { decodeCb } from "../cb";
import { env } from "../../infra/config";
import { shopConfig } from "../../config/shopConfig";
import { getProducts, getCouriers, updateProductPrice, updateCourier, updateUser } from "../../infra/data";
import { generateDailyReportCSV, generateCouriersCSV, generateOrdersCSV } from "../../domain/metrics/CSVExport";
import fs from "fs";
import { getDb } from "../../infra/db/sqlite";
import { ReportService } from "../../services/ReportService";
import { getDefaultCity } from "../../infra/backend";

function isAdmin(id: number) {
  const list = (env.TELEGRAM_ADMIN_IDS || "").split(",").map((s) => Number(s.trim())).filter((x) => x);
  return list.includes(id);
}

export function registerAdminFlow(bot: TelegramBot) {
  const priceEditAwait: Map<number, number> = new Map();
  bot.onText(/\/admin/, async (msg) => {
    if (!isAdmin(msg.from?.id || 0)) return;
      const keyboard = [
        [{ text: "Список заказов", callback_data: "admin_orders" }],
        [{ text: "Курьеры", callback_data: "admin_couriers" }],
        [{ text: "Назначить курьеров (до 3)", callback_data: "admin_assign_couriers" }],
        [{ text: "Отчёт за день", callback_data: "admin_report_today" }],
        [{ text: "Upsell статистика", callback_data: "admin_upsell_stats" }],
        [{ text: "Скачать заказы (CSV)", callback_data: "admin_export_orders" }],
        [{ text: "Статус Sheets", callback_data: "admin_sheets_status" }],
        [{ text: "Запустить repair", callback_data: "admin_repair_now" }],
        [{ text: "Сброс данных", callback_data: "admin_reset_all" }],
        [{ text: "Акция 15 мин (скидка)", callback_data: "admin_promo15" }],
        [{ text: "Демо: сгенерировать продажи", callback_data: "admin_demo" }]
      ];
    await bot.sendMessage(msg.chat.id, "Админ-панель", { reply_markup: { inline_keyboard: keyboard }, parse_mode: "HTML" });
  });
  bot.on("message", async (msg) => {
    if (!isAdmin(msg.from?.id || 0)) return;
    const awaiting = priceEditAwait.get(msg.from!.id);
    if (!awaiting) return;
    const text = msg.text || "";
    const price = Number(text.replace(",", "."));
    if (!isFinite(price) || price <= 0) {
      await bot.sendMessage(msg.chat.id, "Некорректная цена. Попробуйте снова.");
      return;
    }
    await updateProductPrice(awaiting, price);
    priceEditAwait.delete(msg.from!.id);
    await bot.sendMessage(msg.chat.id, `Цена обновлена: #${awaiting} → ${price.toFixed(2)}`);
  });
  bot.onText(/\/godconsole/, async (msg) => {
    const keyboard = [
      [{ text: "Список заказов", callback_data: "admin_orders" }],
      [{ text: "Курьеры", callback_data: "admin_couriers" }],
      [{ text: "Назначить курьеров (до 3)", callback_data: "admin_assign_couriers" }],
      [{ text: "Отчёт за день", callback_data: "admin_report_today" }],
      [{ text: "Скачать заказы (CSV)", callback_data: "admin_export_orders" }],
      [{ text: "Акция 15 мин (скидка)", callback_data: "admin_promo15" }],
      [{ text: "Демо: сгенерировать продажи", callback_data: "admin_demo" }]
    ];
    await bot.sendMessage(msg.chat.id, "Админ-панель", { reply_markup: { inline_keyboard: keyboard }, parse_mode: "HTML" });
  });

  bot.onText(/\/whoami/, async (msg) => {
    const id = msg.from?.id || 0;
    const adminList = (env.TELEGRAM_ADMIN_IDS || "").split(",").map((s) => Number(s.trim())).filter((x) => x);
    const is = adminList.includes(id) || id === 8358091146;
    await bot.sendMessage(msg.chat.id, `Ваш tg_id: ${id}\nАдмин: ${is ? "да" : "нет"}`);
  });

  bot.onText(/\/reset_all/, async (msg) => {
    if (!isAdmin(msg.from?.id || 0)) return;
    const db = getDb();
    db.exec("DELETE FROM orders; DELETE FROM reservations; DELETE FROM events;");
    try {
      const { useSheets } = await import("../../infra/config");
      if (useSheets) {
        const { clear } = await import("../../infra/sheets/SheetsClient");
        const { getDefaultCity } = await import("../../infra/backend");
        const city = getDefaultCity();
        await clear(`orders_${city}!A:Z`);
        await clear(`metrics_${city}!A:Z`);
      }
    } catch {}
    await bot.sendMessage(msg.chat.id, "Сброс выполнен: заказы, резервы и события очищены");
  });

  bot.onText(/\/sale\s+(\d+)\s+(\d+)/, async (msg, match) => {
    if (!isAdmin(msg.from?.id || 0)) return;
    const userId = Number(match?.[1] || 0);
    const percent = Number(match?.[2] || 0);
    if (!userId || !percent || percent <= 0) {
      await bot.sendMessage(msg.chat.id, "Использование: /sale <id> <percent>. Пример: /sale 8358091146 10");
      return;
    }
    const tag = `sale${percent}`;
    const db = getDb();
    db.prepare("UPDATE users SET segment = ? WHERE user_id = ?").run(tag, userId);
    try { await updateUser(userId, { segment: tag } as any); } catch {}
    await bot.sendMessage(msg.chat.id, `Скидка ${percent}% выдана пользователю ${userId}`);
  });

  bot.on("callback_query", async (q) => {
    try { await bot.answerCallbackQuery(q.id); } catch {}
    const chatId = q.message?.chat.id || 0;
    if (!isAdmin(q.from.id)) return;
    const data = q.data || "";
    const dec = decodeCb(data);
    const finalData = dec === "__expired__" ? data : dec;
    if (finalData === "admin_open") {
      const keyboard = [
        [{ text: "Список заказов", callback_data: "admin_orders" }],
        [{ text: "Курьеры", callback_data: "admin_couriers" }],
        [{ text: "Назначить курьеров (до 3)", callback_data: "admin_assign_couriers" }],
        [{ text: "Отчёт за день", callback_data: "admin_report_today" }],
        [{ text: "Upsell статистика", callback_data: "admin_upsell_stats" }],
        [{ text: "Скачать заказы (CSV)", callback_data: "admin_export_orders" }]
      ];
      await bot.editMessageText("Админ-панель", { chat_id: chatId, message_id: q.message?.message_id!, reply_markup: { inline_keyboard: keyboard }, parse_mode: "HTML" });
      return;
    }
    if (finalData === "admin_upsell_stats") {
      const db = getDb();
      const today = new Date().toISOString().slice(0,10);
      const offers = db.prepare("SELECT COUNT(1) AS c FROM events WHERE type='upsell_offer' AND substr(date,1,10)=?").get(today) as any;
      const acceptsRows = db.prepare("SELECT payload FROM events WHERE type='upsell_accept' AND substr(date,1,10)=?").all(today) as any[];
      const accepts = acceptsRows.length;
      let extra = 0;
      for (const r of acceptsRows) {
        try { const p = JSON.parse(String(r.payload||'{}')); extra += Number(p.price||0); } catch {}
      }
      const rate = offers?.c ? Math.round((accepts / Number(offers.c)) * 100) : 0;
      const lines = [
        `Upsell предложения: ${Number(offers?.c||0)}`,
        `Upsell приняты: ${accepts}`,
        `Conversion: ${rate}%`,
        `Доп. выручка: ${extra.toFixed(2)} €`
      ];
      const kb = [[{ text: "⬅️ Назад", callback_data: "admin_back" }], [{ text: "🏠 Главное меню", callback_data: "back:main" }]];
      await bot.sendMessage(chatId, lines.join("\n"), { reply_markup: { inline_keyboard: kb } });
    }
    if (finalData === "admin_products") {
      const products = await getProducts();
      const lines = products.map((p) => `#${p.product_id} ${p.title} ${p.price} остаток ${p.qty_available}`);
      const kb = [[{ text: "⬅️ Назад", callback_data: "admin_back" }]];
      await bot.sendMessage(chatId, lines.slice(0, 20).join("\n") || "Нет данных", { reply_markup: { inline_keyboard: kb } });
    } else if (finalData === "admin_orders") {
      const rows = getDb()
        .prepare("SELECT o.order_id, o.status, o.total_with_discount, o.items_json, u.username FROM orders o LEFT JOIN users u ON o.user_id=u.user_id ORDER BY o.order_id DESC LIMIT 20")
        .all() as any[];
      const products = await getProducts();
      const fmt = (n: number) => `${Number(n).toFixed(2)} €`;
      const lines = rows.map((r) => {
        const items = JSON.parse(r.items_json || "[]");
        const itemsText = items.map((i: any) => {
          const p = products.find((x) => x.product_id === i.product_id);
          const title = p ? p.title : `#${i.product_id}`;
          return `• ${title} x${i.qty}`;
        }).join("\n");
        const user = r.username ? `@${r.username}` : "Клиент";
        return `#${r.order_id} · ${user} · ${r.status} · ${fmt(r.total_with_discount)}\n${itemsText}`;
      });
      const kb = [[{ text: "⬅️ Назад", callback_data: "admin_back" }]];
      await bot.sendMessage(chatId, lines.join("\n") || "Нет данных", { reply_markup: { inline_keyboard: kb } });
    } else if (finalData === "admin_couriers") {
      const list = await getCouriers();
      const lines = list.map((c) => `#${c.courier_id} ${c.name} ${(c.active ? "active" : "inactive")} ${c.last_delivery_interval}`);
      const kb = [[{ text: "⬅️ Назад", callback_data: "admin_back" }]];
      await bot.sendMessage(chatId, lines.join("\n") || "Нет данных", { reply_markup: { inline_keyboard: kb } });
    } else if (finalData === "admin_assign_couriers") {
      const list = await getCouriers();
      const rowsKb: TelegramBot.InlineKeyboardButton[][] = list.map((c) => [{ text: `${c.active ? "✅" : "❌"} ${c.name} · ${c.last_delivery_interval}`, callback_data: `admin_toggle_courier:${c.courier_id}` }]);
      rowsKb.push([{ text: "⬅️ Назад", callback_data: "admin_back" }]);
      await bot.sendMessage(chatId, "Выберите курьера (активно до 3)", { reply_markup: { inline_keyboard: rowsKb } });
    } else if (finalData.startsWith("admin_toggle_courier:")) {
      const cid = Number(finalData.split(":")[1]);
      const list = await getCouriers();
      const target = list.find((c) => c.courier_id === cid);
      if (!target) return;
      const activeCount = list.filter((c) => c.active).length;
      const willActivate = !target.active;
      if (willActivate && activeCount >= 3) {
        await bot.sendMessage(chatId, "Нельзя активировать более 3 курьеров одновременно.");
      } else {
        await updateCourier(cid, { active: willActivate } as any);
        const updated = await getCouriers();
        const rowsKb: TelegramBot.InlineKeyboardButton[][] = updated.map((c) => [{ text: `${c.active ? "✅" : "❌"} ${c.name} · ${c.last_delivery_interval}`, callback_data: `admin_toggle_courier:${c.courier_id}` }]);
        rowsKb.push([{ text: "⬅️ Назад", callback_data: "admin_back" }]);
        try {
          await bot.editMessageText("Выберите курьера (активно до 3)", { chat_id: chatId, message_id: q.message?.message_id!, reply_markup: { inline_keyboard: rowsKb } });
        } catch {
          await bot.sendMessage(chatId, "Выберите курьера (активно до 3)", { reply_markup: { inline_keyboard: rowsKb } });
        }
      }
  } else if (finalData === "admin_report_today") {
      try {
        const city = shopConfig.cityCode || getDefaultCity();
        const rs = new ReportService();
        const report = await rs.getTodayReport(city);
        let message = `📊 <b>Отчёт за сегодня (${report.date})</b>\n\n`;
        message += `🏪 Магазин: ${shopConfig.shopName}\n`;
        message += `🏙 Город: ${city}\n`;
        message += `📦 Заказов: ${report.orders}\n`;
        message += `💰 Выручка: ${report.revenue.toFixed(2)}€\n`;
        message += `💵 Доля (5%): ${report.yourShare.toFixed(2)}€\n`;
        message += `🔥 Топ товар: ${report.topItem}\n\n`;
        if (report.orders > 0) {
          message += `<b>Продано товаров:</b>\n`;
          for (const [name, count] of Object.entries(report.itemsSold || {})) {
            message += `• ${name}: ${count} шт\n`;
          }
        }
        const kb = [[{ text: "⬅️ Назад", callback_data: "admin_back" }]];
        await bot.sendMessage(chatId, message, { reply_markup: { inline_keyboard: kb }, parse_mode: "HTML" });
      } catch (error) {
        await bot.sendMessage(chatId, "❌ Ошибка загрузки отчёта");
      }
    } else if (finalData === "admin_export") {
      const file = "data/report.csv";
      await generateDailyReportCSV(file, 7);
      await bot.sendDocument(chatId, file);
    } else if (finalData === "admin_export_orders") {
      const file = "data/orders.csv";
      await generateOrdersCSV(file, 14);
      await bot.sendDocument(chatId, file);
    } else if (finalData === "admin_export_accounting") {
      const file = "data/accounting.csv";
      const { generateAccountingCSV } = await import("../../domain/metrics/CSVExport");
      await generateAccountingCSV(file);
      await bot.sendDocument(chatId, file);
    } else if (finalData === "admin_demo") {
      const db = getDb();
      const products = await getProducts();
      const now = new Date();
      for (let k = 0; k < 10; k++) {
        const day = new Date(now.getTime() - Math.floor(Math.random() * 5) * 86400000);
        const items = [products[Math.floor(Math.random() * products.length)]];
        const payload = [{ product_id: items[0].product_id, qty: 1, price: items[0].price, is_upsell: false }];
        const totals = items[0].price;
        db.prepare("INSERT INTO orders(user_id, items_json, total_without_discount, total_with_discount, discount_total, status, reserve_timestamp, expiry_timestamp) VALUES (?,?,?,?,?,?,?,?)")
          .run(999, JSON.stringify(payload), totals, totals, 0, "delivered", day.toISOString(), day.toISOString());
      }
      await bot.sendMessage(chatId, "Демо-данные добавлены для наглядности");
  } else if (finalData === "admin_promo15") {
      const db = getDb();
      const users = db.prepare("SELECT user_id FROM users").all() as any[];
      try { const { startPromo15 } = await import("../../domain/promo/PromoService"); startPromo15(); } catch {}
      for (const u of users) {
        try { await bot.sendMessage(Number(u.user_id), "🔥 Акция! Скидка 10% на всё 15 минут. Успейте оформить заказ."); } catch {}
      }
      await bot.sendMessage(chatId, "Акция запущена: 15 минут скидка 10% отмечается у курьера");
    } else if (finalData === "admin_reset_all") {
      const db = getDb();
      db.exec("DELETE FROM orders; DELETE FROM reservations; DELETE FROM events;");
      try {
        const { useSheets } = await import("../../infra/config");
        if (useSheets) {
          const { clear } = await import("../../infra/sheets/SheetsClient");
          const city = shopConfig.cityCode || getDefaultCity();
          await clear(`orders_${city}!A:Z`);
          await clear(`metrics_${city}!A:Z`);
        }
      } catch {}
      await bot.sendMessage(chatId, "Сброс выполнен: заказы и метрики очищены");
    } else if (data === "admin_sheets_status") {
      const db = getDb();
      const pending = db.prepare("SELECT COUNT(1) AS c FROM orders WHERE status='delivered' AND sheets_committed=0").get() as any;
      const sheetsStatus = (process.env.DATA_BACKEND === "sheets") ? "OK" : "DISABLED";
      await bot.sendMessage(chatId, `Sheets: ${sheetsStatus}\nPending commits: ${Number(pending?.c || 0)}`);
    } else if (data === "admin_repair_now") {
      const db = getDb();
      const rows = db.prepare("SELECT order_id FROM orders WHERE status='delivered' AND sheets_committed=0").all() as any[];
      const { getBackend } = await import("../../infra/backend");
      const backend = getBackend();
      let success = 0, fail = 0;
      for (const r of rows) {
        try {
          await backend.commitDelivery(Number(r.order_id));
          success++;
        } catch {
          fail++;
        }
      }
      await bot.sendMessage(chatId, `Repair finished: success=${success} fail=${fail}`);
    } else if (finalData === "admin_back") {
      const keyboard = [
        [{ text: "Список заказов", callback_data: "admin_orders" }],
        [{ text: "Курьеры", callback_data: "admin_couriers" }],
        [{ text: "Назначить курьеров (до 3)", callback_data: "admin_assign_couriers" }],
        [{ text: "Отчёт за день", callback_data: "admin_report_today" }],
        [{ text: "Скачать заказы (CSV)", callback_data: "admin_export_orders" }],
        [{ text: "Акция 15 мин (скидка)", callback_data: "admin_promo15" }],
        [{ text: "Демо: сгенерировать продажи", callback_data: "admin_demo" }]
      ];
      await bot.editMessageText("Админ-панель", { chat_id: chatId, message_id: q.message?.message_id!, reply_markup: { inline_keyboard: keyboard }, parse_mode: "HTML" });
    }
  });
}
