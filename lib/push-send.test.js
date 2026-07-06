import { describe, it, expect } from "vitest";
import { isDeadTokenError } from "./push-send.js";

// Чистая логика прореживания токенов: мёртвые (устройство удалило приложение,
// токен инвалидирован) — удаляем; временные/конфигурационные ошибки (например,
// APNs-ключ ещё не загружен в Firebase) — токен ОСТАВЛЯЕМ.
describe("isDeadTokenError", () => {
  it("treats unregistered/invalid tokens as dead", () => {
    expect(isDeadTokenError("messaging/registration-token-not-registered")).toBe(true);
    expect(isDeadTokenError("messaging/invalid-registration-token")).toBe(true);
    expect(isDeadTokenError("messaging/invalid-argument")).toBe(true);
  });

  it("keeps tokens on transient/config errors (e.g. APNs not configured yet)", () => {
    expect(isDeadTokenError("messaging/third-party-auth-error")).toBe(false);
    expect(isDeadTokenError("messaging/internal-error")).toBe(false);
    expect(isDeadTokenError("messaging/unavailable")).toBe(false);
    expect(isDeadTokenError(undefined)).toBe(false);
    expect(isDeadTokenError("")).toBe(false);
  });
});
