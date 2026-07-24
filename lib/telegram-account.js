import { FieldValue } from "firebase-admin/firestore";

const NATIVE_PROVIDERS = new Set(["google.com", "apple.com", "password"]);

export function nativeProviderIds(authUser = {}) {
  return [...new Set(
    (authUser.providerData || [])
      .map((item) => String(item?.providerId || ""))
      .filter((provider) => NATIVE_PROVIDERS.has(provider))
  )];
}

export async function findTelegramOwnerUid(db, telegramId) {
  const normalized = String(telegramId || "");
  if (!normalized) return "";
  const reservation = await db.collection("telegramAccountLinks").doc(normalized).get();
  const reservedUid = reservation.exists ? String(reservation.data()?.uid || "") : "";
  if (reservedUid) return reservedUid;
  const owner = await db.collection("users").where("telegramId", "==", normalized).limit(1).get();
  return owner.empty ? "" : owner.docs[0].id;
}

export async function unlinkTelegramForUid({ db, auth, uid, keepDetachedReservation = true }) {
  const userRef = db.collection("users").doc(uid);
  const [userDoc, authUser] = await Promise.all([
    userRef.get(),
    auth.getUser(uid),
  ]);
  if (!userDoc.exists) return { ok: false, status: "user_not_found" };

  const user = userDoc.data() || {};
  const telegramId = String(user.telegramId || user.telegramChatId || "");
  if (!telegramId) return { ok: true, alreadyUnlinked: true, providers: nativeProviderIds(authUser) };

  const providers = nativeProviderIds(authUser);
  if (providers.length === 0) {
    return {
      ok: false,
      status: "last_provider",
      error: "Сначала подключите email, Google или Apple. Иначе после отвязки Telegram вы потеряете доступ к аккаунту.",
    };
  }

  const now = new Date().toISOString();
  const reservationRef = db.collection("telegramAccountLinks").doc(telegramId);
  await db.runTransaction(async (transaction) => {
    const reservation = await transaction.get(reservationRef);
    const reservedUid = reservation.exists ? String(reservation.data()?.uid || "") : "";
    if (reservedUid && reservedUid !== uid) {
      const conflict = new Error("telegram-owner-mismatch");
      conflict.code = "telegram-owner-mismatch";
      throw conflict;
    }
    if (keepDetachedReservation) {
      transaction.set(reservationRef, {
        uid: FieldValue.delete(),
        telegramId,
        status: "detached",
        previousUid: uid,
        detachedAt: now,
        updatedAt: now,
      }, { merge: true });
    } else {
      transaction.delete(reservationRef);
    }
    transaction.set(userRef, {
      telegramId: FieldValue.delete(),
      telegramChatId: FieldValue.delete(),
      telegramUsername: FieldValue.delete(),
      telegramLinkedAt: FieldValue.delete(),
      authProvider: providers[0],
      authProviders: providers,
      updatedAt: now,
    }, { merge: true });
  });
  return { ok: true, telegramId, providers };
}
