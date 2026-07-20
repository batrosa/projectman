function cleanString(value, maxLength = 160) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

export function selectedProviderId(authUser = {}, existing = {}, signInProvider = "") {
  const normalizedSignInProvider = cleanString(signInProvider, 40);
  if (["google.com", "apple.com", "password"].includes(normalizedSignInProvider)) {
    return normalizedSignInProvider;
  }
  if (normalizedSignInProvider === "custom" && existing.telegramId) return "telegram";

  const stored = cleanString(existing.authProvider, 40);
  if (stored) return stored;
  if (existing.telegramId) return "telegram";

  const provider = (authUser.providerData || [])
    .map((item) => cleanString(item?.providerId, 40))
    .find((id) => ["google.com", "apple.com", "password"].includes(id));
  return provider || "";
}

export function buildAuthProfilePatch({ authUser = {}, existing = {}, signInProvider = "" } = {}) {
  const authProvider = selectedProviderId(authUser, existing, signInProvider);
  const patch = {
    emailVerified: authUser.emailVerified === true,
  };
  if (authProvider) patch.authProvider = authProvider;

  const email = cleanString(authUser.email || existing.email, 320).toLowerCase();
  if (email) patch.email = email;

  const photoURL = cleanString(authUser.photoURL, 2048);
  if (photoURL && !existing.profilePhotoUrl) patch.profilePhotoUrl = photoURL;

  // Never overwrite a name the user has already confirmed in ProjectMan.
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
