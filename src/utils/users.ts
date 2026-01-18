import { getDb } from "../infra/db/sqlite";

export async function getUsername(userId: number, bot: any): Promise<string> {
  if (!userId) return "Клиент";
  try {
    const db = getDb();
    const row = db.prepare("SELECT username FROM users WHERE user_id = ?").get(userId) as any;
    if (row?.username) return `@${row.username}`;
    const chat = await bot.getChat(userId);
    const uname = chat?.username || null;
    if (uname) {
      db.prepare("INSERT INTO users(user_id, username) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET username=?").run(userId, uname, uname);
      return `@${uname}`;
    }
    return "Клиент";
  } catch {
    return "Клиент";
  }
}
