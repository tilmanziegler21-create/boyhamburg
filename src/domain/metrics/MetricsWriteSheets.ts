import { MetricsRow } from "../../core/types";
import { google } from "googleapis";
import { env } from "../../infra/config";

function api() {
  const jwt = new google.auth.JWT({
    email: env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
    key: env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"]
  });
  return google.sheets({ version: "v4", auth: jwt });
}

export async function writeDailyMetrics(row: MetricsRow): Promise<void> {
  const sheets = api();
  await sheets.spreadsheets.values.append({
    spreadsheetId: env.GOOGLE_SHEETS_SPREADSHEET_ID,
    range: "Metrics",
    valueInputOption: "RAW",
    requestBody: {
      values: [[
        row.date,
        String(row.orders),
        String(row.revenue),
        String(row.avg_check),
        String(row.upsell_clicks),
        String(row.upsell_accepts),
        String(row.repeat_purchases),
        String(row.liquids_sales),
        String(row.electronics_sales),
        String(row.growth_percent),
        String(row.platform_commission ?? Math.round(row.revenue * 0.05 * 100) / 100),
        String(row.courier_commission ?? Math.round(row.revenue * 0.20 * 100) / 100)
      ]]
    }
  });
}
