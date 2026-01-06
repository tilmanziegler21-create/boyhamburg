import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { env } from "../config";
import { logger } from "../logger";

let db: Database.Database;

function ensureDir(filePath: string) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function getDb() {
  return db;
}

export async function initDb() {
  ensureDir(env.DB_PATH);
  db = new Database(env.DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS orders (
      order_id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      items_json TEXT NOT NULL,
      total_without_discount REAL NOT NULL,
      total_with_discount REAL NOT NULL,
      discount_total REAL NOT NULL,
      status TEXT NOT NULL,
      reserve_timestamp TEXT NOT NULL,
      expiry_timestamp TEXT NOT NULL,
      courier_id INTEGER,
      delivery_interval TEXT,
      delivery_exact_time TEXT,
      delivery_date TEXT,
      payment_method TEXT,
      delivered_timestamp TEXT,
      not_issued_timestamp TEXT,
      source TEXT,
      sheets_committed INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
    
    CREATE TABLE IF NOT EXISTS reservations (
      id INTEGER PRIMARY KEY,
      order_id INTEGER NOT NULL,
      product_id INTEGER NOT NULL,
      qty INTEGER NOT NULL,
      reserve_timestamp TEXT NOT NULL,
      expiry_timestamp TEXT NOT NULL,
      released INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_res_order ON reservations(order_id);
    
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      username TEXT,
      first_seen TEXT NOT NULL,
      last_purchase_date TEXT,
      next_reminder_date TEXT,
      segment TEXT
    );
    
    CREATE TABLE IF NOT EXISTS couriers (
      courier_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      tg_id INTEGER NOT NULL,
      active INTEGER NOT NULL,
      last_delivery_interval TEXT
    );
    
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY,
      date TEXT NOT NULL,
      type TEXT NOT NULL,
      order_id INTEGER,
      user_id INTEGER,
      payload TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_date_type ON events(date, type);
  `);
  logger.info("SQLite initialized", { path: env.DB_PATH });
  try {
    db.exec("ALTER TABLE orders ADD COLUMN sheets_committed INTEGER DEFAULT 0");
  } catch {}
  try {
    db.exec("ALTER TABLE orders ADD COLUMN payment_method TEXT");
  } catch {}
  try {
    db.exec("ALTER TABLE orders ADD COLUMN delivered_timestamp TEXT");
  } catch {}
  try {
    db.exec("ALTER TABLE orders ADD COLUMN delivered_at_ms INTEGER");
  } catch {}
  try {
    db.exec("CREATE INDEX IF NOT EXISTS idx_orders_delivered_at_ms ON orders(delivered_at_ms)");
  } catch {}
  try {
    db.exec("ALTER TABLE orders ADD COLUMN not_issued_timestamp TEXT");
  } catch {}
  try {
    db.exec("ALTER TABLE orders ADD COLUMN delivery_date TEXT");
  } catch {}
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS upsell_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      );
    `);
    db.exec("CREATE INDEX IF NOT EXISTS idx_upsell_events_timestamp ON upsell_events(timestamp)");
  } catch {}
}
