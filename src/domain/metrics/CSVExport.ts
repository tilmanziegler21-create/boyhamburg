import fs from "fs";
import path from "path";
import { getDb } from "../../infra/db/sqlite";
import { getProducts } from "../../infra/data";
import { formatDate } from "../../core/time";

function fmt(n: number) {
  return n.toFixed(2).replace(".", ",");
}

export async function generateDailyReportCSV(filePath: string, days = 7) {
  const db = getDb();
  const products = await getProducts();
  const end = new Date();
  const rows: string[] = [];
  rows.push(["дата","заказы","выручка","комиссия курьеру (20%)","комиссия платформе (5%)","продажи жидкостей (шт)","продажи электроники (шт)"].join(","));
  for (let d = 0; d < days; d++) {
    const day = new Date(end.getTime() - d * 86400000);
    const date = formatDate(day);
    const delivered = db.prepare("SELECT total_with_discount, items_json FROM orders WHERE status='delivered' AND substr(reserve_timestamp,1,10)=?").all(date) as any[];
    const orders = delivered.length;
    const revenue = delivered.reduce((s, r) => s + Number(r.total_with_discount), 0);
    const courierCommission = Math.round(revenue * 0.20 * 100) / 100;
    const platformCommission = Math.round(revenue * 0.05 * 100) / 100;
    let liquids = 0, electronics = 0;
    for (const r of delivered) {
      const items = JSON.parse(r.items_json);
      for (const i of items) {
        const p = products.find((x) => x.product_id === i.product_id);
        if (!p) continue;
        if (p.category === "liquids") liquids += i.qty;
        else if (p.category === "electronics") electronics += i.qty;
      }
    }
    rows.push([date, orders, fmt(revenue), fmt(courierCommission), fmt(platformCommission), liquids, electronics].join(","));
  }
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, rows.join("\n"));
}

export async function generateCouriersCSV(filePath: string) {
  const { getCouriers } = await import("../../infra/data");
  const couriers = await getCouriers();
  const rows: string[] = [];
  rows.push(["id курьера","имя","tg_id","активен","интервал"].join(","));
  for (const c of couriers) rows.push([c.courier_id, c.name, c.tg_id, c.active ? 1 : 0, c.last_delivery_interval].join(","));
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, rows.join("\n"));
}

export async function generateOrdersCSV(filePath: string, days = 7) {
  const db = getDb();
  const end = new Date();
  const start = new Date(end.getTime() - days * 86400000);
  const rows: string[] = [];
  rows.push(["заказ","id пользователя","статус","сумма","время резерва","интервал","время","курьер"].join(","));
  const list = db
    .prepare("SELECT order_id,user_id,status,total_with_discount,reserve_timestamp,delivery_interval,delivery_exact_time,courier_id FROM orders WHERE reserve_timestamp >= ? ORDER BY order_id DESC")
    .all(start.toISOString()) as any[];
  for (const o of list) rows.push([
    o.order_id,
    o.user_id,
    o.status,
    fmt(Number(o.total_with_discount)),
    o.reserve_timestamp,
    o.delivery_interval || "",
    o.delivery_exact_time || "",
    o.courier_id || ""
  ].join(","));
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, rows.join("\n"));
}

export async function generateAccountingCSV(filePath: string) {
  const db = getDb();
  const products = await getProducts();
  const date = formatDate(new Date());
  const rows: string[] = [];
  rows.push(["дата","заказы","выручка","наличные","карта","жидкости(шт)","электроника(шт)","доставок курьерами"].join(","));
  const delivered = db.prepare("SELECT total_with_discount, items_json, payment_method, courier_id FROM orders WHERE status='delivered' AND substr(reserve_timestamp,1,10)=?").all(date) as any[];
  const orders = delivered.length;
  const revenue = delivered.reduce((s, r) => s + Number(r.total_with_discount), 0);
  const cash = delivered.filter((r) => String(r.payment_method) === 'cash').reduce((s, r) => s + Number(r.total_with_discount), 0);
  const card = delivered.filter((r) => String(r.payment_method) === 'card').reduce((s, r) => s + Number(r.total_with_discount), 0);
  let liquids = 0, electronics = 0;
  for (const r of delivered) {
    const items = JSON.parse(r.items_json || '[]');
    for (const i of items) {
      const p = products.find((x) => x.product_id === i.product_id);
      if (!p) continue;
      if (p.category === 'liquids') liquids += i.qty; else electronics += i.qty;
    }
  }
  const couriersDelivered = new Set<number>();
  for (const r of delivered) if (r.courier_id) couriersDelivered.add(Number(r.courier_id));
  rows.push([date, String(orders), fmt(revenue), fmt(cash), fmt(card), String(liquids), String(electronics), String(couriersDelivered.size)].join(","));
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, rows.join("\n"));
}
