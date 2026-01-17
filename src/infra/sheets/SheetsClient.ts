import { google } from "googleapis";
import { env } from "../config";
import fs from "fs";
import { getDefaultCity } from "../backend";
import { logger } from "../logger";
import { Courier, Order, Product, User } from "../../core/types";

type Range = {
  sheet: string;
  startRow: number;
};

function parseServiceAccount(raw: string) {
  let cleaned = raw.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  }
  try {
    const j = JSON.parse(cleaned);
    const email = String(j.client_email || "");
    const key = String(j.private_key || "").replace(/\\n/g, "\n");
    if (email && key) return { email, key };
  } catch {}
  const braceStart = cleaned.indexOf("{");
  const braceEnd = cleaned.lastIndexOf("}");
  if (braceStart >= 0 && braceEnd > braceStart) {
    try {
      const j = JSON.parse(cleaned.slice(braceStart, braceEnd + 1));
      const email = String(j.client_email || "");
      const key = String(j.private_key || "").replace(/\\n/g, "\n");
      if (email && key) return { email, key };
    } catch {}
  }
  const emailMatch = cleaned.match(/client_email["']?\s*[:=]\s*["']([^"']+)["']/i);
  const pemMatch = cleaned.match(/-----BEGIN[^-]*KEY-----[\s\S]*?-----END[^-]*KEY-----/);
  const email = emailMatch ? emailMatch[1] : "";
  const key = pemMatch ? pemMatch[0].replace(/\\n/g, "\n") : "";
  if (email && key) return { email, key };
  throw new Error("Invalid JSON: cannot extract client_email/private_key");
}

