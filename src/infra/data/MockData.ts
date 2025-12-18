import { Courier, Order, Product, User } from "../../core/types";

let products: Product[] = [
  {
    product_id: 1,
    title: "Жидкость Классик 60 мл",
    brand: "ELFIC",
    price: 18,
    category: "liquids",
    qty_available: 50,
    upsell_group_id: 10,
    reminder_offset_days: 7,
    active: true
  },
  {
    product_id: 2,
    title: "Жидкость Фрукт 60 мл",
    brand: "CHASER",
    price: 18,
    category: "liquids",
    qty_available: 40,
    upsell_group_id: 10,
    reminder_offset_days: 7,
    active: true
  },
  {
    product_id: 3,
    title: "Электроника Coil X",
    brand: null,
    price: 45,
    category: "electronics",
    qty_available: 20,
    upsell_group_id: 20,
    reminder_offset_days: 0,
    active: true
  }
];

let couriers: Courier[] = [
  { courier_id: 100, name: "Тест Курьер", tg_id: 8551771212, active: true, last_delivery_interval: "14-16" }
];

let users: User[] = [];
let orders: Order[] = [];

export async function getProducts(): Promise<Product[]> {
  return JSON.parse(JSON.stringify(products));
}

export async function updateProductQty(product_id: number, new_qty: number): Promise<void> {
  const p = products.find((x) => x.product_id === product_id);
  if (p) p.qty_available = new_qty;
}

export async function updateProductPrice(product_id: number, new_price: number): Promise<void> {
  const p = products.find((x) => x.product_id === product_id);
  if (p) p.price = new_price;
}

export async function getCouriers(): Promise<Courier[]> {
  return JSON.parse(JSON.stringify(couriers));
}

export async function updateCourier(courier_id: number, fields: Partial<Courier>): Promise<void> {
  const c = couriers.find((x) => x.courier_id === courier_id || x.tg_id === courier_id);
  if (!c) return;
  Object.assign(c, fields);
}

export async function getUsers(): Promise<User[]> {
  return JSON.parse(JSON.stringify(users));
}

export async function addUser(user: User): Promise<void> {
  const exists = users.find((u) => u.user_id === user.user_id);
  if (!exists) users.push({ ...user });
}

export async function updateUser(user_id: number, fields: Partial<User>): Promise<void> {
  const u = users.find((x) => x.user_id === user_id);
  if (!u) return;
  Object.assign(u, fields);
}

export async function addOrder(order: Order): Promise<void> {
  orders.push({ ...order });
}

export async function updateOrder(order_id: number, fields: Partial<Order>): Promise<void> {
  const o = orders.find((x) => x.order_id === order_id);
  if (!o) return;
  Object.assign(o, fields);
}

export async function getOrderById(order_id: number): Promise<Order | null> {
  const o = orders.find((x) => x.order_id === order_id);
  return o ? JSON.parse(JSON.stringify(o)) : null;
}
