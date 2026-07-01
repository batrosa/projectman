import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "node:crypto";

const BOT_TOKEN = "test-bot-token";

function signPayload(fields) {
  const checkString = Object.keys(fields).sort().map((k) => `${k}=${fields[k]}`).join("\n");
  const secretKey = crypto.createHash("sha256").update(BOT_TOKEN).digest();
  const hash = crypto.createHmac("sha256", secretKey).update(checkString).digest("hex");
  return { ...fields, hash };
}

function mockResponse() {
  const res = {
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
  return res;
}

// In-memory fake Firestore: only implements what api/telegram-auth.js uses.
// Pass `queryError` to make the `.where(...).limit(1).get()` lookup reject,
// simulating a transient Firestore outage.
function makeFakeDb(initialUsers = {}, { queryError } = {}) {
  const users = new Map(Object.entries(initialUsers));
  return {
    users,
    collection(name) {
      if (name !== "users") throw new Error(`unexpected collection ${name}`);
      return {
        where(field, op, value) {
          if (field !== "telegramId" || op !== "==") throw new Error("unexpected query");
          return {
            limit() {
              return this;
            },
            async get() {
              if (queryError) throw queryError;
              const match = [...users.entries()].find(([, data]) => data.telegramId === value);
              return {
                empty: !match,
                docs: match ? [{ id: match[0], data: () => match[1] }] : [],
              };
            },
          };
        },
        doc(id) {
          return {
            async set(data, options) {
              const prior = users.get(id) || {};
              users.set(id, options && options.merge ? { ...prior, ...data } : data);
            },
            async get() {
              return { exists: users.has(id), data: () => users.get(id) };
            },
          };
        },
      };
    },
  };
}

const state = { db: null, createCustomToken: null };

vi.mock("../lib/firebase-admin.js", () => ({
  adminDb: () => state.db,
  adminAuth: () => ({ createCustomToken: state.createCustomToken }),
}));

const { default: handler } = await import("./telegram-auth.js");

describe("POST /api/telegram-auth", () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
    state.db = makeFakeDb();
    state.createCustomToken = vi.fn(async (uid) => `custom-token-for-${uid}`);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects non-POST methods", async () => {
    const res = mockResponse();
    await handler({ method: "GET" }, res);
    expect(res.statusCode).toBe(405);
  });

  it("returns 503 when TELEGRAM_BOT_TOKEN is not configured", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const res = mockResponse();
    await handler({ method: "POST", body: {} }, res);
    expect(res.statusCode).toBe(503);
  });

  it("rejects an invalid signature with 401 and does not mint a token", async () => {
    const payload = signPayload({ id: 111, first_name: "Ivan", auth_date: Math.floor(Date.now() / 1000) });
    payload.first_name = "Tampered";
    const res = mockResponse();
    await handler({ method: "POST", body: payload }, res);
    expect(res.statusCode).toBe(401);
    expect(res.body.reason).toBe("hash_mismatch");
    expect(state.createCustomToken).not.toHaveBeenCalled();
  });

  it("creates a new user doc with role=reader and derived uid on first login", async () => {
    const payload = signPayload({
      id: 222,
      first_name: "Ivan",
      username: "ivanov",
      auth_date: Math.floor(Date.now() / 1000),
    });
    const res = mockResponse();
    await handler({ method: "POST", body: payload }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.token).toBe("custom-token-for-tg_222");
    expect(res.body.telegramMessage).toEqual({ ok: true, messageId: 42 });
    expect(state.createCustomToken).toHaveBeenCalledWith("tg_222");
    expect(fetch).toHaveBeenCalledWith(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      chat_id: "222",
      text: "✅ Вход в ProjectMan выполнен. Telegram-уведомления подключены.",
    });

    const created = state.db.users.get("tg_222");
    expect(created.role).toBe("reader");
    expect(created.telegramId).toBe("222");
    expect(created.telegramChatId).toBe("222");
    expect(created.telegramUsername).toBe("ivanov");
  });

  it("reuses an existing user doc found by telegramId (pre-linked account)", async () => {
    state.db = makeFakeDb({
      "legacy-uid-abc": {
        telegramId: "333",
        role: "reader",
        orgRole: "owner",
        organizationId: "org-1",
      },
    });
    const payload = signPayload({ id: 333, first_name: "Petr", auth_date: Math.floor(Date.now() / 1000) });
    const res = mockResponse();
    await handler({ method: "POST", body: payload }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.isNewUser).toBe(false);
    expect(res.body.token).toBe("custom-token-for-legacy-uid-abc");
    expect(state.createCustomToken).toHaveBeenCalledWith("legacy-uid-abc");

    // Pre-existing org linkage must survive the merge update.
    const updated = state.db.users.get("legacy-uid-abc");
    expect(updated.orgRole).toBe("owner");
    expect(updated.organizationId).toBe("org-1");
  });

  it("rejects a payload with a missing id before ever touching Firestore", async () => {
    const payload = signPayload({ first_name: "NoId", auth_date: Math.floor(Date.now() / 1000) });
    const res = mockResponse();
    await handler({ method: "POST", body: payload }, res);
    expect(res.statusCode).toBe(401);
    expect(state.createCustomToken).not.toHaveBeenCalled();
  });

  it("returns a generic 500 and does not leak details when Firestore rejects", async () => {
    state.db = makeFakeDb({}, { queryError: new Error("UNAVAILABLE: deadline exceeded") });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = signPayload({ id: 444, first_name: "Ivan", auth_date: Math.floor(Date.now() / 1000) });
    const res = mockResponse();
    await handler({ method: "POST", body: payload }, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Internal error during authentication" });
    expect(JSON.stringify(res.body)).not.toContain("deadline exceeded");
    expect(state.createCustomToken).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it("returns a generic 500 when createCustomToken rejects", async () => {
    state.createCustomToken = vi.fn(async () => {
      throw new Error("Admin SDK misconfigured");
    });
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const payload = signPayload({ id: 555, first_name: "Ivan", auth_date: Math.floor(Date.now() / 1000) });
    const res = mockResponse();
    await handler({ method: "POST", body: payload }, res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: "Internal error during authentication" });

    consoleErrorSpy.mockRestore();
  });

  it("keeps login successful but returns details when the Telegram confirmation message fails", async () => {
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
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const payload = signPayload({ id: 666, first_name: "Ivan", auth_date: Math.floor(Date.now() / 1000) });
    const res = mockResponse();
    await handler({ method: "POST", body: payload }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.token).toBe("custom-token-for-tg_666");
    expect(res.body.telegramMessage).toMatchObject({
      ok: false,
      errorCode: 403,
      description: "Forbidden: bot can't initiate conversation with a user",
    });

    consoleErrorSpy.mockRestore();
  });
});
