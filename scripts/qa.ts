import { initDb, getDb } from "../src/infra/db/sqlite";
import { ensureUser } from "../src/domain/users/UserService";
import { getProducts, updateProductQty } from "../src/infra/data";
import { createOrder, confirmOrder, setOrderCourier, setCourierAssigned, setDeliverySlot, setPaymentMethod, setDelivered, getOrderById, clearDeliverySlot, setNotIssued, purgeNotIssuedOlderThan } from "../src/domain/orders/OrderService";
import { getActiveCouriers } from "../src/domain/couriers/CourierService";
import { generateTimeSlots, validateSlot } from "../src/domain/delivery/DeliveryService";

function ok(name: string) { process.stdout.write(`[OK] ${name}\n`); }
function fail(name: string, e: any) { process.stderr.write(`[FAIL] ${name}: ${String(e)}\n`); process.exitCode = 1; }

async function testE2E() {
  await initDb();
  const db = getDb();
  db.exec("DELETE FROM orders; DELETE FROM reservations; DELETE FROM events; DELETE FROM users;");
  const userId = 101010;
  await ensureUser(userId, "qa_user");
  const products = await getProducts();
  const liqu = products.filter(p => p.category === "liquids" && p.active);
  const p1 = liqu[0];
  const order = await createOrder(userId, [{ product_id: p1.product_id, qty: 1, price: 18, is_upsell: false }]);
  await confirmOrder(order.order_id);
  const couriers = await getActiveCouriers();
  const cour = couriers[0];
  await setOrderCourier(order.order_id, cour.tg_id);
  await setCourierAssigned(order.order_id, cour.tg_id);
  const slots = generateTimeSlots(cour.last_delivery_interval);
  const time = slots[Math.floor(slots.length / 2)];
  if (!validateSlot(cour.last_delivery_interval, time)) throw new Error("Slot invalid");
  await setDeliverySlot(order.order_id, cour.last_delivery_interval, time);
  await setPaymentMethod(order.order_id, "cash");
  const beforeQty = p1.qty_available;
  await setDelivered(order.order_id, cour.tg_id);
  const row = db.prepare("SELECT delivered_timestamp FROM orders WHERE order_id = ?").get(order.order_id) as any;
  if (!row?.delivered_timestamp) throw new Error("No delivered_timestamp");
  ok("Delivered timestamp set");
  const pAfter = (await getProducts()).find(p => p.product_id === p1.product_id)!;
  if (pAfter.qty_available !== beforeQty - 1) throw new Error("Stock not decremented");
  ok("Stock decremented");
}

async function testCancel() {
  const db = getDb();
  const userId = 202020;
  await ensureUser(userId, "qa_user2");
  const products = await getProducts();
  const liqu = products.filter(p => p.category === "liquids" && p.active);
  const p1 = liqu[1] || liqu[0];
  const cour = (await getActiveCouriers())[0];
  const order = await createOrder(userId, [{ product_id: p1.product_id, qty: 1, price: 18, is_upsell: false }]);
  await confirmOrder(order.order_id);
  await setOrderCourier(order.order_id, cour.tg_id);
  await setCourierAssigned(order.order_id, cour.tg_id);
  const slots = generateTimeSlots(cour.last_delivery_interval);
  await setDeliverySlot(order.order_id, cour.last_delivery_interval, slots[0]);
  await clearDeliverySlot(order.order_id);
  const o = await getOrderById(order.order_id);
  if (!o || o.courier_id !== null || o.delivery_exact_time !== null || o.status !== "pending") throw new Error("Clear slot failed");
  ok("Clear slot resets assignment and status");
}

async function testNotIssuedPurge() {
  const db = getDb();
  const cour = (await getActiveCouriers())[0];
  const products = await getProducts();
  const p = products.find(p=>p.category==='liquids')!;
  const userId = 404040;
  await ensureUser(userId, "qa_user3");
  const o = await createOrder(userId, [{ product_id: p.product_id, qty: 1, price: 18, is_upsell: false }]);
  await confirmOrder(o.order_id);
  await setOrderCourier(o.order_id, cour.tg_id);
  await setCourierAssigned(o.order_id, cour.tg_id);
  await setNotIssued(o.order_id);
  const before = db.prepare("SELECT COUNT(1) AS c FROM orders WHERE status='not_issued'").get() as any;
  if (!before?.c) throw new Error("not_issued set failed");
  const n = await purgeNotIssuedOlderThan(0);
  const after = db.prepare("SELECT COUNT(1) AS c FROM orders WHERE status='not_issued'").get() as any;
  if (Number(after?.c||0) !== 0 || n < 1) throw new Error("purge not_issued failed");
  ok("Not issued purge");
}

async function testStress() {
  const db = getDb();
  const cour = (await getActiveCouriers())[0];
  const products = await getProducts();
  const liqu = products.filter(p => p.category === "liquids" && p.active);
  for (const p of liqu) await updateProductQty(p.product_id, 100);
  const products2 = await getProducts();
  const liqu2 = products2.filter(p => p.category === "liquids" && p.active);
  const before = liqu2.reduce((s,p)=>s+p.qty_available,0);
  const tasks: Promise<void>[] = [];
  for (let k = 0; k < 15; k++) {
    const userId = 300000 + k;
    tasks.push((async () => {
      await ensureUser(userId, `u${k}`);
      const p = liqu2[(k)%liqu2.length];
      const o = await createOrder(userId, [{ product_id: p.product_id, qty: 1, price: 18, is_upsell: false }]);
      await confirmOrder(o.order_id);
      await setOrderCourier(o.order_id, cour.tg_id);
      await setCourierAssigned(o.order_id, cour.tg_id);
      const slots = generateTimeSlots(cour.last_delivery_interval);
      await setDeliverySlot(o.order_id, cour.last_delivery_interval, slots[(k)%slots.length]);
      await setPaymentMethod(o.order_id, "card");
      await setDelivered(o.order_id, cour.tg_id);
    })());
  }
  await Promise.all(tasks);
  const afterProducts = await getProducts();
  const liquAfter = afterProducts.filter(p => p.category === "liquids" && p.active);
  const after = liquAfter.reduce((s,p)=>s+p.qty_available,0);
  if (after !== before - 15) {
    process.stdout.write(`before=${before} after=${after}\n`);
    const db = getDb();
    const deliveredCount = (db.prepare("SELECT COUNT(1) AS c FROM orders WHERE status='delivered'").get() as any)?.c || 0;
    process.stdout.write(`delivered=${deliveredCount}\n`);
    throw new Error("Stress stock mismatch");
  }
  ok("Stress 15 orders handled");
}

async function main() {
  try { await testE2E(); } catch (e) { fail("E2E", e); }
  try { await testCancel(); } catch (e) { fail("Cancel", e); }
  try { await testNotIssuedPurge(); } catch (e) { fail("NotIssued", e); }
  try { await testStress(); } catch (e) { fail("Stress", e); }
}

main().catch((e) => fail("Main", e));
