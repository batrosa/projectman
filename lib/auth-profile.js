function cleanString(value, maxLength = 160) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function selectedProviderId(authUser = {}, existing = {}, signInProvider = "") {
  const normalizedSignInProvider = cleanString(signInProvider, 40);
  const firebaseProviders = (authUser.providerData || [])
    .map((item) => cleanString(item?.providerId, 40))
    .filter((id) => ["google.com", "apple.com", "password"].includes(id));
  if (firebaseProviders.includes(normalizedSignInProvider)) return normalizedSignInProvider;

  // Firebase Auth is the source of truth for native providers. A historical
  // Firestore authProvider value may be stale (Telegram linking used to
  // overwrite "password"), so it must never override providerData.
  const stored = cleanString(existing.authProvider, 40);
  if (firebaseProviders.includes(stored)) return stored;
  if (firebaseProviders.length > 0) return firebaseProviders[0];

  if (normalizedSignInProvider === "custom" && existing.telegramId) return "telegram";
  if (existing.telegramId) return "telegram";
  if (["google.com", "apple.com", "password"].includes(normalizedSignInProvider)) {
    return normalizedSignInProvider;
  }
  return ["google.com", "apple.com", "password", "telegram"].includes(stored) ? stored : "";
}

export function linkedProviderIds(authUser = {}, existing = {}, signInProvider = "") {
  const providers = new Set(
    (authUser.providerData || [])
      .map((item) => cleanString(item?.providerId, 40))
      .filter((id) => ["google.com", "apple.com", "password"].includes(id))
  );
  const normalizedSignInProvider = cleanString(signInProvider, 40);
  if (providers.size === 0 && ["google.com", "apple.com", "password"].includes(normalizedSignInProvider)) {
    providers.add(normalizedSignInProvider);
  }
  if (existing.telegramId || existing.telegramChatId || normalizedSignInProvider === "custom") {
    providers.add("telegram");
  }
  if (providers.size === 0) {
    const stored = cleanString(existing.authProvider, 40);
    if (["google.com", "apple.com", "password", "telegram"].includes(stored)) providers.add(stored);
  }
  return [...providers];
}

export function buildAuthProfilePatch({ authUser = {}, existing = {}, signInProvider = "" } = {}) {
  const authProvider = selectedProviderId(authUser, existing, signInProvider);
  const authProviders = linkedProviderIds(authUser, existing, signInProvider);
  const patch = {
    emailVerified: authUser.emailVerified === true,
    authProviders,
  };
  if (authProvider) patch.authProvider = authProvider;

  const email = cleanString(authUser.email || existing.email, 320).toLowerCase();
  if (email) patch.email = email;

  const photoURL = cleanString(authUser.photoURL, 2048);
  if (photoURL && !existing.profilePhotoUrl) patch.profilePhotoUrl = photoURL;

  // Profiles created before the one-time name gate already contain a real
  // first/last name but do not have the newer profileCompleted marker. Treat
  // those records as complete during bootstrap so existing users are not
  // asked to enter the same name again.
  const existingFirstName = cleanString(existing.firstName, 40);
  const existingLastName = cleanString(existing.lastName, 40);
  if (existing.profileCompleted !== true
      && existingFirstName.length >= 2
      && existingLastName.length >= 2) {
    patch.profileCompleted = true;
  }

  // Never overwrite a name the user has already confirmed in ProjectSfera.
  if (existing.profileCompleted !== true) {
    const displayName = cleanString(authUser.displayName, 120);
    if (displayName && !existing.displayName) patch.displayName = displayName;
    if (displayName && !existing.firstName && !existing.lastName) {
      const parts = displayName.split(/\s+/).filter(Boolean);
      if (parts[0]) patch.firstName = parts[0].slice(0, 40);
      if (parts.length > 1) patch.lastName = parts.slice(1).join(" ").slice(0, 40);
    }
  }

  if (!existing.role) patch.role = "reader";
  return patch;
}
