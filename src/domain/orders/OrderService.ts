import { getDb } from "../../infra/db/sqlite";
import { useSheets } from "../../infra/config";
import { batchGet } from "../../infra/sheets/SheetsClient";
import { logger } from "../../infra/logger";
import { getBackend, getDefaultCity } from "../../infra/backend";
import { Order, OrderItem } from "../../core/types";
import { RESERVATION_TTL_MS, UPSellDiscountRate } from "../../core/constants";
import { addMinutes, formatDate } from "../../core/time";
import { updateAfterDelivery } from "../users/UserService";
import { reserveItems, releaseReservation, finalDeduction } from "../inventory/InventoryService";

function computeTotals(items: OrderItem[], purchaseCount: number) {
  const total = items.reduce((s, it) => s + it.price * it.qty, 0);
  const to2 = (n: number) => Math.round(n * 100) / 100;
  return {
    total_without_discount: to2(total),
    discount_total: 0,
    total_with_discount: to2(total)
  };
}

async function getDeliveredCountSourceOfTruth(user_id: number): Promise<number> {
  if (!useSheets) {
    const db = getDb();
    const row = db.prepare("SELECT COUNT(1) AS c FROM orders WHERE user_id = ? AND status='delivered'").get(user_id) as any;
    return Number(row?.c || 0);
  }
  const city = getDefaultCity();
  const sheet = `orders_${city}`;
  try {
    const vr = await batchGet([`${sheet}!A:Z`]);
    const values = vr[0]?.values || [];
    const headers = values[0] || [];
    const rows = values.slice(1);
    const idx = (name: string) => headers.indexOf(name);
    const userIdx = idx("user_tg_id");
    const statusIdx = idx("status");
    if (userIdx < 0 || statusIdx < 0) return 0;
    let count = 0;
    for (const r of rows) if (String(r[userIdx]) === String(user_id) && String(r[statusIdx]).toLowerCase() === "delivered") count++;
    return count;
  } catch {
    return 0;
  }
}

