import { OrderItem, Product } from "../../core/types";
import { UPSellDiscountRate } from "../../core/constants";

export function getUpsellSuggestions(primary: OrderItem[], products: Product[]): Product[] {
  const groups = new Set<number>();
  for (const it of primary) {
    const p = products.find((x) => x.product_id === it.product_id);
    if (p && typeof p.upsell_group_id === "number") groups.add(p.upsell_group_id);
  }
  const sug = products.filter((p) => p.active && p.upsell_group_id != null && groups.has(p.upsell_group_id as number));
  return sug.sort((a, b) => a.price - b.price).slice(0, 6);
}

export function recalculateTotals(items: OrderItem[]) {
  const totalWithout = items.reduce((s, it) => s + it.price * it.qty, 0);
  const discount = items.reduce((s, it) => s + (it.is_upsell ? it.price * it.qty * UPSellDiscountRate : 0), 0);
  const totalWith = totalWithout - discount;
  const to2 = (n: number) => Math.round(n * 100) / 100;
  return {
    total_without_discount: to2(totalWithout),
    discount_total: to2(discount),
    total_with_discount: to2(totalWith)
  };
}
