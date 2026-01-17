function normAt(u: string): string {
  const s = String(u || "").trim();
  return s ? (s.startsWith("@") ? s : `@${s}`) : "";
}

export const MANAGER_CONTACTS: Record<string, string> = {
  hamburg: "@manager_hamburg",
  frankfurt: "@manager_frankfurt",
  munich: "@manager_munich",
  mannheim: "@manager_mannheim",
  wiesbaden: "@manager_wiesbaden",
  berlin: "@manager_berlin",
};

export function getManagerContact(cityCode: string): string {
  const code = String(cityCode || "").toLowerCase();
  const envKey = `MANAGER_USERNAME_${code.toUpperCase()}`;
  const fromEnv = process.env[envKey] || process.env.MANAGER_USERNAME || "";
  const byEnv = normAt(fromEnv);
  if (byEnv) return byEnv;
  return MANAGER_CONTACTS[code] || "@shop_support";
}
