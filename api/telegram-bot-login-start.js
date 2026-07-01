import { adminDb } from "../lib/firebase-admin.js";
import {
  TELEGRAM_LOGIN_SESSION_COLLECTION,
  TELEGRAM_LOGIN_TTL_MS,
  createTelegramLoginCode,
  telegramBotUsername,
} from "../lib/telegram-bot-login.js";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const nowMs = Date.now();
  const code = createTelegramLoginCode();
  const expiresAt = new Date(nowMs + TELEGRAM_LOGIN_TTL_MS).toISOString();

  try {
    await adminDb().collection(TELEGRAM_LOGIN_SESSION_COLLECTION).doc(code).set({
      status: "pending",
      createdAt: new Date(nowMs).toISOString(),
      expiresAt,
    });
  } catch (error) {
    console.error("Telegram bot login start failed:", error);
    return response.status(500).json({ ok: false, error: "Could not start Telegram bot login" });
  }

  const bot = telegramBotUsername();
  return response.status(200).json({
    ok: true,
    code,
    expiresAt,
    botUrl: `https://t.me/${encodeURIComponent(bot)}?start=login_${code}`,
  });
}