function authClient() {
  const keyFile = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH;
  if (keyFile) {
    if (!fs.existsSync(keyFile)) {
      const err = `Secret file not found at ${keyFile}`;
      logger.error("Sheets auth error", { error: err });
      throw new Error(err);
    }
    logger.info("Using GoogleAuth with keyFile", { keyFile });
    return new google.auth.GoogleAuth({ keyFile, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  }
  const email = env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const key = env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY;
  if (email && key) {
    const cleanKey = String(key)
      .replace(/\r\n/g, "\n")
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\r/g, "\n")
      .trim()
      .replace(/^"+|"+$/g, "");
    logger.info("Using JWT auth from env email/private key");
    return new google.auth.JWT({ email, key: cleanKey, scopes: ["https://www.googleapis.com/auth/spreadsheets"] });
  }
  const err = "Missing Google service account credentials (JSON path or email/private key)";
  logger.error("Sheets auth error", { error: err });
  throw new Error(err);
}

function sheetsApi() {
  const auth = authClient();
  return google.sheets({ version: "v4", auth });
}

export function testSheetsAuth(): boolean {
  try {
    authClient();
    return true;
  } catch {
    return false;
  }
}

function headerIndex(headers: string[], name: string) {
  return headers.indexOf(name);
}

function headerIndexAny(headers: string[], names: string[]) {
  for (const n of names) {
    const i = headers.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

async function readSheet(sheet: string): Promise<{ headers: string[]; rows: string[][] }> {
  const api = sheetsApi();
  const candidates: string[] = [];
  const city = getDefaultCity();
  const cap = sheet.replace(/^[a-z]/, (c) => c.toUpperCase());
  if (env.GOOGLE_SHEETS_MODE === "TABS_PER_CITY") {
    candidates.push(`${sheet}_${city}`, `${cap}_${city}`);
  }
  candidates.push(sheet, cap);
  let lastErr: any = null;
  for (const s of candidates) {
    try {
      const range = `${s}!A:Z`;
      const resp = await api.spreadsheets.values.get({ spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID, range });
      const values = resp.data.values || [];
      const headers = (values[0] || []).map((x) => String(x));
      const rows = values.slice(1).map((r) => r.map((x) => String(x)));
      return { headers, rows };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error(`Unable to read sheet ${sheet}`);
}

function sheetCandidates(base: string): string[] {
  const city = getDefaultCity();
  const cap = base.replace(/^[a-z]/, (c) => c.toUpperCase());
  const list: string[] = [];
  if (env.GOOGLE_SHEETS_MODE === "TABS_PER_CITY") list.push(`${base}_${city}`, `${cap}_${city}`);
  list.push(base, cap);
  return list;
}

async function resolveWriteSheet(base: string): Promise<string> {
  const api = sheetsApi();
  const candidates = sheetCandidates(base);
  for (const s of candidates) {
    try {
      await api.spreadsheets.values.get({ spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID, range: `${s}!A1:A1` });
      return s;
    } catch {}
  }
  return base;
}

async function writeCell(sheet: string, rowNumber: number, colNumber: number, value: string) {
  const api = sheetsApi();
  const range = `${sheet}!${columnLetter(colNumber + 1)}${rowNumber + 1}`;
  await api.spreadsheets.values.update({
    spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [[value]] }
  });
}

function columnLetter(n: number) {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export async function getProducts(): Promise<Product[]> {
  const { headers, rows } = await readSheet("products");
  const idIdx = headerIndexAny(headers, ["product_id", "sku", "id"]);
  const titleIdx = headerIndexAny(headers, ["title", "name"]);
  const priceIdx = headerIndexAny(headers, ["price"]);
  const categoryIdx = headerIndexAny(headers, ["category", "категория", "type"]);
  const brandIdx = headerIndexAny(headers, ["brand", "бренд", "vendor", "producer", "марка"]);
  const qtyIdx = headerIndexAny(headers, ["qty_available", "stock", "qty"]);
  const upsellIdx = headerIndexAny(headers, ["upsell_group_id", "upsell"]);
  const remIdx = headerIndexAny(headers, ["reminder_offset_days", "reminder_days"]);
  const activeIdx = headerIndexAny(headers, ["active", "is_active", "активен", "enabled"]);
  const normCat = (s: string): Product["category"] => {
    const x = String(s || "").trim().toLowerCase();
    if (["liquid", "liquids", "жидкость", "жидкости", "juice"].includes(x)) return "liquids";
    if (["electronic", "electronics", "электроника", "device", "devices", "электронка"].includes(x)) return "electronics";
    return (x === "liquids" || x === "electronics") ? (x as Product["category"]) : "liquids";
  };
  const parseId = (v: any, i: number) => {
    const s = String(v ?? "").trim();
    const n = Number(s);
    if (Number.isFinite(n)) return n;
    // stable hash for string IDs like EL-001, LIQ-001
    let h = 5381;
    for (let k = 0; k < s.length; k++) h = ((h << 5) + h) + s.charCodeAt(k);
    const pos = Math.abs(h >>> 0);
    return pos || (i + 1);
  };
  const parseNum = (v: any, def: number = 0) => {
    const s = String(v ?? "").trim().replace(/,/g, ".");
    const n = Number(s);
    return Number.isFinite(n) ? n : def;
  };
  return rows
    .filter((r) => r.length > 0)
    .map((r, i) => ({
      product_id: idIdx >= 0 ? parseId(r[idIdx], i) : i + 1,
      title: r[titleIdx],
      price: parseNum(r[priceIdx]),
      category: categoryIdx >= 0 ? normCat(r[categoryIdx]) : "liquids",
      brand: brandIdx >= 0 ? (r[brandIdx] || null) : null,
      qty_available: qtyIdx >= 0 ? parseNum(r[qtyIdx] || 0) : 0,
      upsell_group_id: r[upsellIdx] ? Number(r[upsellIdx]) : null,
      reminder_offset_days: Number(r[remIdx] || 0),
      active: activeIdx >= 0 ? ["true", "1", "да", "yes"].includes(String(r[activeIdx]).trim().toLowerCase()) : true
    }));
}

export async function updateProductQty(product_id: number, new_qty: number): Promise<void> {
  const writeSheet = await resolveWriteSheet("products");
  const { headers, rows } = await readSheet("products");
  const idIdx = headerIndexAny(headers, ["product_id", "sku", "id"]);
  const qtyIdx = headerIndexAny(headers, ["qty_available", "stock", "qty"]);
  let rowNumber = -1;
  for (let i = 0; i < rows.length; i++) {
    const raw = idIdx >= 0 ? rows[i][idIdx] : String(i + 1);
    const n = Number(raw);
    const id = Number.isFinite(n) ? n : (String(raw).match(/\d+/)?.[0] ? Number(String(raw).match(/\d+/)![0]) : -1);
    if (id === product_id) { rowNumber = i + 1; break; }
  }
  if (rowNumber < 0) throw new Error("Product not found");
  if (qtyIdx < 0) throw new Error("Quantity column not found");
  await writeCell(writeSheet, rowNumber, qtyIdx, String(new_qty));
}

export async function updateProductPrice(product_id: number, new_price: number): Promise<void> {
  const writeSheet = await resolveWriteSheet("products");
  const { headers, rows } = await readSheet("products");
  const idIdx = headerIndexAny(headers, ["product_id", "sku", "id"]);
  const priceIdx = headerIndexAny(headers, ["price", "цена"]);
  let rowNumber = -1;
  for (let i = 0; i < rows.length; i++) {
    const raw = idIdx >= 0 ? rows[i][idIdx] : String(i + 1);
    const n = Number(raw);
    const id = Number.isFinite(n) ? n : (String(raw).match(/\d+/)?.[0] ? Number(String(raw).match(/\d+/)![0]) : -1);
    if (id === product_id) { rowNumber = i + 1; break; }
  }
  if (rowNumber < 0) throw new Error("Product not found");
  if (priceIdx < 0) throw new Error("Price column not found");
  await writeCell(writeSheet, rowNumber, priceIdx, String(new_price));
}

export async function getCouriers(): Promise<Courier[]> {
  const { headers, rows } = await readSheet("couriers");
  const idIdx = headerIndexAny(headers, ["courier_id", "id"]);
  const nameIdx = headerIndexAny(headers, ["name", "имя"]);
  const tgIdx = headerIndexAny(headers, ["tg_id", "telegram_id", "chat_id"]);
  const activeIdx = headerIndexAny(headers, ["active", "is_active", "активен"]);
  const intervalIdx = headerIndexAny(headers, ["last_delivery_interval", "interval", "delivery_interval", "интервал", "интервал_доставки", "последний_интервал"]);
  const timeFromIdx = headerIndexAny(headers, ["time_from", "from", "start", "время_с", "время от", "начало", "с"]);
  const timeToIdx = headerIndexAny(headers, ["time_to", "to", "end", "время_до", "время до", "конец", "до"]);
  return rows.map((r, i) => ({
    courier_id: idIdx >= 0 ? Number(r[idIdx]) : i + 1,
    name: nameIdx >= 0 ? r[nameIdx] : `Courier ${i + 1}`,
    tg_id: tgIdx >= 0 ? Number(r[tgIdx]) : 0,
    active: activeIdx >= 0 ? ["true", "1", "да", "yes"].includes(String(r[activeIdx]).trim().toLowerCase()) : true,
    last_delivery_interval: (
      intervalIdx >= 0 && r[intervalIdx]
        ? r[intervalIdx]
        : (timeFromIdx >= 0 && timeToIdx >= 0 && r[timeFromIdx] && r[timeToIdx]
            ? `${String(r[timeFromIdx]).trim()}-${String(r[timeToIdx]).trim()}`
            : "14-16")
    ) as Courier["last_delivery_interval"]
  }));
}

export async function updateCourier(courier_id: number, fields: Partial<Courier>): Promise<void> {
  const { headers, rows } = await readSheet("couriers");
  const idIdx = headerIndex(headers, "courier_id");
  let rowNumber = -1;
  for (let i = 0; i < rows.length; i++) {
    if (Number(rows[i][idIdx]) === courier_id) {
      rowNumber = i + 1;
      break;
    }
  }
  if (rowNumber < 0) throw new Error("Courier not found");
  const updates: [number, string][] = [];
  for (const [k, v] of Object.entries(fields)) {
    const col = headerIndex(headers, k);
    if (col >= 0 && typeof v !== "undefined") updates.push([col, String(v)]);
  }
  for (const [col, val] of updates) await writeCell("Couriers", rowNumber, col, val);
}

export async function getUsers(): Promise<User[]> {
  const { headers, rows } = await readSheet("users");
  const idIdx = headerIndex(headers, "user_id");
  const usernameIdx = headerIndex(headers, "username");
  const firstIdx = headerIndex(headers, "first_seen");
  const lastIdx = headerIndex(headers, "last_purchase_date");
  const nextIdx = headerIndex(headers, "next_reminder_date");
  const segIdx = headerIndex(headers, "segment");
  return rows.map((r) => ({
    user_id: Number(r[idIdx]),
    username: r[usernameIdx],
    first_seen: r[firstIdx],
    last_purchase_date: r[lastIdx] || null,
    next_reminder_date: r[nextIdx] || null,
    segment: r[segIdx] || null
  }));
}

export async function addUser(user: User): Promise<void> {
  const api = sheetsApi();
  await api.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
    range: "Users",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        String(user.user_id),
        user.username,
        user.first_seen,
        user.last_purchase_date || "",
        user.next_reminder_date || "",
        user.segment || ""
      ]]
    }
  });
}

