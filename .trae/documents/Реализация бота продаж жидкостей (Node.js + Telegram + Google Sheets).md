## Стек и базовые принципы

* Backend: Node.js + TypeScript.

* Telegram Bot: `node-telegram-bot-api` (Long Polling).

* Google Sheets: `googleapis` (сервисный аккаунт).

* Локальная БД: SQLite (`better-sqlite3`).

* Планировщик: `node-cron`.

* Веб-обвязка: `express` для `/health` и `/metrics`.

* Часовой пояс: `Europe/Moscow`; формат дат `YYYY-MM-DD`, времени `HH:mm`.

* Константы: `RESERVATION_TTL_MS = 900000` (15 мин); интервалы доставки: `12-14`, `14-16`, `16-18`, `18-20`; шаг слотов 10 мин; скидка апсела 10%.

## Подготовка Google Sheets

* Листы и заголовки:

  * Products: `product_id`, `title`, `price`, `category`, `qty_available`, `upsell_group_id`, `reminder_offset_days`, `active`.

  * Users: `user_id`, `username`, `first_seen`, `last_purchase_date`, `next_reminder_date`, `segment`.

  * Orders (опционально): `order_id`, `user_id`, `items_json`, `total_without_discount`, `total_with_discount`, `discount_total`, `status`, `reserve_timestamp`, `expiry_timestamp`, `courier_id`, `delivery_interval`, `delivery_exact_time`.

  * Couriers: `courier_id`, `name`, `tg_id`, `active`, `last_delivery_interval`.

  * Metrics: `date`, `orders`, `revenue`, `avg_check`, `upsell_clicks`, `upsell_accepts`, `repeat_purchases`, `liquids_sales`, `electronics_sales`, `growth_percent`.

* Типы: `product_id:number`, `price:number`, `category:"liquids"|"electronics"`, `qty_available:number`, `active:boolean`; даты `YYYY-MM-DD`.

* Доступ: сервисный аккаунт с правами редактора на таблицу.

## Переменные окружения

* `TELEGRAM_BOT_TOKEN`

* `TELEGRAM_ADMIN_IDS` (CSV tg\_id админов)

* `GOOGLE_SHEETS_SPREADSHEET_ID`

* `GOOGLE_SERVICE_ACCOUNT_EMAIL`

* `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY` (экранировать `\n`)

* `DB_PATH` (например `./data/app.db`)

* `TIMEZONE` (`Europe/Moscow`)

## Структура проекта

* `src/core/types.ts` — интерфейсы: Product, OrderItem, Order, User, Courier, MetricsRow.

* `src/core/constants.ts` — константы (TTL, интервалы, скидки).

* `src/core/time.ts` — утилиты дат/времени и форматирования.

* `src/infra/config.ts` — загрузка env, проверка.

* `src/infra/logger.ts` — логгер (`info|warn|error`).

* `src/infra/sheets/SheetsClient.ts` — клиент Google Sheets.

* `src/infra/db/sqlite.ts` — подключение БД, инициализация схемы.

* `src/infra/cron/scheduler.ts` — регистрация cron задач.

* `src/domain/inventory/InventoryService.ts` — резервы/списания.

* `src/domain/orders/OrderService.ts` — создание/статусы/слоты.

* `src/domain/upsell/UpsellService.ts` — рекомендации и скидки.

* `src/domain/delivery/DeliveryService.ts` — интервалы и слоты.

* `src/domain/couriers/CourierService.ts` — выбор интервала, активность.

* `src/domain/users/UserService.ts` — регистрация/напоминания.

* `src/domain/metrics/MetricsService.ts` — подсчёт и запись метрик.

* `src/bot/Bot.ts` — инициализация Telegram.

* `src/bot/flows/clientFlow.ts` — клиентский сценарий.

* `src/bot/flows/courierFlow.ts` — сценарий курьера.

* `src/bot/flows/adminFlow.ts` — админ-панель.

* `src/server/http.ts` — HTTP-сервер `/health`, `/metrics`.

* `src/index.ts` — точка входа.

## Инициализация БД (SQLite)

* Таблицы:

  * `orders(order_id INTEGER PK, user_id INTEGER, items_json TEXT, total_without_discount REAL, total_with_discount REAL, discount_total REAL, status TEXT, reserve_timestamp TEXT, expiry_timestamp TEXT, courier_id INTEGER, delivery_interval TEXT, delivery_exact_time TEXT, source TEXT)`.

  * `reservations(id INTEGER PK, order_id INTEGER, product_id INTEGER, qty INTEGER, reserve_timestamp TEXT, expiry_timestamp TEXT, released INTEGER DEFAULT 0)`.

  * `users(user_id INTEGER PK, username TEXT, first_seen TEXT, last_purchase_date TEXT, next_reminder_date TEXT, segment TEXT)`.

  * `couriers(courier_id INTEGER PK, name TEXT, tg_id INTEGER, active INTEGER, last_delivery_interval TEXT)`.

  * `events(id INTEGER PK, date TEXT, type TEXT, order_id INTEGER, user_id INTEGER, payload TEXT)`.

