export async function findOrCreateTelegramUser(db, profile) {
  const telegramId = normalizeTelegramId(profile.telegramId);
  if (!telegramId) throw new Error("telegramId is required");

  const now = new Date().toISOString();
  const usersRef = db.collection("users");
  const reservationRef = db.collection("telegramAccountLinks").doc(telegramId);
  const reservation = await reservationRef.get();
  const reservationData = reservation.exists ? (reservation.data() || {}) : {};
  if (reservationData.status === "detached" && !reservationData.uid) {
    const error = new Error("telegram-account-detached");
    error.code = "telegram-account-detached";
    throw error;
  }
  const existing = await usersRef.where("telegramId", "==", telegramId).limit(1).get();

  // Fields safe to refresh on EVERY login. Deliberately excludes firstName/
  // lastName: the user confirms a real name via the post-registration name gate
  // (profileCompleted), and we must not overwrite it with the Telegram nickname
  // on subsequent logins.
  const loginUpdate = {
    telegramChatId: normalizeTelegramId(profile.telegramChatId) || telegramId,
    telegramUsername: profile.username || null,
    lastLogin: now,
  };

  if (!existing.empty) {
    const uid = existing.docs[0].id;
    const data = existing.docs[0].data() || {};
    await usersRef.doc(uid).set({
      ...loginUpdate,
      authProviders: mergeProviders(data.authProviders, data.authProvider, "telegram"),
    }, { merge: true });
    return { uid, isNewUser: false };
  }

  // New user: seed firstName/lastName from Telegram as an initial value only.
  // profileCompleted stays absent, so the client forces a name confirmation.
  const uid = `tg_${telegramId}`;
  await usersRef.doc(uid).set(
    {
      telegramId,
      ...loginUpdate,
      authProvider: "telegram",
      authProviders: ["telegram"],
      firstName: profile.firstName || null,
      lastName: profile.lastName || null,
      role: "reader",
      createdAt: now,
    },
    { merge: true }
  );
  return { uid, isNewUser: true };
}

function mergeProviders(values, primary, added) {
  return [...new Set([
    ...(Array.isArray(values) ? values : []),
    primary,
    added,
  ].filter((value) => ["google.com", "apple.com", "password", "telegram"].includes(value)))];
}

function normalizeTelegramId(value) {
  if (value === null || value === undefined || value === "") return "";
  return String(value);
}
