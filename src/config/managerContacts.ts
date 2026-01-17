export const MANAGER_CONTACTS: Record<string, string> = {
  hamburg: "@manager_hamburg",
  frankfurt: "@manager_frankfurt",
  munich: "@manager_munich",
  mannheim: "@manager_mannheim",
  wiesbaden: "@manager_wiesbaden",
  berlin: "@manager_berlin",
};

export function getManagerContact(cityCode: string): string {
  return MANAGER_CONTACTS[String(cityCode || "").toLowerCase()] || "@shop_support";
}
