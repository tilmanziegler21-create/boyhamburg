export const shopConfig = {
  cityCode: process.env.CITY_CODE || "HG",
  shopName: process.env.SHOP_NAME || "ELFIN Market",
  welcomeMessage: (process.env.WELCOME_MESSAGE ||
    [
      "💨 ELFIN Market — первый онлайн-магазин жидкостей",
      "ELFIQ / CHASER — оригинал, стабильное качество",
      "Заказ и выбор времени выдачи в одном месте",
      "",
      "💶 Цены:",
      "1 шт — 18 €",
      "2 шт — 32 €",
      "3 шт — 45 €",
      "",
      "🚚 Курьерская доставка — выбираете удобный слот при оформлении",
      "⭐ Постоянные клиенты, реальные отзывы",
      "",
      "👇 Оформление заказа — 1 минута",
    ].join("\n")).trim(),
  telegramGroupUrl: process.env.TELEGRAM_GROUP_URL || "https://t.me/elfinmarket_hg",
  reviewsUrl: process.env.REVIEWS_URL || "https://t.me/elfin_reviews",
};
