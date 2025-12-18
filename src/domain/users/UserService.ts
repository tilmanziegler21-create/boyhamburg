import { getDb } from "../../infra/db/sqlite";
import { formatDate, addDays } from "../../core/time";
import { OrderItem, User } from "../../core/types";
import { getProducts, addUser as sheetsAddUser, updateUser as sheetsUpdateUser } from "../../infra/data";

export async function ensureUser(user_id: number, username: string): Promise<void> {
  const db = getDb();
  const existing = db.prepare("SELECT user_id FROM users WHERE user_id = ?").get(user_id) as any;
  if (existing) return;
  const today = formatDate(new Date());
  db.prepare("INSERT INTO users(user_id, username, first_seen, last_purchase_date, next_reminder_date, segment) VALUES (?, ?, ?, ?, ?, ?)").run(
    user_id,
    username,
    today,
    null,
    null,
    null
  );
  const u: User = {
    user_id,
    username,
    first_seen: today,
    last_purchase_date: null,
    next_reminder_date: null,
    segment: null
  };
  try {
    await sheetsAddUser(u);
  } catch {}
}

export async function updateAfterDelivery(user_id: number, items: OrderItem[]): Promise<void> {
  const db = getDb();
  const today = formatDate(new Date());
  const products = await getProducts();
  let liquidsQty = 0;
  for (const it of items) {
    const p = products.find((x) => x.product_id === it.product_id);
    if (p && p.category === "liquids") liquidsQty += Number(it.qty);
  }
  const offsetDays = liquidsQty >= 2 ? 24 : (liquidsQty >= 1 ? 14 : 0);
  const next = offsetDays > 0 ? formatDate(addDays(new Date(), offsetDays)) : null;
  db.prepare("UPDATE users SET last_purchase_date = ?, next_reminder_date = ? WHERE user_id = ?").run(today, next, user_id);
  try {
    await sheetsUpdateUser(user_id, { last_purchase_date: today, next_reminder_date: next || "" } as any);
  } catch {}
}

export function getUserSegment(user_id: number): string | null {
  const db = getDb();
  const row = db.prepare("SELECT segment FROM users WHERE user_id = ?").get(user_id) as any;
  const s = row?.segment != null ? String(row.segment) : null;
  return s && s.trim() ? s : null;
}
