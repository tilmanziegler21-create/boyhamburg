import { batchGet } from "../infra/sheets/SheetsClient";
import { env } from "../infra/config";
import { shopConfig } from "../config/shopConfig";

type PriceRow = { city: string; qty: number; price: number };

function sheetName(base: string, city: string) {
  if (env.GOOGLE_SHEETS_MODE === "TABS_PER_CITY") return `${base}_${city}`;
  return base;
}

const cache: { ts: number; rows: PriceRow[] } = { ts: 0, rows: [] };
const TTL_MS = 5 * 60 * 1000;

export async function getLiquidUnitPrice(qty: number, city?: string): Promise<number> {
  const now = Date.now();
  if (!cache.rows.length || now - cache.ts > TTL_MS) {
    const c = (city || shopConfig.cityCode || "HG").trim();
    const s = sheetName("LiquidPrices", c);
    let vr = await batchGet([`${s}!A:C`]);
    let values = vr[0]?.values || [];
    if (!values.length) {
      vr = await batchGet([`LiquidPrices!A:C`]);
      values = vr[0]?.values || [];
    }
    const headers = values[0] || [];
    const rows = values.slice(1);
    const idxCity = headers.indexOf("city");
    const idxQty = headers.indexOf("qty");
    const idxPrice = headers.indexOf("price");
    const parsed: PriceRow[] = rows.map((r) => ({
      city: String(idxCity >= 0 ? r[idxCity] || "" : "").trim() || c,
      qty: Number(idxQty >= 0 ? r[idxQty] || 0 : 0),
      price: Number(idxPrice >= 0 ? r[idxPrice] || 0 : 0)
    })).filter((x) => x.city && x.qty > 0 && x.price > 0);
    cache.rows = parsed;
    cache.ts = now;
  }
  const cityCode = (city || shopConfig.cityCode || "HG").trim();
  const match = cache.rows.find((r) => r.city === cityCode && r.qty === qty)
             || cache.rows.find((r) => r.city === "HG" && r.qty === qty);
  if (match) return match.price;
  // fallback legacy tiers
  return qty >= 3 ? 15 : (qty === 2 ? 16 : 18);
}