* Индексы: `reservations(order_id)`, `orders(status)`, `events(date,type)`.

* Инициализация при старте: создать таблицы при отсутствии; восстановить `qty_reserved` из активных резерваций.

## Клиент Google Sheets (точные методы)

* `getProducts(): Promise<Product[]>` — чтение `Products`.

* `updateProductQty(product_id: number, new_qty: number): Promise<void>` — обновление строки по `product_id`.

* `getCouriers(): Promise<Courier[]>`, `updateCourier(courier_id: number, fields: Partial<Courier>): Promise<void>`.

* `getUsers(): Promise<User[]>`, `addUser(user: User): Promise<void>`, `updateUser(user_id: number, fields: Partial<User>): Promise<void>`.

* `addOrder(order: Order): Promise<void>` / `updateOrder(order_id: number, fields: Partial<Order>): Promise<void>` / `getOrderById(order_id: number): Promise<Order | null>` — если используем Sheets для заказов.

* Повторы запросов: до 3 с экспоненциальной задержкой.

## InventoryService (CRITICAL)

* В памяти: `qty_reserved: Record<number, number>`; восстанавливать на старте из `reservations`.

* API:

  * `validateStock(product_id:number, qty:number): Promise<boolean>`.

  * `reserveItems(items:OrderItem[], order_id?:number): Promise<void>` — транзакционно: проверка остатков (Sheets.qty\_available - qty\_reserved >= qty), запись в `reservations` с TTL, увеличение `qty_reserved`.

  * `releaseReservation(items:OrderItem[], order_id?:number): Promise<void>` — уменьшить `qty_reserved`, пометить `released=1`.

  * `finalDeduction(items:OrderItem[]): Promise<void>` — чтение из Sheets, `new_qty = qty_available - qty_to_deduct`, запись.

* Автосброс:

  * Cron каждые 1 мин: истёкшие резервы → статус заказа `expired`, снять резервы.

## OrderService

* Статусы: `buffer`, `pending`, `courier_assigned`, `delivered`, `expired`, `cancelled`.

* API:

  * `createOrder(user_id:number, items:OrderItem[], source?:"normal"|"reminder"): Promise<Order>` — пишет `orders`, вызывает `reserveItems`, выставляет `reserve_timestamp`, `expiry_timestamp`.

  * `confirmOrder(order_id:number): Promise<void>` → `status="pending"`.

  * `setDeliverySlot(order_id:number, interval:string, exact_time:string): Promise<void>` — валидация через DeliveryService.

  * `setCourierAssigned(order_id:number, courier_id:number): Promise<void>` → `status="courier_assigned"`.

  * `setDelivered(order_id:number): Promise<void>` — вызов `finalDeduction`, `releaseReservation`, `status="delivered"`, `UserService.updateAfterDelivery`.

  * `cancelOrder(order_id:number): Promise<void>` — снять резервы, `status="cancelled"`.

  * `expireOrder(order_id:number): Promise<void>` — снять резервы, `status="expired"`.

  * `getOrderById(order_id:number): Promise<Order|null>`.

* Переходы: `buffer -> pending -> courier_assigned -> delivered`; `buffer -> expired`; `pending|courier_assigned -> cancelled`.

## UpsellService

* `getUpsellSuggestions(primary:OrderItem[], products:Product[]): Product[]` — по совпадающему `upsell_group_id` первичных позиций, максимум 6, сортировка по цене.

* `recalculateTotals(items:OrderItem[]): {total_without_discount:number,total_with_discount:number,discount_total:number}` — скидка 10% только на `is_upsell`.

* При добавлении апсела: `reserveItems` для новых позиций, обновить `items_json`.

## DeliveryService

* Интервалы: `12-14`, `14-16`, `16-18`, `18-20`.

* `generateTimeSlots(interval:string): string[]` — шаг 10 мин, включая границы.

* `validateSlot(interval:string, time:string, now:Date): boolean` — слот внутри интервала и не прошлый.

## CourierService

* `getActiveCouriers(): Promise<Courier[]>` — из Sheets/кэша.

* `setCourierInterval(courier_id:number, interval:string): Promise<void>` — сохраняет в Sheets.

* Сценарии: взять заказ → `courier_assigned`; доставлено → финальное списание; отменить → снятие резерва.

## UserService

* `ensureUser(user_id:number, username:string): Promise<void>` — регистрирует в БД/опционально в Sheets.

* `updateAfterDelivery(user_id:number, items:OrderItem[]): Promise<void>` — `last_purchase_date=today`, `next_reminder_date=today + max(reminder_offset_days для liquids)`.

## MetricsService

* `computeDailyMetrics(date:string): Promise<MetricsRow>` — по доставленным заказам и событиям.

