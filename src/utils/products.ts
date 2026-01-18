import { batchGet } from "../infra/sheets/SheetsClient";
import { Product } from "../core/types";

export async function getProductsMap(cityCode: string): Promise<Map<string, Product>> {
  const candidates = [`products_${cityCode}`, `Products_${cityCode}`, "products", "Products"];
  const map = new Map<string, Product>();
  for (const table of candidates) {
    try {
      const vr = await batchGet([`${table}!A:Z`]);
      const values = vr[0]?.values || [];
      if (!values.length) continue;
      const headers = values[0] || [];
      const idIdx = headers.indexOf("product_id") >= 0 ? headers.indexOf("product_id")
        : (headers.indexOf("id") >= 0 ? headers.indexOf("id") : (headers.indexOf("ID") >= 0 ? headers.indexOf("ID") : 0));
      const nameIdx = headers.indexOf("name") >= 0 ? headers.indexOf("name")
        : (headers.indexOf("product_name") >= 0 ? headers.indexOf("product_name")
        : (headers.indexOf("Name") >= 0 ? headers.indexOf("Name") : 1));
      const brandIdx = headers.indexOf("brand") >= 0 ? headers.indexOf("brand") : -1;
      const priceIdx = headers.indexOf("price") >= 0 ? headers.indexOf("price") : -1;
      for (const r of values.slice(1)) {
        const idRaw = String(r[idIdx] || "").trim();
        const name = String(r[nameIdx] || "").trim();
        if (!idRaw || !name) continue;
        const brand = brandIdx >= 0 ? String(r[brandIdx] || "").trim() : "";
        const price = priceIdx >= 0 ? Number(String(r[priceIdx] || "0").replace(",", ".")) : 0;
        const prod: Product = {
          product_id: Number(parseInt(idRaw, 10)) || 0,
          title: name,
          price,
          category: "liquids",
          brand: brand || null,
          qty_available: 0,
          upsell_group_id: null,
          reminder_offset_days: 0,
          active: true
        };
        map.set(idRaw, prod);
        map.set(idRaw.trim(), prod);
        map.set(idRaw.toLowerCase(), prod);
        const numId = parseInt(idRaw, 10);
        if (!Number.isNaN(numId)) map.set(String(numId), prod);
      }
    } catch {}
  }
  return map;
}

export function normalizeProductId(id: string | number): string {
  const s = String(id ?? "").trim();
  const n = Number(s);
  if (Number.isFinite(n)) return String(n);
  return s.toLowerCase();
}

export function formatProductName(product: Product): string {
  const brand = product.brand ? `${String(product.brand).toUpperCase()} · ` : "";
  return `${brand}${product.title}`;
}
