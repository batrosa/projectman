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
    const mode = session.mode === "link" ? "link" : "login";
    let authenticatedUid = null;
    if (mode === "link") {
      const idToken = String(request.headers?.authorization || "").replace(/^Bearer\s+/i, "");
      if (!idToken) return response.status(401).json({ ok: false, error: "Authentication required" });
      let decoded;
      try {
        decoded = await adminAuth().verifyIdToken(idToken);
      } catch {
        return response.status(401).json({ ok: false, error: "Invalid authentication token" });
      }
      authenticatedUid = decoded.uid;
      if (!session.uid || session.uid !== authenticatedUid) {
        return response.status(403).json({ ok: false, error: "This link session belongs to another user" });
      }
    }

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

    if (mode === "link") {
      const linkResult = await linkTelegramToUser(db, authenticatedUid, session);
      if (!linkResult.ok) {
        await sessionRef.set(
          { status: linkResult.status, failedAt: new Date().toISOString() },
          { merge: true }
        );
        return response.status(409).json(linkResult);
      }

      await sessionRef.set({ status: "consumed", consumedAt: new Date().toISOString() }, { merge: true });
      return response.status(200).json({
        ok: true,
        status: "confirmed",
        linked: true,
        telegramId: session.telegramId,
        telegramChatId: session.telegramChatId || session.telegramId,
        telegramUsername: session.telegramUsername || null,
      });
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

async function linkTelegramToUser(db, uid, session) {
  const usersRef = db.collection("users");
  const telegramId = String(session.telegramId || "");
  const telegramChatId = String(session.telegramChatId || telegramId);
  const targetRef = usersRef.doc(uid);
  const targetDoc = await targetRef.get();
  if (!targetDoc.exists) {
    return { ok: false, status: "user_not_found", error: "User profile was not found" };
  }

  const [telegramOwner, chatOwner] = await Promise.all([
    usersRef.where("telegramId", "==", telegramId).limit(1).get(),
    usersRef.where("telegramChatId", "==", telegramChatId).limit(1).get(),
  ]);
  const conflictingOwner = [telegramOwner, chatOwner]
    .flatMap(snapshot => snapshot.docs || [])
    .find(doc => doc.id !== uid);
  if (conflictingOwner) {
    return {
      ok: false,
      status: "conflict",
      error: "This Telegram account is already linked to another ProjectMan account",
    };
  }

  const now = new Date().toISOString();
  const reservationRef = db.collection("telegramAccountLinks").doc(telegramId);
  try {
    await db.runTransaction(async transaction => {
      const reservation = await transaction.get(reservationRef);
      const ownerUid = reservation.exists ? String(reservation.data()?.uid || "") : "";
      if (ownerUid && ownerUid !== uid) {
        const conflict = new Error("telegram-link-conflict");
        conflict.code = "telegram-link-conflict";
        throw conflict;
      }
      transaction.set(reservationRef, { uid, telegramId, updatedAt: now }, { merge: true });
      transaction.set(targetRef, {
        telegramId,
        telegramChatId,
        telegramUsername: session.telegramUsername || null,
        telegramLinkedAt: now,
      }, { merge: true });
    });
  } catch (error) {
    if (error?.code === "telegram-link-conflict" || error?.message === "telegram-link-conflict") {
      return {
        ok: false,
        status: "conflict",
        error: "This Telegram account is already linked to another ProjectMan account",
      };
    }
    throw error;
  }
  return { ok: true };
}

async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
