import { env, useSheets } from "../config";
import { batchGet } from "./SheetsClient";

function sheetName(base: string, city: string) {
  if (env.GOOGLE_SHEETS_MODE === "TABS_PER_CITY") return `${base}_${city}`;
  return base;
}

function hasColumns(headers: string[], required: string[]) {
  const set = new Set(headers);
  return required.filter((c) => !set.has(c));
}

async function getHeadersWithFallback(sheet: string): Promise<string[]> {
  try {
    const vr = await batchGet([`${sheet}!A:Z`]);
    return (vr[0]?.values?.[0] || []).map(String);
  } catch {
    const up = sheet.replace(/^[a-z]/, (c) => c.toUpperCase());
    const vr2 = await batchGet([`${up}!A:Z`]);
    return (vr2[0]?.values?.[0] || []).map(String);
  }
}

export async function validateSheetsSchemaOrThrow(defaultCity: string) {
  if (!useSheets) return;
  const productsSheet = sheetName("products", defaultCity);
  const couriersSheet = sheetName("couriers", defaultCity);
  const ordersSheet = sheetName("orders", defaultCity);
  const metricsSheet = sheetName("metrics", defaultCity);
  const headers = [
    await getHeadersWithFallback(productsSheet),
    await getHeadersWithFallback(couriersSheet),
    await getHeadersWithFallback(ordersSheet),
    await getHeadersWithFallback(metricsSheet)
  ];
  const [prodH, courH, ordH, metH] = headers;
  if (!prodH.length || !courH.length || !ordH.length || !metH.length) {
    const missTabs: string[] = [];
    if (!prodH.length) missTabs.push(productsSheet);
    if (!courH.length) missTabs.push(couriersSheet);
    if (!ordH.length) missTabs.push(ordersSheet);
    if (!metH.length) missTabs.push(metricsSheet);
    throw new Error(`Sheets tabs missing or empty: ${missTabs.join(", ")}`);
  }
}
