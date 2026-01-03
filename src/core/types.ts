export type Category = "liquids" | "electronics";

export type Product = {
  product_id: number;
  title: string;
  price: number;
  category: Category;
  brand?: string | null;
  qty_available: number;
  upsell_group_id: number | null;
  reminder_offset_days: number;
  active: boolean;
};

export type OrderItem = {
  product_id: number;
  qty: number;
  price: number;
  is_upsell: boolean;
};

export type OrderStatus =
  | "buffer"
  | "pending"
  | "courier_assigned"
  | "delivered"
  | "expired"
  | "cancelled"
  | "not_issued";

export type Order = {
  order_id: number;
  user_id: number;
  items: OrderItem[];
  total_without_discount: number;
  total_with_discount: number;
  discount_total: number;
  status: OrderStatus;
  reserve_timestamp: string;
  expiry_timestamp: string;
  courier_id: number | null;
  delivery_interval: string | null;
  delivery_exact_time: string | null;
  delivery_date?: string | null;
  source?: "normal" | "reminder";
};

export type User = {
  user_id: number;
  username: string;
  first_seen: string;
  last_purchase_date: string | null;
  next_reminder_date: string | null;
  segment: string | null;
};

export type Courier = {
  courier_id: number;
  name: string;
  tg_id: number;
  active: boolean;
  last_delivery_interval: "12-14" | "14-16" | "16-18" | "18-20";
};

export type MetricsRow = {
  date: string;
  orders: number;
  revenue: number;
  avg_check: number;
  upsell_clicks: number;
  upsell_accepts: number;
  repeat_purchases: number;
  liquids_sales: number;
  electronics_sales: number;
  growth_percent: number;
  platform_commission?: number;
  courier_commission?: number;
};
