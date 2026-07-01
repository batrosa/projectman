export async function findOrCreateTelegramUser(db, profile) {
  const telegramId = normalizeTelegramId(profile.telegramId);
  if (!telegramId) throw new Error("telegramId is required");

  const now = new Date().toISOString();
  const usersRef = db.collection("users");
  const existing = await usersRef.where("telegramId", "==", telegramId).limit(1).get();
  const update = {
    telegramChatId: normalizeTelegramId(profile.telegramChatId) || telegramId,
    telegramUsername: profile.username || null,
    firstName: profile.firstName || null,
    lastName: profile.lastName || null,
    lastLogin: now,
  };

  if (!existing.empty) {
    const uid = existing.docs[0].id;
    await usersRef.doc(uid).set(update, { merge: true });
    return { uid, isNewUser: false };
  }

  const uid = `tg_${telegramId}`;
  await usersRef.doc(uid).set(
    {
      telegramId,
      ...update,
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
