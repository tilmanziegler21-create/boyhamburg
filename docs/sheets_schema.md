# Google Sheets схема

## Режим A: TABS_PER_CITY
- Вкладки: `products_<CITY>`, `couriers_<CITY>`, `orders`, `metrics_daily`

### products_<CITY>
- `sku`, `name`, `category`, `price`, `stock`, `active`

### couriers_<CITY>
- `courier_id`, `tg_id`, `name`, `is_active`, `interval_start`, `interval_end`, `updated_at`

### orders
- `order_id`, `user_tg_id`, `username`, `city`, `status`, `items_json`, `total`, `reserved_until`, `courier_id`, `slot_time`, `created_at`, `delivered_at`, `sheets_committed`

### metrics_daily
- `date`, `city`, `orders`, `revenue`, `avg_check`, `upsell_clicks`, `upsell_accepts`, `repeat_purchases`, `liquids_sales`, `electronics_sales`, `growth_percent`, `platform_commission`, `courier_commission`

## Режим B: CITY_COLUMN
- Вкладки: `products`, `couriers`, `orders`, `metrics_daily`
- Доп. колонка `city` в `products`, `couriers`, `metrics_daily`

## Примеры
products:
`SKU001, Жидкость Классик 60 мл, liquids, 18, 50, TRUE`

couriers:
`courier_ffm_1, 8551771212, Вася, TRUE, 14:00, 16:00, 2025-12-15T11:00:00Z`

orders:
`1001, 123456, user123, FFM, delivered, [{"sku":"SKU001","qty":1,"price":18}], 18.00, , courier_ffm_1, 14:30, 2025-12-15T10:00:00Z, 2025-12-15T14:35:00Z, TRUE`

metrics_daily:
`2025-12-15, FFM, 10, 180.00, 18.00, 5, 3, 2, 10, 0, 5.0, 9.00, 36.00`