* `writeDailyMetrics(row:MetricsRow): Promise<void>` — запись в лист `Metrics`.

* Метрики: `orders`, `revenue`, `avg_check`, `upsell_clicks`, `upsell_accepts`, `repeat_purchases`, `liquids_sales`, `electronics_sales`, `growth_percent`.

## Telegram — клиентский флоу

* Команды: `/start` → регистрация, показ категорий.

* Выбор товаров: карточки с `Добавить в корзину`.

* Апсел: `Перейти к апселу` → предложения, `Добавить`/`Пропустить`.

* Подтверждение: `Подтвердить заказ` → `confirm_order`.

* Выбор точного времени: показать текущий интервал курьера и слоты, `select_slot`.

* Callback data:

  * `add_item:{product_id}`

  * `add_upsell:{product_id}`

  * `confirm_order:{order_id}`

  * `select_slot:{order_id}:{HH:mm}`

* Сообщения включают цены, скидки, итог, интервал/слот.

## Telegram — курьерский флоу

* `/courier` — режим курьера; список `pending`.

* Кнопки: `Взять {order_id}` → `courier_assigned`; `Доставлено {order_id}` → финальное списание, `delivered`; `Отменить {order_id}` → `cancelled`.

* Настройки: `Выбрать интервал` — из фиксированного списка, сохранение в Sheets.

## Telegram — админ-панель

* `/admin` — меню:

  * Список товаров (READ из Sheets) — пагинация 10.

  * Список заказов — фильтры по статусу/дате.

  * Курьеры — `active on/off`, выбор интервала.

  * Метрики — последние 7 дней.

  * Апсел-статистика — `upsell_clicks`, `upsell_accepts`.

  * Обновить товары — форс reload кэша Products.

  * Тест напоминаний — отправка теста выбранному `user_id`.

* Доступ: `TELEGRAM_ADMIN_IDS`.

## Cron

* `*/1 * * * *` — истечение резервов: снять, `expired`.

* `0 10 * * *` — рассылка напоминаний.

* `0 0 * * *` — подсчёт и запись `Metrics`.

## HTTP-сервер

* `GET /health` — статус процесса, подключений.

* `GET /metrics` — последние агрегаты из БД (легковесно).

## Логирование, ошибки, валидации

* Логирование: уровни, привязка `order_id`.

* Повторы для Sheets: 3 попытки с backoff.

* Валидации: `qty>0` (целое), слот в пределах интервала и не в прошлом, скидка только на `is_upsell`.

* Обработка ошибок: недостаток остатка → показать пользователю предложение уменьшить количество.

## Тестирование и верификация

* Сценарии:

  * Резерв/истечение: заказ → спустя 15 мин `expired`, резервы сняты.

  * Апсел: добавление апсел-товара → `discount_total=10%` от апсел-позиций.

  * Доставка: выбор слота внутри интервала; попытка вне — отказ.

  * Курьер: взять → доставить → уменьшить Sheets `qty_available`; обновить `next_reminder_date`.

  * Напоминания: `next_reminder_date=today` → отправка + новый заказ.

  * Метрики: за день с доставками → корректные `orders`, `revenue`, `avg_check`.

  * Админ: доступ, просмотр и управление курьерами/товарами.

## Пошаговая реализация (безопасная последовательность)

1. Инициализация проекта: `npm init`, TypeScript, конфиг env, logger.
2. Реализация `sqlite.ts`: схемы таблиц, миграция/инициализация.
3. Реализация `SheetsClient.ts`: авторизация, чтение/запись, методы для Products/Users/Couriers/Orders.
4. Реализация `InventoryService`: `qty_reserved` восстановление, резерв/снятие/финальное списание.
5. Реализация `OrderService`: создание, подтверждение, слоты, переходы статусов.
6. Реализация `DeliveryService`: интервалы/слоты/валидация.
7. Реализация `UpsellService`: рекомендации и пересчёт тоталов.
8. Реализация `UserService`: регистрация, обновления после доставки.
9. Реализация `CourierService`: активность, выбор интервала, назначение заказа.
10. Реализация `MetricsService`: подсчёт и запись.
11. Реализация Telegram `Bot.ts` и флоу: клиент/курьер/админ.
12. Реализация cron задач и `server/http.ts`.
13. Ручные проверки, интеграционные сценарии, корректировки.

## Критерии готовности (финально)

* Товары грузятся из Google Sheets; списания уменьшают `qty_available` корректно.

* Резерв 15 минут, автосброс истёкших.

* Апсел отображается, скидка 10% считается.

* Клиент выбирает точное время в интервале курьера; слоты корректны.

* Курьер выбирает интервал 1 раз в день, сохраняется.

* `Доставлено` делает финальное списание и обновляет пользователя.

* Напоминания по расписанию, повторные продажи создают новый заказ.

* Метрики считаются ежедневно и пишутся в `Metrics`.

* Админ-панель доступна и управляет товарами/курьерами/заказами/метриками.

