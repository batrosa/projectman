import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = { db: null, createCustomToken: null };

vi.mock("../lib/firebase-admin.js", () => ({
  adminDb: () => state.db,
  adminAuth: () => ({ createCustomToken: state.createCustomToken }),
}));

const { default: startHandler } = await import("./telegram-bot-login-start.js");
const { default: statusHandler } = await import("./telegram-bot-login-status.js");
const { default: webhookHandler } = await import("./webhook.js");

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
    send(payload) {
      this.body = payload;
      return this;
    },
    end() {
      return this;
    },
  };
}

function makeFakeDb({ sessions = {}, users = {} } = {}) {
  const sessionMap = new Map(Object.entries(sessions));
  const userMap = new Map(Object.entries(users));

  return {
    sessions: sessionMap,
    users: userMap,
    collection(name) {
      if (name === "telegramLoginSessions") return makeDocCollection(sessionMap);
      if (name === "users") return makeUsersCollection(userMap);
      throw new Error(`unexpected collection ${name}`);
    },
  };
}

function makeDocCollection(map) {
  return {
    doc(id) {
      return {
        async set(data, options) {
          const prior = map.get(id) || {};
          map.set(id, options?.merge ? { ...prior, ...data } : data);
        },
        async get() {
          return { exists: map.has(id), data: () => map.get(id) };
        },
        async delete() {
          map.delete(id);
        },
      };
    },
  };
}

function makeUsersCollection(map) {
  return {
    ...makeDocCollection(map),
    where(field, op, value) {
      if (field !== "telegramId" || op !== "==") throw new Error("unexpected users query");
      return {
        limit() {
          return this;
        },
        async get() {
          const match = [...map.entries()].find(([, data]) => data.telegramId === value);
          return {
            empty: !match,
            docs: match ? [{ id: match[0], data: () => match[1] }] : [],
          };
        },
      };
    },
  };
}

describe("Telegram bot login flow", () => {
  beforeEach(() => {
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.TELEGRAM_BOT_USERNAME = "@projectman_notify_bot";
    process.env.TELEGRAM_WEBHOOK_SECRET = "test-webhook-secret";
    state.db = makeFakeDb();
    state.createCustomToken = vi.fn(async (uid) => `custom-token-for-${uid}`);
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true }),
      text: async () => "",
    })));
  });

  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_USERNAME;
    delete process.env.TELEGRAM_WEBHOOK_SECRET;
    vi.unstubAllGlobals();
  });

  it("starts a pending session and returns a deep link to the bot", async () => {
    const res = mockResponse();
    await startHandler({ method: "POST" }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.code).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(res.body.botUrl).toBe(`https://t.me/projectman_notify_bot?start=login_${res.body.code}`);
    expect(state.db.sessions.get(res.body.code)).toMatchObject({ status: "pending" });
  });

  it("returns pending until Telegram webhook confirms the session", async () => {
    const code = "abcdefghijklmnop";
    state.db = makeFakeDb({
      sessions: {
        [code]: { status: "pending", expiresAt: new Date(Date.now() + 60000).toISOString() },
      },
    });

    const res = mockResponse();
    await statusHandler({ method: "POST", body: { code } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: "pending" });
    expect(state.createCustomToken).not.toHaveBeenCalled();
  });

  it("confirms a pending session from /start login_<code> in the bot webhook", async () => {
    const code = "abcdefghijklmnop";
    state.db = makeFakeDb({
      sessions: {
        [code]: { status: "pending", expiresAt: new Date(Date.now() + 60000).toISOString() },
      },
    });

    const res = mockResponse();
    await webhookHandler({
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
      body: {
        message: {
          text: `/start login_${code}`,
          chat: { id: 777 },
          from: { id: 777, username: "ivanov", first_name: "Ivan", last_name: "Petrov" },
        },
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(state.db.sessions.get(code)).toMatchObject({
      status: "confirmed",
      telegramId: "777",
      telegramChatId: "777",
      telegramUsername: "ivanov",
      firstName: "Ivan",
      lastName: "Petrov",
    });
    const telegramMessage = JSON.parse(fetch.mock.calls[0][1].body);
    expect(telegramMessage.chat_id).toBe(777);
    expect(telegramMessage.text).toContain("Вход подтвержден");
  });

  it("rejects bot-login webhook spoofing when the secret header is missing", async () => {
    const code = "abcdefghijklmnop";
    state.db = makeFakeDb({
      sessions: {
        [code]: { status: "pending", expiresAt: new Date(Date.now() + 60000).toISOString() },
      },
    });

    const res = mockResponse();
    await webhookHandler({
      method: "POST",
      headers: {},
      body: {
        message: {
          text: `/start login_${code}`,
          chat: { id: 777 },
          from: { id: 777, username: "ivanov", first_name: "Ivan" },
        },
      },
    }, res);

    expect(res.statusCode).toBe(401);
    expect(state.db.sessions.get(code)).toMatchObject({ status: "pending" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sets the Telegram webhook through the protected setup path", async () => {
    const res = mockResponse();
    await webhookHandler({
      method: "POST",
      query: { setup: "telegram" },
      headers: { "x-setup-secret": "test-webhook-secret" },
      body: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(fetch).toHaveBeenCalledWith("https://api.telegram.org/bottest-token/setWebhook", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }));
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      url: "https://projectmanteko.vercel.app/api/webhook",
      secret_token: "test-webhook-secret",
      allowed_updates: ["message"],
    });
  });

  it("cleans up the fixed production smoke-test user through the protected setup path", async () => {
    state.db = makeFakeDb({
      users: {
        "tg_123456789": { telegramId: "123456789", firstName: "Codex" },
      },
    });

    const res = mockResponse();
    await webhookHandler({
      method: "POST",
      query: { setup: "cleanup-test-user" },
      headers: { "x-setup-secret": "test-webhook-secret" },
      body: {},
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true });
    expect(state.db.users.has("tg_123456789")).toBe(false);
  });

  it("mints a Firebase custom token after webhook confirmation and consumes the session", async () => {
    const code = "abcdefghijklmnop";
    state.db = makeFakeDb({
      sessions: {
        [code]: {
          status: "confirmed",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          telegramId: "888",
          telegramChatId: "888",
          telegramUsername: "petr",
          firstName: "Petr",
        },
      },
    });

    const res = mockResponse();
    await statusHandler({ method: "POST", body: { code } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      status: "confirmed",
      token: "custom-token-for-tg_888",
      isNewUser: true,
    });
    expect(state.db.users.get("tg_888")).toMatchObject({
      telegramId: "888",
      telegramChatId: "888",
      telegramUsername: "petr",
      role: "reader",
    });
    expect(state.db.sessions.get(code)).toMatchObject({ status: "consumed" });
  });

  it("expires stale sessions before minting a token", async () => {
    const code = "abcdefghijklmnop";
    state.db = makeFakeDb({
      sessions: {
        [code]: { status: "pending", expiresAt: new Date(Date.now() - 1000).toISOString() },
      },
    });

    const res = mockResponse();
    await statusHandler({ method: "POST", body: { code } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: false, status: "expired" });
    expect(state.db.sessions.get(code)).toMatchObject({ status: "expired" });
    expect(state.createCustomToken).not.toHaveBeenCalled();
  });
});