export async function updateUser(user_id: number, fields: Partial<User>): Promise<void> {
  const { headers, rows } = await readSheet("users");
  const idIdx = headerIndex(headers, "user_id");
  let rowNumber = -1;
  for (let i = 0; i < rows.length; i++) {
    if (Number(rows[i][idIdx]) === user_id) {
      rowNumber = i + 1;
      break;
    }
  }
  if (rowNumber < 0) throw new Error("User not found");
  for (const [k, v] of Object.entries(fields)) {
    const col = headerIndex(headers, k);
    if (col >= 0 && typeof v !== "undefined") await writeCell("Users", rowNumber, col, String(v ?? ""));
  }
}

export async function addOrder(order: Order): Promise<void> {
  const api = sheetsApi();
  await api.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
    range: "Orders",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        String(order.order_id),
        String(order.user_id),
        JSON.stringify(order.items),
        String(order.total_without_discount),
        String(order.total_with_discount),
        String(order.discount_total),
        order.status,
        order.reserve_timestamp,
        order.expiry_timestamp,
        order.courier_id != null ? String(order.courier_id) : "",
        order.delivery_interval || "",
        order.delivery_exact_time || ""
      ]]
    }
  });
}

export async function updateOrder(order_id: number, fields: Partial<Order>): Promise<void> {
  const { headers, rows } = await readSheet("Orders");
  const idIdx = headerIndex(headers, "order_id");
  let rowNumber = -1;
  for (let i = 0; i < rows.length; i++) {
    if (Number(rows[i][idIdx]) === order_id) {
      rowNumber = i + 1;
      break;
    }
  }
  if (rowNumber < 0) throw new Error("Order not found");
  for (const [k, v] of Object.entries(fields)) {
    const col = headerIndex(headers, k);
    if (col >= 0 && typeof v !== "undefined") await writeCell("Orders", rowNumber, col, typeof v === "string" ? v : JSON.stringify(v));
  }
}

