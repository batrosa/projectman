import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import { verifyTelegramAuth } from "./telegram-auth-verify.js";

const BOT_TOKEN = "test-bot-token";

function signPayload(fields) {
  const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secretKey = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(checkString).digest("hex");
  return { ...fields, hash };
}

describe("verifyTelegramAuth", () => {
  it("accepts a correctly signed, fresh payload", () => {
    const payload = signPayload({ id: 12345, first_name: "Ivan", auth_date: Math.floor(Date.now() / 1000) });
    const result = verifyTelegramAuth(payload, BOT_TOKEN);
    expect(result.valid).toBe(true);
    expect(result.telegramId).toBe("12345");
  });

  it("rejects a tampered payload", () => {
    const payload = signPayload({ id: 12345, first_name: "Ivan", auth_date: Math.floor(Date.now() / 1000) });
    payload.first_name = "Hacker";
    const result = verifyTelegramAuth(payload, BOT_TOKEN);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("hash_mismatch");
  });

  it("rejects a stale auth_date (replay)", () => {
    const payload = signPayload({ id: 12345, first_name: "Ivan", auth_date: Math.floor(Date.now() / 1000) - 90000 });
    const result = verifyTelegramAuth(payload, BOT_TOKEN);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("auth_date_expired");
  });
});
