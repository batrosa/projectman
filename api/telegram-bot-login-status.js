import { adminAuth, adminDb } from "../lib/firebase-admin.js";
import {
  TELEGRAM_LOGIN_SESSION_COLLECTION,
  isValidTelegramLoginCode,
} from "../lib/telegram-bot-login.js";
import { findOrCreateTelegramUser } from "../lib/telegram-user.js";

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

  const code = body.code;
  if (!isValidTelegramLoginCode(code)) {
    return response.status(400).json({ ok: false, error: "Invalid login code" });
  }

  try {
    const db = adminDb();
    const sessionRef = db.collection(TELEGRAM_LOGIN_SESSION_COLLECTION).doc(code);
    const sessionDoc = await sessionRef.get();
    if (!sessionDoc.exists) {
      return response.status(404).json({ ok: false, status: "not_found", error: "Login code was not found" });
    }

    const session = sessionDoc.data() || {};
    const expiresAtMs = Date.parse(session.expiresAt || "");
    if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
      await sessionRef.set({ status: "expired", expiredAt: new Date().toISOString() }, { merge: true });
      return response.status(200).json({ ok: false, status: "expired", error: "Login code has expired" });
    }

    if (session.status === "pending") {
      return response.status(200).json({ ok: true, status: "pending", expiresAt: session.expiresAt });
    }

    if (session.status !== "confirmed") {
      return response.status(409).json({ ok: false, status: session.status || "used", error: "Login code is no longer active" });
    }

    if (!session.telegramId) {
      console.error("Telegram bot login session is confirmed without telegramId", { code });
      return response.status(500).json({ ok: false, error: "Invalid confirmed login session" });
    }

    const userResult = await findOrCreateTelegramUser(db, {
      telegramId: session.telegramId,
      telegramChatId: session.telegramChatId || session.telegramId,
      username: session.telegramUsername || null,
      firstName: session.firstName || null,
      lastName: session.lastName || null,
    });
    const token = await adminAuth().createCustomToken(userResult.uid);

    await sessionRef.set({ status: "consumed", consumedAt: new Date().toISOString() }, { merge: true });
    return response.status(200).json({
      ok: true,
      status: "confirmed",
      token,
      isNewUser: userResult.isNewUser,
    });
  } catch (error) {
    console.error("Telegram bot login status failed:", error);
    return response.status(500).json({ ok: false, error: "Could not check Telegram bot login" });
  }
}

async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
