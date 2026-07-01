import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

// In-memory fake Firestore: only implements what api/notify-telegram.js
// uses — a doc lookup for the caller's user record, and a
// where('telegramChatId', '==', ...).limit(1).get() query for the recipient.
function makeFakeDb(usersById = {}) {
  const users = new Map(Object.entries(usersById));
  return {
    collection(name) {
      if (name !== "users") throw new Error(`unexpected collection ${name}`);
      return {
        doc(id) {
          return {
            async get() {
              return { exists: users.has(id), data: () => users.get(id) };
            },
          };
        },
        where(field, op, value) {
          if (field !== "telegramChatId" || op !== "==") throw new Error("unexpected query");
          return {
            limit() {
              return this;
            },
            async get() {
              const match = [...users.entries()].find(([, data]) => data.telegramChatId === value);
              return {
                empty: !match,
                docs: match ? [{ id: match[0], data: () => match[1] }] : [],
              };
            },
          };
        },
      };
    },
  };
}

const state = { db: null, verifyIdToken: null };

vi.mock("../lib/firebase-admin.js", () => ({
  adminDb: () => state.db,
  adminAuth: () => ({ verifyIdToken: state.verifyIdToken }),
}));

const { default: handler } = await import("./notify-telegram.js");

const CALLER_UID = "tg_1001";
const CALLER_ORG = "org-a";
const AUTH_HEADERS = { authorization: "Bearer valid-token" };

describe("POST /api/notify-telegram", () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    state.verifyIdToken = vi.fn(async (token) => {
      if (token !== "valid-token") throw new Error("invalid token");
      return { uid: CALLER_UID };
    });
    state.db = makeFakeDb({
      [CALLER_UID]: { organizationId: CALLER_ORG },
      recipient_in_org: { organizationId: CALLER_ORG, telegramChatId: "123" },
      recipient_other_org: { organizationId: "org-b", telegramChatId: "999" },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  it("rejects non-POST methods", async () => {
    const res = mockResponse();
    await handler({ method: "GET", headers: {} }, res);
    expect(res.statusCode).toBe(405);
    expect(res.headers.Allow).toBe("POST");
  });

  it("returns 503 when TELEGRAM_BOT_TOKEN is not configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const res = mockResponse();
    await handler({ method: "POST", headers: {}, body: { chatId: "1", text: "hello" } }, res);
    expect(res.statusCode).toBe(503);
  });

  it("returns 401 when no bearer token is provided", async () => {
    const res = mockResponse();
    await handler({ method: "POST", headers: {}, body: { chatId: "123", text: "hello" } }, res);
    expect(res.statusCode).toBe(401);
  });

  it("returns 401 when the bearer token fails verification", async () => {
    const res = mockResponse();
    await handler(
      { method: "POST", headers: { authorization: "Bearer bad-token" }, body: { chatId: "123", text: "hello" } },
      res
    );
    expect(res.statusCode).toBe(401);
  });

  it("returns 403 when the caller user doc does not exist", async () => {
    state.db = makeFakeDb({});
    const res = mockResponse();
    await handler({ method: "POST", headers: AUTH_HEADERS, body: { chatId: "123", text: "hello" } }, res);
    expect(res.statusCode).toBe(403);
  });

  it("allows a legacy caller with no organization to notify a legacy recipient with no organization (self-assignment, pre-org accounts)", async () => {
    state.db = makeFakeDb({
      [CALLER_UID]: {},
      recipient_no_org: { telegramChatId: "555" },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 7 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const res = mockResponse();
    await handler({ method: "POST", headers: AUTH_HEADERS, body: { chatId: "555", text: "hello" } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, messageId: 7 });
  });

  it("allows a no-organization caller to notify a recipient who belongs to an organization (org membership not required)", async () => {
    state.db = makeFakeDb({
      [CALLER_UID]: {},
      recipient_in_org: { organizationId: CALLER_ORG, telegramChatId: "123" },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 5 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const res = mockResponse();
    await handler({ method: "POST", headers: AUTH_HEADERS, body: { chatId: "123", text: "hello" } }, res);

    expect(res.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("validates required fields before calling Telegram", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = mockResponse();
    await handler({ method: "POST", headers: AUTH_HEADERS, body: { chatId: "", text: "" } }, res);

    expect(res.statusCode).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects (403) when the target chatId does not belong to any known user (anti-open-relay)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = mockResponse();
    await handler(
      { method: "POST", headers: AUTH_HEADERS, body: { chatId: "does-not-exist", text: "hello" } },
      res
    );

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: "Unknown recipient" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows notifying a recipient in a different organization (org membership no longer required)", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 9 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const res = mockResponse();
    await handler({ method: "POST", headers: AUTH_HEADERS, body: { chatId: "999", text: "hello" } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, messageId: 9 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    await handler({ method: "POST", headers: AUTH_HEADERS, body: { chatId: "123", text: "hello" } }, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({
      ok: false,
      error: "Telegram send failed",
      errorCode: 403,
      description: "Forbidden: bot can't initiate conversation with a user",
    });
  });

  it("returns the Telegram message id on success for a recipient in the caller's org", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const res = mockResponse();
    await handler(
      { method: "POST", headers: AUTH_HEADERS, body: { chatId: "123", text: "hello", parseMode: "HTML" } },
      res
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, messageId: 42 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      chat_id: "123",
      text: "hello",
      parse_mode: "HTML",
    });
  });
});
