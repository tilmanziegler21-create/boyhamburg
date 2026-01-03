import { getDb } from "../../infra/db/sqlite";
import { formatDate } from "../../core/time";

export function generateTimeSlots(interval: string): string[] {
  const [a, b] = interval.split("-");
  const [sh, sm] = a.includes(":") ? a.split(":").map((x) => Number(x)) : [Number(a), 0];
  const [eh, em] = b.includes(":") ? b.split(":").map((x) => Number(x)) : [Number(b), 0];
  const slots: string[] = [];
  let h = sh, m = sm;
  while (h < eh || (h === eh && m < em)) {
    slots.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    m += 10;
    if (m >= 60) { m = 0; h += 1; }
  }
  slots.push(`${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}`);
  return slots;
}

export function validateSlot(interval: string, time: string): boolean {
  const slots = generateTimeSlots(interval);
  return slots.includes(time);
}

export function getOccupiedSlots(courier_tg_id: number, date?: string): Set<string> {
  const db = getDb();
  const d = date || formatDate(new Date());
  const rows = db
    .prepare("SELECT delivery_exact_time FROM orders WHERE courier_id = ? AND status IN ('pending','courier_assigned') AND delivery_date = ?")
    .all(courier_tg_id, d) as any[];
  const set = new Set<string>();
  for (const r of rows) if (r.delivery_exact_time) set.add(String(r.delivery_exact_time));
  return set;
}

export function isSlotAvailable(courier_tg_id: number, time: string): boolean {
  const occ = getOccupiedSlots(courier_tg_id);
  return !occ.has(time);
}
