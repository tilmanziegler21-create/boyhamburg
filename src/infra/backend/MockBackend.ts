import { DataBackend } from "./DataBackend";
import { getProducts as mockGetProducts, getCouriers as mockGetCouriers } from "../data";
import { MetricsRow, Product, Courier } from "../../core/types";
import { getDb } from "../db/sqlite";

export class MockBackend implements DataBackend {
  async getProducts(city: string): Promise<Product[]> { return await mockGetProducts(); }
  async getActiveCouriers(city: string): Promise<Courier[]> { return (await mockGetCouriers()).filter(c=>c.active); }
  async appendOrder(order: any): Promise<void> { /* no-op for mock */ }
  async commitDelivery(orderId: number): Promise<void> { /* no-op for mock */ }
  async upsertDailyMetrics(date: string, city: string, metrics: MetricsRow): Promise<void> { /* no-op for mock */ }
}