export async function createOrder(user_id: number, items: OrderItem[], source?: "normal" | "reminder"): Promise<Order> {
  const db = getDb();
  const now = new Date();
  const expiry = addMinutes(now, RESERVATION_TTL_MS / 60000);
  const purchaseCount = await getDeliveredCountSourceOfTruth(user_id);
  const totals = computeTotals(items, purchaseCount);
  const segRow = db.prepare("SELECT segment FROM users WHERE user_id = ?").get(user_id) as any;
  const seg = segRow?.segment ? String(segRow.segment) : null;
  const stmt = db.prepare(
    "INSERT INTO orders(user_id, items_json, total_without_discount, total_with_discount, discount_total, status, reserve_timestamp, expiry_timestamp, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  );
  const info = stmt.run(
    user_id,
    JSON.stringify(items),
    totals.total_without_discount,
    totals.total_with_discount,
    totals.discount_total,
    "buffer",
    now.toISOString(),
    expiry.toISOString(),
    source || (seg === "sale10" ? "reminder" : "normal")
  );
  const order_id = Number(info.lastInsertRowid);
  await reserveItems(items, order_id);
  return {
    order_id,
    user_id,
    items,
    total_without_discount: totals.total_without_discount,
    total_with_discount: totals.total_with_discount,
    discount_total: totals.discount_total,
    status: "buffer",
    reserve_timestamp: now.toISOString(),
    expiry_timestamp: expiry.toISOString(),
    courier_id: null,
    delivery_interval: null,
    delivery_exact_time: null,
    source: source || "normal"
  };
}

export async function confirmOrder(order_id: number): Promise<void> {
  const db = getDb();
  db.prepare("UPDATE orders SET status = 'pending' WHERE order_id = ?").run(order_id);
  const row = db
    .prepare(
      "SELECT o.order_id, o.user_id, o.items_json, o.total_with_discount, o.reserve_timestamp, o.expiry_timestamp, o.courier_id, o.delivery_exact_time, u.username FROM orders o LEFT JOIN users u ON o.user_id=u.user_id WHERE o.order_id = ?"
    )
    .get(order_id) as any;
  if (!row) return;
  const backend = getBackend();
  const city = getDefaultCity();
  await backend.appendOrder({
    order_id: Number(row.order_id),
    user_tg_id: Number(row.user_id),
    username: row.username || null,
    city,
    status: "pending",
    items_json: String(row.items_json || "[]"),
    total: Number(row.total_with_discount || 0),
    reserved_until: String(row.expiry_timestamp || ""),
    courier_id: row.courier_id != null ? String(row.courier_id) : null,
    slot_time: row.delivery_exact_time || null,
    created_at: String(row.reserve_timestamp || new Date().toISOString()),
    delivered_at: null,
    sheets_committed: false
  });
}

export async function setDeliverySlot(order_id: number, interval: string, exact_time: string): Promise<void> {
  const db = getDb();
  db.prepare("UPDATE orders SET delivery_interval = ?, delivery_exact_time = ? WHERE order_id = ?").run(interval, exact_time, order_id);
}

export async function clearDeliverySlot(order_id: number): Promise<void> {
  const db = getDb();
  db.prepare("UPDATE orders SET delivery_exact_time = NULL WHERE order_id = ?").run(order_id);
}

export async function setPaymentMethod(order_id: number, method: "card" | "cash"): Promise<void> {
  const db = getDb();
  db.prepare("UPDATE orders SET payment_method = ? WHERE order_id = ?").run(method, order_id);
}

export async function setCourierAssigned(order_id: number, courier_id: number): Promise<void> {
  const db = getDb();
  db.prepare("UPDATE orders SET status = 'courier_assigned', courier_id = ? WHERE order_id = ?").run(courier_id, order_id);
}

export async function setOrderCourier(order_id: number, courier_id: number): Promise<void> {
  const db = getDb();
  db.prepare("UPDATE orders SET courier_id = ? WHERE order_id = ?").run(courier_id, order_id);
}

export async function setDelivered(order_id: number, courier_tg_id: number): Promise<void> {
  const db = getDb();
  const row = db
    .prepare("SELECT user_id, items_json, courier_id FROM orders WHERE order_id = ?")
    .get(order_id) as { user_id: number; items_json: string; courier_id: number | null } | undefined;
  if (!row) {
    logger.warn("Deliver refused: order not found", { order_id });
    return;
  }
  if (row.courier_id == null || Number(row.courier_id) !== Number(courier_tg_id)) {
    logger.warn("Deliver refused: courier mismatch", { order_id, expected: row.courier_id, actual: courier_tg_id });
    return;
  }
  const items: OrderItem[] = JSON.parse(row.items_json);
  await finalDeduction(items);
  await releaseReservation(items, order_id);
  db.prepare("UPDATE orders SET status = 'delivered' WHERE order_id = ?").run(order_id);
  try { await updateAfterDelivery(Number(row.user_id), items); } catch {}
  try {
    const { getBackend } = await import("../../infra/backend");
    const backend = getBackend();
    await backend.commitDelivery(order_id);
  } catch {}
}

export async function cancelOrder(order_id: number): Promise<void> {
  const db = getDb();
  const row = db.prepare("SELECT items_json FROM orders WHERE order_id = ?").get(order_id) as { items_json: string } | undefined;
  if (!row) throw new Error("Order not found");
  const items: OrderItem[] = JSON.parse(row.items_json);
  await releaseReservation(items, order_id);
  db.prepare("UPDATE orders SET status = 'cancelled' WHERE order_id = ?").run(order_id);
}

export async function expireOrder(order_id: number): Promise<void> {
  const db = getDb();
  const row = db.prepare("SELECT items_json FROM orders WHERE order_id = ?").get(order_id) as { items_json: string } | undefined;
  if (!row) return;
  const items: OrderItem[] = JSON.parse(row.items_json);
  await releaseReservation(items, order_id);
  db.prepare("UPDATE orders SET status = 'expired' WHERE order_id = ?").run(order_id);
}

export async function getOrderById(order_id: number): Promise<Order | null> {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT order_id, user_id, items_json, total_without_discount, total_with_discount, discount_total, status, reserve_timestamp, expiry_timestamp, courier_id, delivery_interval, delivery_exact_time, source FROM orders WHERE order_id = ?"
    )
    .get(order_id) as any;
  if (!row) return null;
  return {
    order_id: Number(row.order_id),
    user_id: Number(row.user_id),
    items: JSON.parse(row.items_json),
    total_without_discount: Number(row.total_without_discount),
    total_with_discount: Number(row.total_with_discount),
    discount_total: Number(row.discount_total),
    status: row.status,
    reserve_timestamp: row.reserve_timestamp,
    expiry_timestamp: row.expiry_timestamp,
    courier_id: row.courier_id != null ? Number(row.courier_id) : null,
    delivery_interval: row.delivery_interval || null,
    delivery_exact_time: row.delivery_exact_time || null,
    source: row.source || "normal"
  };
}

export async function previewTotals(user_id: number, items: OrderItem[]) {
  const purchaseCount = await getDeliveredCountSourceOfTruth(user_id);
  return computeTotals(items, purchaseCount);
}

export async function getLastDeliveredOrderForUser(user_id: number): Promise<Order | null> {
  const db = getDb();
  const row = db
    .prepare(
      "SELECT order_id FROM orders WHERE user_id = ? AND status = 'delivered' ORDER BY order_id DESC LIMIT 1"
    )
    .get(user_id) as any;
  if (!row) return null;
  return await getOrderById(Number(row.order_id));
}
