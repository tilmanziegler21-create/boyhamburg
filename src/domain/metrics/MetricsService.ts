import { getDb } from "../../infra/db/sqlite";
import { MetricsRow, OrderItem, Product } from "../../core/types";
import { formatDate } from "../../core/time";
import { writeDailyMetrics } from "./MetricsWriteSheets";
import { useSheets } from "../../infra/config";
import { getProducts } from "../../infra/data";

export async function computeDailyMetrics(date: string): Promise<MetricsRow> {
  const db = getDb();
  const start = Date.parse(`${date}T00:00:00.000Z`);
  const end = start + 86400000;
  const delivered = db.prepare("SELECT total_with_discount, items_json, source FROM orders WHERE status='delivered' AND ((delivered_at_ms >= ? AND delivered_at_ms < ?) OR (delivered_at_ms IS NULL AND substr(delivered_timestamp,1,10)=?))").all(start, end, date) as any[];
  const orders = delivered.length;
  const revenue = delivered.reduce((s, r) => s + Number(r.total_with_discount), 0);
  const avg_check = orders > 0 ? Math.round((revenue / orders) * 100) / 100 : 0;
  let liquids_sales = 0;
  let electronics_sales = 0;
  let upsell_accepts = 0;
  let repeat_purchases = 0;
  const products: Product[] = await getProducts();
  for (const r of delivered) {
    const items: OrderItem[] = JSON.parse(r.items_json);
    const hasUpsell = items.some((i) => i.is_upsell);
    if (hasUpsell) upsell_accepts += 1;
    if (r.source === "reminder") repeat_purchases += 1;
    for (const i of items) {
      const p = products.find((x) => x.product_id === i.product_id);
      if (!p) continue;
      if (p.category === "liquids") liquids_sales += i.qty;
      else if (p.category === "electronics") electronics_sales += i.qty;
    }
  }
  const prev = previousDate(date);
  const prevStart = Date.parse(`${prev}T00:00:00.000Z`);
  const prevEnd = prevStart + 86400000;
  const yRow = db.prepare("SELECT SUM(total_with_discount) AS rev FROM orders WHERE status='delivered' AND ((delivered_at_ms >= ? AND delivered_at_ms < ?) OR (delivered_at_ms IS NULL AND substr(delivered_timestamp,1,10)=?))").get(prevStart, prevEnd, prev) as any;
  const revenue_yesterday = Number(yRow?.rev || 0);
  const growth_percent = Math.round(((revenue - revenue_yesterday) / Math.max(revenue_yesterday, 1)) * 10000) / 100;
  const upsell_clicks = db.prepare("SELECT COUNT(1) AS c FROM events WHERE substr(date,1,10)=? AND type='upsell_click'").get(date) as any;
  const platform_commission = Math.round(revenue * 0.05 * 100) / 100;
  const courier_commission = Math.round(revenue * 0.20 * 100) / 100;
  return {
    date,
    orders,
    revenue: Math.round(revenue * 100) / 100,
    avg_check,
    upsell_clicks: Number(upsell_clicks?.c || 0),
    upsell_accepts,
    repeat_purchases,
    liquids_sales,
    electronics_sales,
    growth_percent,
    platform_commission,
    courier_commission
  };
}

function previousDate(date: string): string {
  const [y, m, d] = date.split("-").map((x) => Number(x));
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() - 1);
  return formatDate(dt);
}

export async function writeDailyMetricsRow(row: MetricsRow): Promise<void> {
  if (useSheets) {
    await writeDailyMetrics(row);
  } else {
    // mock mode: no external write, just noop
  }
}
