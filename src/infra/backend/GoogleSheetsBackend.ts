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
  private productsLoaded = false;
  private couriersLoaded = false;

  async getProducts(city: string): Promise<Product[]> {
    const cached = this.cacheProducts.get(city);
    const now = Date.now();
    if (cached && now - cached.ts < env.SHEETS_CACHE_TTL_SECONDS * 1000) return cached.data;
    const s = sheetName("products", city);
    const candidates = [s, s.replace(/^[a-z]/, (c) => c.toUpperCase()), city, city.toUpperCase()];
    let values: any[] = [];
    for (const tab of candidates) {
      const vr = await batchGet([`${tab}!A:Z`]);
      values = vr[0]?.values || [];
      if (values.length) break;
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
        qty_available: stockIdx >= 0 ? Number(r[stockIdx] || 0) : 999,
        upsell_group_id: null,
        reminder_offset_days: 7,
        active: activeIdx >= 0 ? parseBool(r[activeIdx]) : true
      }));
    this.cacheProducts.set(city, { ts: now, data: out });
    return out;
  }

  async getActiveCouriers(city: string): Promise<Courier[]> {
    const cached = this.cacheCouriers.get(city);
    const now = Date.now();
    if (cached && now - cached.ts < env.SHEETS_CACHE_TTL_SECONDS * 1000) return cached.data;
    const s = sheetName("couriers", city);
    const candidates = [s, s.replace(/^[a-z]/, (c) => c.toUpperCase()), city, city.toUpperCase()];
    let values: any[] = [];
    for (const tab of candidates) {
      const vr = (await batchGet([`${tab}!A:Z`]))[0];
      values = vr?.values || [];
      if (values.length) break;
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

  async preloadData(): Promise<void> {
    const city = getDefaultCity();
    try {
      await Promise.all([this.getProducts(city), this.getActiveCouriers(city)]);
      this.productsLoaded = true;
      this.couriersLoaded = true;
    } catch (err) {
      // ignore, will lazy-load later
    }
  }

  async invalidateCache(type: "products" | "couriers" | "all") {
    if (type === "products" || type === "all") {
      this.cacheProducts.clear();
    }
    if (type === "couriers" || type === "all") {
      this.cacheCouriers.clear();
    }
  }

  async init(): Promise<void> {
    await this.preloadData();
    await this.syncAllProducts();
  }

  async syncAllProducts(): Promise<void> {
    const cities = (env.CITY_CODES || "FFM").split(",").map((s) => s.trim()).filter((s) => s.length);
    for (const city of cities) {
      try {
        await this.syncCityProducts(city);
      } catch (e) {
        // ignore individual city failures
      }
    }
  }

  async syncCityProducts(city: string): Promise<void> {
    const s = sheetName("products", city);
    let vr = await batchGet([`${s}!A:Z`]);
    let values = vr[0]?.values || [];
    if (!values.length) {
      const up = s.replace(/^[a-z]/, (c) => c.toUpperCase());
      vr = await batchGet([`${up}!A:Z`]);
      values = vr[0]?.values || [];
    }
    if (!values.length) return;
    const headers = values[0] || [];
    const rows = values.slice(1);
    const stockIdx = idx(headers as string[], ["stock", "qty_available"]);
    const activeIdx = idx(headers as string[], ["active", "is_active"]);
    if (stockIdx < 0 || activeIdx < 0) return;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const stock = Number(r[stockIdx] || 0);
      const isActive = String(r[activeIdx] || "").toLowerCase();
      const targetActive = stock > 0 ? "true" : "false";
      if ((stock === 0 && isActive !== "false") || (stock > 0 && isActive !== "true")) {
        const letter = String.fromCharCode(65 + activeIdx);
        await update(`${s}!${letter}${i + 2}`, [[targetActive]]);
      }
    }
  }

  async getLastOrderId(city?: string): Promise<number> {
    const c = (city || getDefaultCity()).trim();
    const s = sheetName("orders", c);
    const vr = await batchGet([`${s}!A:Z`]);
    const values = vr[0]?.values || [];
    if (values.length <= 1) return 0;
    const headers = values[0] || [];
    const rows = values.slice(1);
    const orderIdx = headers.indexOf("order_id");
    if (orderIdx < 0) return 0;
    let maxId = 0;
    for (const r of rows) {
      const oid = Number(r[orderIdx] || 0);
      if (oid > maxId) maxId = oid;
    }
    return maxId;
  }

  async updateStockAfterOrder(items: Array<{ product_id: number; qty: number }>, city?: string): Promise<void> {
    const c = (city || getDefaultCity()).trim();
    const s = sheetName("products", c);
    const vr = await batchGet([`${s}!A:Z`]);
    const values = vr[0]?.values || [];
    if (!values.length) return;
    const headers = values[0] || [];
    const rows = values.slice(1);
    const stockIdx = idx(headers as string[], ["stock", "qty_available"]);
    const activeIdx = idx(headers as string[], ["active", "is_active"]);
    const skuIdx = idx(headers as string[], ["sku"]);
    function pidForRow(r: any[], i: number) {
      if (skuIdx >= 0 && r[skuIdx]) return stringHash(String(r[skuIdx]));
      return i + 1;
    }
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const pid = pidForRow(r, i);
      const match = items.find((it) => Number(it.product_id) === Number(pid));
      if (!match) continue;
      const cur = Number(r[stockIdx] || 0);
      const next = Math.max(0, cur - Number(match.qty || 0));
      const stockLetter = String.fromCharCode(65 + stockIdx);
      await update(`${s}!${stockLetter}${i + 2}`, [[String(next)]]);
      if (activeIdx >= 0 && next === 0) {
        const activeLetter = String.fromCharCode(65 + activeIdx);
        await update(`${s}!${activeLetter}${i + 2}`, [["false"]]);
      }
    }
  }

  async createOrder(order: {
    order_id: number;
    user_tg_id: number;
    status: string;
    total_amount: number;
    courier_id?: number | null;
    delivery_date?: string | null;
    delivery_time?: string | null;
    payment_method?: string | null;
    items: Array<{ product_id: number; qty: number; price: number }>;
    city?: string;
  }): Promise<void> {
    const c = (order.city || getDefaultCity()).trim();
    const s = sheetName("orders", c);
    await append(`${s}!A:L`, [[
      String(order.order_id),
      String(order.user_tg_id),
      String(order.status || "pending"),
      Number(order.total_amount || 0).toFixed(2),
      String(order.courier_id || ""),
      String(order.delivery_date || ""),
      String(order.delivery_time || ""),
      String(order.payment_method || ""),
      new Date().toISOString(),
      "",
      JSON.stringify(order.items || []),
      c
    ]]);
    await this.updateStockAfterOrder(order.items, c);
  }
  async appendOrder(order: any): Promise<void> {
    const s = sheetName("orders", order.city || getDefaultCity());
    const row = [
      String(order.order_id),                      // A: order_id
      String(order.user_tg_id),                    // B: user_id
      String(order.status || "pending"),           // C: status
      Number(order.total || 0).toFixed(2),         // D: total_amount
      String(order.courier_id || ""),              // E: courier_id
      String(order.delivery_date || ""),           // F: delivery_date
      String(order.slot_time || ""),               // G: delivery_time
      String(order.payment_method || ""),          // H: payment_method
      String(order.created_at || new Date().toISOString()), // I: created_at
      String(order.delivered_at || ""),            // J: delivered_at
      String(order.items_json || "[]"),            // K: items (JSON)
      String(order.city || getDefaultCity())       // L: city
    ];
    await append(`${s}!A:L`, [row]);
  }

  async updateOrderDetails(orderId: number, details: { courier_id?: number; slot_time?: string; payment_method?: string; delivery_date?: string; items?: string }): Promise<void> {
    const s = sheetName("orders", getDefaultCity());
    const vr = await batchGet([`${s}!A:Z`]);
    const values = vr[0]?.values || [];
    const headers = values[0] || [];
    const rows = values.slice(1);
    const idx = (name: string) => headers.indexOf(name);
    const orderIdx = idx("order_id");
    if (orderIdx < 0) return;
    let targetRow = -1;
    for (let i = 0; i < rows.length; i++) {
      if (String(rows[i][orderIdx]) === String(orderId)) { targetRow = i + 1; break; }
    }
    if (targetRow < 0) return;
    const setIfExists = async (name: string, val?: string | number) => {
      const ci = idx(name);
      if (ci >= 0 && val != null) {
        const letter = String.fromCharCode(65 + ci);
        await update(`${s}!${letter}${targetRow + 1}`, [[String(val)]]);
      }
    };
    await setIfExists("courier_id", details.courier_id);
    await setIfExists("delivery_date", details.delivery_date);
    await setIfExists("slot_time", details.slot_time);
    await setIfExists("delivery_time", details.slot_time);
    await setIfExists("payment_method", details.payment_method);
    await setIfExists("items", details.items);
    await setIfExists("items_json", details.items);
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
      await update(`${s}!C${found.rowIndex + 1}`, [["delivered"]]); // C: status
      await update(`${s}!J${found.rowIndex + 1}`, [[nowIso]]);      // J: delivered_at
    } else {
      await append(`${s}!A:L`, [[
        String(row.order_id),    // A
        "",                      // B user_id
        "delivered",             // C status
        Number(row.total_with_discount).toFixed(2), // D total_amount
        "",                      // E courier_id
        "",                      // F delivery_date
        "",                      // G delivery_time
        "",                      // H payment_method
        String(new Date().toISOString()), // I created_at
        String(nowIso),          // J delivered_at
        String(row.items_json || "[]"), // K items
        city                     // L city
      ]]);
    }
    db.prepare("UPDATE orders SET sheets_committed=1 WHERE order_id = ?").run(orderId);
  }

  async upsertDailyMetrics(date: string, city: string, metrics: MetricsRow): Promise<void> {
    const s = sheetName("metrics", city);
    const found = await findRowByKey(s, "date", date);
    const row = [
      metrics.date,                                      // A: date
      String(metrics.orders),                            // B: orders
      metrics.revenue.toFixed(2),                        // C: revenue
      metrics.avg_check.toFixed(2),                      // D: avg_check
      String(metrics.upsell_clicks),                     // E: upsell_clicks
      String(metrics.upsell_accepts),                    // F: upsell_accepts
      String(metrics.repeat_purchases),                  // G: repeat_purchase
      String(metrics.liquids_sales),                     // H: liquids_sales
      String(metrics.electronics_sales),                 // I: electronics_sales
      String(metrics.growth_percent),                    // J: growth_percent
      (metrics.platform_commission || (metrics.revenue*0.05)).toFixed(2), // K
      (metrics.courier_commission || (metrics.revenue*0.20)).toFixed(2)   // L
    ];
    if (found) {
      await update(`${s}!A${found.rowIndex + 1}:L${found.rowIndex + 1}`, [row]);
    } else {
      await append(`${s}!A:L`, [row]);
    }
  }
}
