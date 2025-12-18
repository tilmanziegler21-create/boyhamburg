import { DataBackend } from "./DataBackend";
import { MetricsRow, Product, Courier } from "../../core/types";
import { env } from "../config";
import { batchGet, append, update, findRowByKey, getProducts as sheetsGetProducts, updateProductQty } from "../sheets/SheetsClient";
import { getDb } from "../db/sqlite";
import { getDefaultCity } from "./index";

function sheetName(base: string, city: string) {
  if (env.GOOGLE_SHEETS_MODE === "TABS_PER_CITY") return `${base}_${city}`;
  return base;
}

function idx(headers: string[], names: string[]) {
  for (const n of names) {
    const i = headers.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

function parseBool(v: any) {
  const s = String(v || "").toLowerCase();
  return s === "true" || s === "1" || s === "yes" || s === "y";
}

function stringHash(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export class GoogleSheetsBackend implements DataBackend {
  private cacheProducts: Map<string, { ts: number; data: Product[] }> = new Map();
  private cacheCouriers: Map<string, { ts: number; data: Courier[] }> = new Map();

  async getProducts(city: string): Promise<Product[]> {
    const cached = this.cacheProducts.get(city);
    const now = Date.now();
    if (cached && now - cached.ts < env.SHEETS_CACHE_TTL_SECONDS * 1000) return cached.data;
    const s = sheetName("products", city);
    let vr = await batchGet([`${s}!A:Z`]);
    let values = vr[0]?.values || [];
    if (!values.length) {
      const up = s.replace(/^[a-z]/, (c) => c.toUpperCase());
      vr = await batchGet([`${up}!A:Z`]);
      values = vr[0]?.values || [];
    }
    const headers = values[0] || [];
    const rows = values.slice(1);
    const nameIdx = idx(headers as string[], ["name", "title"]);
    const priceIdx = idx(headers as string[], ["price"]);
    const catIdx = idx(headers as string[], ["category"]);
    const brandIdx = idx(headers as string[], ["brand"]);
    const stockIdx = idx(headers as string[], ["stock", "qty_available"]);
    const activeIdx = idx(headers as string[], ["active", "is_active"]);
    const skuIdx = idx(headers as string[], ["sku"]);
    const out: Product[] = rows
      .filter((r) => nameIdx >= 0 && r[nameIdx] != null && String(r[nameIdx]).trim() !== "")
      .map((r, i) => ({
        product_id: skuIdx >= 0 ? stringHash(String(r[skuIdx])) : i + 1,
        title: String(r[nameIdx] || ""),
        price: Number(r[priceIdx] || 0),
        category: String(r[catIdx] || "liquids") as any,
        brand: brandIdx >= 0 ? (r[brandIdx] || null) : null,
        qty_available: Number(r[stockIdx] || 0),
        upsell_group_id: null,
        reminder_offset_days: 7,
        active: (activeIdx >= 0 ? parseBool(r[activeIdx]) : true) && (Number(r[stockIdx] || 0) > 0)
      }));
    this.cacheProducts.set(city, { ts: now, data: out });
    return out;
  }

  async getActiveCouriers(city: string): Promise<Courier[]> {
    const cached = this.cacheCouriers.get(city);
    const now = Date.now();
    if (cached && now - cached.ts < env.SHEETS_CACHE_TTL_SECONDS * 1000) return cached.data;
    const s = sheetName("couriers", city);
    let values = (await batchGet([`${s}!A:Z`]))[0]?.values || [];
    if (!values.length) {
      const up = s.replace(/^[a-z]/, (c) => c.toUpperCase());
      values = (await batchGet([`${up}!A:Z`]))[0]?.values || [];
    }
    const headers = values[0] || [];
    const rows = values.slice(1);
    const nameIdx = idx(headers as string[], ["name"]);
    const tgIdx = idx(headers as string[], ["tg_id"]);
    const activeIdx = idx(headers as string[], ["is_active", "active"]);
    const startIdx = idx(headers as string[], ["slot_from", "interval_start", "from_time", "time_from"]);
    const endIdx = idx(headers as string[], ["slot_to", "interval_end", "to_time", "time_to"]);
    const idIdx = idx(headers as string[], ["courier_id"]);
    const out: Courier[] = rows
      .filter((r) => tgIdx >= 0 && r[tgIdx])
      .map((r, i) => ({
        courier_id: idIdx >= 0 ? Number(r[idIdx] || i + 1) : i + 1,
        name: String(r[nameIdx] || "Курьер"),
        tg_id: Number(r[tgIdx] || 0),
        active: activeIdx >= 0 ? parseBool(r[activeIdx]) : true,
        last_delivery_interval: `${String(r[startIdx] || "12:00")}-${String(r[endIdx] || "18:00")}` as any
      }))
      .filter((c) => c.active);
    this.cacheCouriers.set(city, { ts: now, data: out });
    return out;
  }

  async appendOrder(order: any): Promise<void> {
    const s = sheetName("orders", order.city);
    const row = [
      String(order.order_id),
      String(order.user_tg_id),
      String(order.username || ""),
      String(order.city || getDefaultCity()),
      String(order.status || "pending"),
      String(order.items_json || "[]"),
      Number(order.total || 0).toFixed(2),
      String(order.courier_id || ""),
      String(order.slot_time || ""),
      String(order.created_at || new Date().toISOString()),
      String(order.delivered_at || ""),
      "0"
    ];
    await append(s, [row]);
  }

  async commitDelivery(orderId: number): Promise<void> {
    const db = getDb();
    const row = db.prepare("SELECT order_id, status, items_json, total_with_discount, sheets_committed FROM orders WHERE order_id = ?").get(orderId) as any;
    if (!row) return;
    if (String(row.status) !== "delivered") return;
    if (Number(row.sheets_committed) === 1) return;
    const items = JSON.parse(row.items_json || "[]") as Array<{ product_id: number; qty: number; price: number; is_upsell: boolean }>;    
    // decrement stock in products sheet (TABS_PER_CITY)
    const prodSheet = sheetName("products", getDefaultCity());
    let vrp = await batchGet([`${prodSheet}!A:Z`]);
    let pvals = vrp[0]?.values || [];
    if (!pvals.length) {
      const up = prodSheet.replace(/^[a-z]/, (c) => c.toUpperCase());
      vrp = await batchGet([`${up}!A:Z`]);
      pvals = vrp[0]?.values || [];
    }
    const pHeaders = pvals[0] || [];
    const pRows = pvals.slice(1);
    const skuIdx = idx(pHeaders as string[], ["sku"]);
    const nameIdx = idx(pHeaders as string[], ["name", "title"]);
    const stockIdx = idx(pHeaders as string[], ["stock", "qty_available"]);
    const activeIdxP = idx(pHeaders as string[], ["active", "is_active"]);
    function pidForRow(r: any[], i: number) {
      if (skuIdx >= 0 && r[skuIdx]) return stringHash(String(r[skuIdx]));
      return i + 1;
    }
    for (let i = 0; i < pRows.length; i++) {
      const r = pRows[i];
      const pid = pidForRow(r, i);
      const match = items.find((it) => it.product_id === pid);
      if (!match) continue;
      const cur = Number(r[stockIdx] || 0);
      const next = Math.max(0, cur - Number(match.qty));
      const colLetter = String.fromCharCode(65 + stockIdx);
      await update(`${prodSheet}!${colLetter}${i + 2}`, [[String(next)]]);
      if (activeIdxP >= 0 && next === 0) {
        const activeLetter = String.fromCharCode(65 + activeIdxP);
        await update(`${prodSheet}!${activeLetter}${i + 2}`, [["false"]]);
      }
    }
    const city = getDefaultCity();
    const s = sheetName("orders", city);
    const nowIso = new Date().toISOString();
    const found = await findRowByKey(s, "order_id", String(row.order_id));
    if (found) {
      // E: status
      await update(`${s}!E${found.rowIndex + 1}`, [["delivered"]]);
      // K: delivered_at
      await update(`${s}!K${found.rowIndex + 1}`, [[nowIso]]);
      // L: sheets_committed
      await update(`${s}!L${found.rowIndex + 1}`, [["1"]]);
    } else {
      await append(s, [[
        String(row.order_id),
        "",
        "",
        city,
        "delivered",
        String(row.items_json || "[]"),
        Number(row.total_with_discount).toFixed(2),
        "",
        "",
        String(new Date().toISOString()),
        String(nowIso),
        "1"
      ]]);
    }
    db.prepare("UPDATE orders SET sheets_committed=1 WHERE order_id = ?").run(orderId);
  }

  async upsertDailyMetrics(date: string, city: string, metrics: MetricsRow): Promise<void> {
    const s = sheetName("metrics", city);
    const found = await findRowByKey(s, "date", date);
    const row = [
      metrics.date,
      city,
      String(metrics.orders),
      metrics.revenue.toFixed(2),
      metrics.avg_check.toFixed(2),
      String(metrics.upsell_clicks),
      String(metrics.upsell_accepts),
      String(metrics.repeat_purchases),
      String(metrics.liquids_sales),
      String(metrics.electronics_sales),
      String(metrics.growth_percent),
      (metrics.platform_commission || (metrics.revenue*0.05)).toFixed(2),
      (metrics.courier_commission || (metrics.revenue*0.20)).toFixed(2)
    ];
    if (found) {
      await update(s+"!A"+(found.rowIndex+1), [row]);
    } else {
      await append(s, [row]);
    }
  }
}
