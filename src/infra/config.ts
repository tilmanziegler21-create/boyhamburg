import fs from "fs";

type Env = {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_ADMIN_IDS: string;
  GOOGLE_SHEETS_SPREADSHEET_ID: string;
  GOOGLE_SERVICE_ACCOUNT_EMAIL: string;
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: string;
  DB_PATH: string;
  TIMEZONE: string;
  DATA_BACKEND: "sheets" | "mock";
  GROUP_URL: string;
  REVIEWS_URL: string;
  GOOGLE_SHEETS_MODE: "TABS_PER_CITY" | "CITY_COLUMN";
  CITY_CODES: string;
  SHEETS_CACHE_TTL_SECONDS: number;
  SHEETS_WRITE_RETRY: number;
  SHEETS_WRITE_RETRY_BACKOFF_MS: number;
};

function requireEnv(key: keyof Env): string {
  const v = process.env[key as string];
  if (!v || v.trim() === "") throw new Error(`Missing env ${key}`);
  return v;
}

const DATA_BACKEND = (process.env.DATA_BACKEND as Env["DATA_BACKEND"]) || "mock";
const SA_PATH = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH || "service-account.json";
let SA_EMAIL = "";
let SA_KEY = "";
if (DATA_BACKEND === "sheets") {
  try {
    const raw = fs.readFileSync(SA_PATH, "utf-8");
    const j = JSON.parse(raw);
    SA_EMAIL = String(j.client_email || "");
    SA_KEY = String(j.private_key || "");
  } catch {}
}

export const env: Env = {
  TELEGRAM_BOT_TOKEN: requireEnv("TELEGRAM_BOT_TOKEN"),
  TELEGRAM_ADMIN_IDS: process.env.TELEGRAM_ADMIN_IDS || "",
  GOOGLE_SHEETS_SPREADSHEET_ID:
    DATA_BACKEND === "sheets" ? requireEnv("GOOGLE_SHEETS_SPREADSHEET_ID") : process.env.GOOGLE_SHEETS_SPREADSHEET_ID || "",
  GOOGLE_SERVICE_ACCOUNT_EMAIL:
    DATA_BACKEND === "sheets" ? (SA_EMAIL || requireEnv("GOOGLE_SERVICE_ACCOUNT_EMAIL")) : process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY:
    DATA_BACKEND === "sheets"
      ? ((SA_KEY && SA_KEY.length) ? SA_KEY : requireEnv("GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY").replace(/\\n/g, "\n"))
      : (process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  DB_PATH: process.env.DB_PATH || "./data/app.db",
  TIMEZONE: process.env.TIMEZONE || "Europe/Moscow",
  DATA_BACKEND,
  GROUP_URL: process.env.GROUP_URL || "",
  REVIEWS_URL: process.env.REVIEWS_URL || "",
  GOOGLE_SHEETS_MODE: (process.env.GOOGLE_SHEETS_MODE as Env["GOOGLE_SHEETS_MODE"]) || "CITY_COLUMN",
  CITY_CODES: process.env.CITY_CODES || "FFM",
  SHEETS_CACHE_TTL_SECONDS: Number(process.env.SHEETS_CACHE_TTL_SECONDS || 60),
  SHEETS_WRITE_RETRY: Number(process.env.SHEETS_WRITE_RETRY || 3),
  SHEETS_WRITE_RETRY_BACKOFF_MS: Number(process.env.SHEETS_WRITE_RETRY_BACKOFF_MS || 500)
};

export const useSheets = env.DATA_BACKEND === "sheets";
