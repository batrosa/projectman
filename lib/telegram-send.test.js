import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendTelegramMessage } from "./telegram-send.js";

describe("sendTelegramMessage", () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "TOKEN123";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("POSTs chat_id/text to the bot sendMessage endpoint and returns ok + messageId", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 77 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await sendTelegramMessage("42", "привет");
    expect(res).toEqual({ ok: true, messageId: 77 });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botTOKEN123/sendMessage");
    expect(opts.method).toBe("POST");
    expect(JSON.parse(opts.body)).toEqual({ chat_id: "42", text: "привет" });
  });

  it("adds parse_mode only when given and truncates text to 3900 chars", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: {} }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    await sendTelegramMessage("42", "x".repeat(5000), { parseMode: "HTML" });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.parse_mode).toBe("HTML");
    expect(sent.text.length).toBe(3900);
  });

  it("maps a Telegram API error to ok:false with errorCode/description/httpOk", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      json: async () => ({ ok: false, error_code: 403, description: "bot was blocked by the user" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await sendTelegramMessage("42", "x");
    expect(res.ok).toBe(false);
    expect(res.httpOk).toBe(false);
    expect(res.httpStatus).toBe(403);
    expect(res.errorCode).toBe(403);
    expect(res.description).toBe("bot was blocked by the user");
    expect(res.transport).toBeUndefined();
  });

  it("HTTP 200 but body ok:false → ok:false with httpOk:true (upstream logical failure)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ ok: false, error_code: 400, description: "chat not found" }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await sendTelegramMessage("42", "x");
    expect(res.ok).toBe(false);
    expect(res.httpOk).toBe(true);
    expect(res.errorCode).toBe(400);
  });

  it("aborts a HUNG Telegram request via its own timeout (cron sweep must not stall)", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((url, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      }));
      vi.stubGlobal("fetch", fetchMock);

      const pending = sendTelegramMessage("42", "x");
      await vi.advanceTimersByTimeAsync(9000); // past the 8s internal timeout
      const res = await pending;
      expect(res.ok).toBe(false);
      expect(res.transport).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never throws: missing token / missing args / network failure → ok:false", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect((await sendTelegramMessage("42", "x")).ok).toBe(false);

    process.env.TELEGRAM_BOT_TOKEN = "T";
    expect((await sendTelegramMessage("", "x")).ok).toBe(false);
    expect((await sendTelegramMessage("42", "")).ok).toBe(false);

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("net down"); }));
    const res = await sendTelegramMessage("42", "x");
    expect(res.ok).toBe(false);
    expect(res.transport).toBe(true);
  });
});
