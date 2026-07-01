// Verifies Telegram Login Widget authentication payloads.
//
// Algorithm per Telegram's documented Login Widget check (archived at
// https://core.telegram.org/widgets/login-legacy since the docs moved to
// the newer OIDC-based flow, but this HMAC scheme is still the one used
// by the classic <script src="https://telegram.org/js/telegram-widget.js">
// login button, which is what this endpoint is built for):
//
//   data-check-string = all received fields except `hash`, sorted
//   alphabetically by key, joined as "key=value" with "\n".
//   secret_key = SHA256(bot_token)
//   expected_hash = HMAC_SHA256(data-check-string, secret_key) as hex
//   valid iff expected_hash === hash (constant-time comparison)
//
// Note: this is NOT the same signing scheme as Telegram Mini Apps'
// `initData` (which HMACs the bot token itself, keyed by a static
// "WebAppData" string, to derive its secret key). Do not conflate them.
import crypto from "node:crypto";

export function verifyTelegramAuth(data, botToken, { maxAgeSeconds = 86400 } = {}) {
  if (!data || typeof data !== "object") return { valid: false, reason: "no_data" };
  const { hash, ...fields } = data;
  if (!hash || typeof hash !== "string") return { valid: false, reason: "missing_hash" };

  const checkString = Object.keys(fields)
    .filter((key) => fields[key] !== undefined && fields[key] !== null)
    .sort()
    .map((key) => `${key}=${fields[key]}`)
    .join("\n");

  const secretKey = crypto.createHash("sha256").update(botToken).digest();
  const computedHash = crypto.createHmac("sha256", secretKey).update(checkString).digest("hex");

  let hashesMatch;
  try {
    hashesMatch = crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(computedHash, "hex"));
  } catch {
    hashesMatch = false; // length mismatch (e.g. non-hex or wrong-length hash) — treat as no match
  }
  if (!hashesMatch) return { valid: false, reason: "hash_mismatch" };

  const authDate = Number(fields.auth_date);
  if (!Number.isFinite(authDate)) return { valid: false, reason: "invalid_auth_date" };
  const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
  if (ageSeconds > maxAgeSeconds || ageSeconds < -60) {
    return { valid: false, reason: "auth_date_expired" };
  }

  if (fields.id === undefined || fields.id === null || String(fields.id).trim() === "") {
    return { valid: false, reason: "missing_id" };
  }

  return { valid: true, telegramId: String(fields.id) };
}
