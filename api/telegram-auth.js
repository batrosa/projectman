// Telegram Login Widget endpoint: verifies the signed payload from
// telegram-widget.js, finds or creates the corresponding `users` doc,
// and mints a Firebase custom token for signInWithCustomToken() on the client.
import { verifyTelegramAuth } from "../lib/telegram-auth-verify.js";
import { adminDb, adminAuth } from "../lib/firebase-admin.js";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return response.status(503).json({ error: "Telegram auth is not configured" });

  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return response.status(400).json({ error: "Invalid JSON body" });
  }

  const verification = verifyTelegramAuth(body, botToken);
  if (!verification.valid) {
    return response.status(401).json({ error: "Telegram auth verification failed", reason: verification.reason });
  }

  const telegramId = verification.telegramId;

  let customToken;
  let isNewUser;
  let telegramMessage;
  try {
    const db = adminDb();
    const usersRef = db.collection("users");

    // Query by telegramId (not a deterministic tg_<id> doc lookup) because an
    // admin can pre-link an existing pre-Telegram account by manually setting
    // telegramId on that account's doc before the member's first Telegram
    // login (documented migration path for the email/password -> Telegram
    // cutover, since the widget provides no email to auto-match on). Only
    // brand-new Telegram users get the derived uid = tg_<telegramId>.
    const existing = await usersRef.where("telegramId", "==", telegramId).limit(1).get();

    let uid;
    if (!existing.empty) {
      uid = existing.docs[0].id;
      isNewUser = false;
      await usersRef.doc(uid).set(
        { telegramChatId: telegramId, telegramUsername: body.username || null, lastLogin: new Date().toISOString() },
        { merge: true }
      );
    } else {
      // Deterministic uid for brand-new Telegram users: two concurrent first
      // logins for the same Telegram id both resolve to the same doc path
      // (users/tg_<id>), so Firestore's per-document write serialization
      // prevents a duplicate/second user record rather than relying on
      // application-level locking.
      uid = `tg_${telegramId}`;
      isNewUser = true;
      await usersRef.doc(uid).set(
        {
          telegramId,
          telegramChatId: telegramId,
          telegramUsername: body.username || null,
          firstName: body.first_name || null,
          lastName: body.last_name || null,
          role: "reader",
          createdAt: new Date().toISOString(),
          lastLogin: new Date().toISOString(),
        },
        { merge: true }
      );
    }

    customToken = await adminAuth().createCustomToken(uid);
    telegramMessage = await sendLoginConfirmation(botToken, telegramId);
  } catch (error) {
    console.error("Telegram auth: Firestore/Admin SDK failure:", error);
    return response.status(500).json({ error: "Internal error during authentication" });
  }

  return response.status(200).json({ ok: true, token: customToken, isNewUser, telegramMessage });
}

async function sendLoginConfirmation(botToken, telegramId) {
  try {
    const telegramResponse = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: telegramId,
        text: "✅ Вход в ProjectMan выполнен. Telegram-уведомления подключены.",
      }),
    });

    let telegramBody = null;
    try {
      telegramBody = await telegramResponse.json();
    } catch {
      telegramBody = null;
    }

    if (!telegramResponse.ok || !telegramBody?.ok) {
      const result = {
        ok: false,
        errorCode: telegramBody?.error_code || telegramResponse.status,
        description: telegramBody?.description || telegramResponse.statusText || "Unknown Telegram error",
      };
      console.error("Telegram auth: login confirmation failed:", result);
      return result;
    }

    return { ok: true, messageId: telegramBody.result?.message_id || null };
  } catch (error) {
    const result = { ok: false, error: "Failed to reach Telegram", description: String(error.message || error) };
    console.error("Telegram auth: login confirmation failed:", result);
    return result;
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
