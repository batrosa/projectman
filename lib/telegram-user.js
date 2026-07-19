export async function findOrCreateTelegramUser(db, profile) {
  const telegramId = normalizeTelegramId(profile.telegramId);
  if (!telegramId) throw new Error("telegramId is required");

  const now = new Date().toISOString();
  const usersRef = db.collection("users");
  const existing = await usersRef.where("telegramId", "==", telegramId).limit(1).get();

  // Fields safe to refresh on EVERY login. Deliberately excludes firstName/
  // lastName: the user confirms a real name via the post-registration name gate
  // (profileCompleted), and we must not overwrite it with the Telegram nickname
  // on subsequent logins.
  const loginUpdate = {
    authProvider: "telegram",
    telegramChatId: normalizeTelegramId(profile.telegramChatId) || telegramId,
    telegramUsername: profile.username || null,
    lastLogin: now,
  };

  if (!existing.empty) {
    const uid = existing.docs[0].id;
    await usersRef.doc(uid).set(loginUpdate, { merge: true });
    return { uid, isNewUser: false };
  }

  // New user: seed firstName/lastName from Telegram as an initial value only.
  // profileCompleted stays absent, so the client forces a name confirmation.
  const uid = `tg_${telegramId}`;
  await usersRef.doc(uid).set(
    {
      telegramId,
      ...loginUpdate,
      firstName: profile.firstName || null,
      lastName: profile.lastName || null,
      role: "reader",
      createdAt: now,
    },
    { merge: true }
  );
  return { uid, isNewUser: true };
}

function normalizeTelegramId(value) {
  if (value === null || value === undefined || value === "") return "";
  return String(value);
}
