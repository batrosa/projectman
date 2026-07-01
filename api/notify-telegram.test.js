import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import handler from "./notify-telegram.js";

function mockResponse() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(key, value) {
      this.headers[key] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

describe("POST /api/notify-telegram", () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("rejects non-POST methods", async () => {
    const res = mockResponse();
    await handler({ method: "GET" }, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("POST");
  });

  it("returns 503 when TELEGRAM_BOT_TOKEN is not configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const res = mockResponse();
    await handler({ method: "POST", body: { chatId: "1", text: "hello" } }, res);
    expect(res.statusCode).toBe(503);
  });

  it("validates required fields before calling Telegram", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = mockResponse();
    await handler({ method: "POST", body: { chatId: "", text: "" } }, res);

    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns Telegram error details when sendMessage is rejected", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({
        ok: false,
        error_code: 403,
        description: "Forbidden: bot can't initiate conversation with a user",
      }),
    })));

    const res = mockResponse();
    await handler({ method: "POST", body: { chatId: "123", text: "hello" } }, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({
      ok: false,
      error: "Telegram send failed",
      errorCode: 403,
      description: "Forbidden: bot can't initiate conversation with a user",
    });
  });

  it("returns the Telegram message id on success", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const res = mockResponse();
    await handler({ method: "POST", body: { chatId: "123", text: "hello", parseMode: "HTML" } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, messageId: 42 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      chat_id: "123",
      text: "hello",
      parse_mode: "HTML",
    });
  });
});
