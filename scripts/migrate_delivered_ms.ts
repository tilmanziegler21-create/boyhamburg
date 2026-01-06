import { initDb, getDb } from "../src/infra/db/sqlite";

async function main() {
  await initDb();
  const db = getDb();
  const rows = db.prepare("SELECT order_id, delivered_timestamp FROM orders WHERE status='delivered' AND (delivered_at_ms IS NULL OR delivered_at_ms = 0)").all() as any[];
  let migrated = 0;
  for (const r of rows) {
    const iso = String(r.delivered_timestamp || "");
    if (!iso) continue;
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) continue;
    db.prepare("UPDATE orders SET delivered_at_ms = ? WHERE order_id = ?").run(ms, Number(r.order_id));
    migrated++;
  }
  process.stdout.write(`[migrate] delivered_at_ms updated: ${migrated}\n`);
}

main().catch((e) => {
  process.stderr.write(`[migrate] error: ${String(e)}\n`);
  process.exitCode = 1;
});