export async function getOrderById(order_id: number): Promise<Order | null> {
  const { headers, rows } = await readSheet("Orders");
  const idIdx = headerIndex(headers, "order_id");
  for (let i = 0; i < rows.length; i++) {
    if (Number(rows[i][idIdx]) === order_id) {
      const h = headers;
      const r = rows[i];
      const idx = (name: string) => headerIndex(h, name);
      return {
        order_id: Number(r[idx("order_id")]),
        user_id: Number(r[idx("user_id")]),
        items: JSON.parse(r[idx("items_json")]),
        total_without_discount: Number(r[idx("total_without_discount")]),
        total_with_discount: Number(r[idx("total_with_discount")]),
        discount_total: Number(r[idx("discount_total")]),
        status: r[idx("status")] as Order["status"],
        reserve_timestamp: r[idx("reserve_timestamp")],
        expiry_timestamp: r[idx("expiry_timestamp")],
        courier_id: r[idx("courier_id")] ? Number(r[idx("courier_id")]) : null,
        delivery_interval: r[idx("delivery_interval")] || null,
        delivery_exact_time: r[idx("delivery_exact_time")] || null
      };
    }
  }
  return null;
}

export async function refreshProductsCache(): Promise<Product[]> {
  const products = await getProducts();
  logger.info("Products loaded", { count: products.length });
  return products;
}

type QueueItem = { op: () => Promise<void> };
const writeQueue: QueueItem[] = [];
let writing = false;

async function processQueue() {
  if (writing) return;
  writing = true;
  while (writeQueue.length) {
    const item = writeQueue.shift()!;
    let attempt = 0;
    while (attempt < env.SHEETS_WRITE_RETRY) {
      try {
        await item.op();
        break;
      } catch (e) {
        attempt++;
        logger.warn("Sheets write failed", { error: String(e), attempt });
        await new Promise((r) => setTimeout(r, env.SHEETS_WRITE_RETRY_BACKOFF_MS));
      }
    }
  }
  writing = false;
}

export async function append(range: string, values: any[][]) {
  writeQueue.push({ op: async () => {
    const api = sheetsApi();
    await api.spreadsheets.values.append({
      spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
      range,
      valueInputOption: "RAW",
      requestBody: { values }
    });
  }});
  processQueue();
}

export async function update(range: string, values: any[][]) {
  writeQueue.push({ op: async () => {
    const api = sheetsApi();
    await api.spreadsheets.values.update({
      spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
      range,
      valueInputOption: "RAW",
      requestBody: { values }
    });
  }});
  processQueue();
}

export async function clear(range: string) {
  const api = sheetsApi();
  await api.spreadsheets.values.clear({
    spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
    range
  });
}

export async function batchGet(ranges: string[]) {
  const api = sheetsApi();
  const resp = await api.spreadsheets.values.batchGet({
    spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
    ranges
  });
  return resp.data.valueRanges || [];
}

export async function findRowByKey(sheet: string, keyColumn: string, keyValue: string) {
  const { headers, rows } = await readSheet(sheet);
  const keyIdx = headerIndex(headers, keyColumn);
  for (let i = 0; i < rows.length; i++) {
    if (String(rows[i][keyIdx]) === keyValue) return { rowIndex: i + 1, headers };
  }
  return null;
}
