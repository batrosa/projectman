import { adminAuth, adminDb } from "../lib/firebase-admin.js";
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

  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return response.status(400).json({ ok: false, error: "Invalid JSON body" });
  }

  const mode = body.mode === "link" ? "link" : "login";
  let uid = null;

  try {
    const db = adminDb();
    if (mode === "link") {
      const idToken = String(request.headers?.authorization || "").replace(/^Bearer\s+/i, "");
      if (!idToken) return response.status(401).json({ ok: false, error: "Authentication required" });

      let decoded;
      try {
        decoded = await adminAuth().verifyIdToken(idToken);
      } catch {
        return response.status(401).json({ ok: false, error: "Invalid authentication token" });
      }
      uid = decoded.uid;

      const userDoc = await db.collection("users").doc(uid).get();
      if (!userDoc.exists) {
        return response.status(404).json({ ok: false, error: "User profile was not found" });
      }
      const user = userDoc.data() || {};
      if (user.telegramId || user.telegramChatId || user.authProvider === "telegram") {
        return response.status(409).json({
          ok: false,
          status: "already_linked",
          error: "Telegram is already linked",
        });
      }
    }

    const nowMs = Date.now();
    const code = createTelegramLoginCode();
    const expiresAt = new Date(nowMs + TELEGRAM_LOGIN_TTL_MS).toISOString();
    await db.collection(TELEGRAM_LOGIN_SESSION_COLLECTION).doc(code).set({
      status: "pending",
      mode,
      ...(uid ? { uid } : {}),
      createdAt: new Date(nowMs).toISOString(),
      expiresAt,
    });

    const bot = telegramBotUsername();
    return response.status(200).json({
      ok: true,
      code,
      expiresAt,
      botUrl: `https://t.me/${encodeURIComponent(bot)}?start=${mode}_${code}`,
    });
  } catch (error) {
    console.error("Telegram bot login start failed:", error);
    return response.status(500).json({ ok: false, error: "Could not start Telegram bot login" });
  }
}

async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");
  if (!request[Symbol.asyncIterator]) return {};
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
