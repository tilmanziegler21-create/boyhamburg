import { MetricsRow, Product, Courier } from "../../core/types";

export interface DataBackend {
  getProducts(city: string): Promise<Product[]>;
  getActiveCouriers(city: string): Promise<Courier[]>;
  appendOrder(order: {
    order_id: number;
    user_tg_id: number;
    username: string | null;
    city: string;
    status: string;
    items_json: string;
    total: number;
    reserved_until: string | null;
    courier_id: string | null;
    slot_time: string | null;
    created_at: string;
    delivered_at: string | null;
    sheets_committed: boolean;
  }): Promise<void>;
  commitDelivery(orderId: number): Promise<void>;
  upsertDailyMetrics(date: string, city: string, metrics: MetricsRow): Promise<void>;
}
