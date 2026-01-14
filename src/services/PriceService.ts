import { batchGet } from "../infra/sheets/SheetsClient";
import { env } from "../infra/config";
import { shopConfig } from "../config/shopConfig";

type PriceRow = { city: string; from: number; to: number; price: number };

function sheetName(base: string, city: string) {
  if (env.GOOGLE_SHEETS_MODE === "TABS_PER_CITY") return `${base}_${city}`;
  return base;
}

const cache: { ts: number; rows: PriceRow[] } = { ts: 0, rows: [] };
const TTL_MS = 5 * 60 * 1000;

export function invalidateLiquidPricesCache(): void {
  cache.ts = 0;
  cache.rows = [];
}

export async function getLiquidUnitPrice(qty: number, city?: string): Promise<number> {
  const now = Date.now();
  const disableCache = String(process.env.LIQUID_PRICE_CACHE_DISABLE || "").trim() === "1";
  if (disableCache || !cache.rows.length || now - cache.ts > TTL_MS) {
    const c = (city || shopConfig.cityCode || "HG").trim();
    const s = sheetName("LiquidPrices", c);
    let vr = await batchGet([`${s}!A:D`]);
    let values = vr[0]?.values || [];
    if (!values.length) {
      vr = await batchGet([`LiquidPrices!A:D`]);
      values = vr[0]?.values || [];
    }
    const headers = values[0] || [];
    const rows = values.slice(1);
    const idxCity = headers.indexOf("city");
    const idxFrom = headers.indexOf("qty_from");
    const idxTo = headers.indexOf("qty_to");
    const idxPrice = headers.indexOf("price");
    const parsed: PriceRow[] = rows.map((r) => ({
      city: String(idxCity >= 0 ? r[idxCity] || "" : "").trim() || c,
      from: Number(idxFrom >= 0 ? r[idxFrom] || 0 : 0),
      to: Number(idxTo >= 0 ? r[idxTo] || 0 : 0),
      price: Number(idxPrice >= 0 ? r[idxPrice] || 0 : 0)
    })).filter((x) => x.city && x.from > 0 && x.price > 0);
    cache.rows = parsed;
    cache.ts = now;
    try { console.log("[LiquidPrices] Loaded rows:", parsed.length); } catch {}
  }
  const cityCode = (city || shopConfig.cityCode || "HG").trim();
  const match = cache.rows.find((r) => r.city === cityCode && qty >= r.from && (r.to ? qty <= r.to : true))
             || cache.rows.find((r) => r.city === "HG" && qty >= r.from && (r.to ? qty <= r.to : true));
  if (match) {
    try { console.log("Price from sheet:", cityCode, qty, match.price); } catch {}
    return match.price;
  }
  // fallback legacy tiers
  const fb = qty >= 3 ? 15 : (qty === 2 ? 16 : 18);
  try { console.log("Price fallback:", cityCode, qty, fb); } catch {}
  return fb;
}
