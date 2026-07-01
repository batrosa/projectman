import crypto from "node:crypto";

export const TELEGRAM_LOGIN_SESSION_COLLECTION = "telegramLoginSessions";
export const TELEGRAM_LOGIN_TTL_MS = 5 * 60 * 1000;
export const TELEGRAM_LOGIN_CODE_RE = /^[A-Za-z0-9_-]{16,64}$/;

export function createTelegramLoginCode() {
  return crypto
    .randomBytes(18)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function isValidTelegramLoginCode(code) {
  return typeof code === "string" && TELEGRAM_LOGIN_CODE_RE.test(code);
}

export function telegramBotUsername() {
  return (process.env.TELEGRAM_BOT_USERNAME || "projectman_notify_bot").replace(/^@/, "");
}
