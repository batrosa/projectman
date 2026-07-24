import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const state = { db: null, createCustomToken: null, verifyIdToken: null };

vi.mock("../lib/firebase-admin.js", () => ({
  adminDb: () => state.db,
  adminAuth: () => ({
    createCustomToken: state.createCustomToken,
    verifyIdToken: state.verifyIdToken,
  }),
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

function makeFakeDb({ sessions = {}, users = {}, links = {} } = {}) {
  const sessionMap = new Map(Object.entries(sessions));
  const userMap = new Map(Object.entries(users));
  const linkMap = new Map(Object.entries(links));

  return {
    sessions: sessionMap,
    users: userMap,
    links: linkMap,
    collection(name) {
      if (name === "telegramLoginSessions") return makeDocCollection(sessionMap);
      if (name === "users") return makeUsersCollection(userMap);
      if (name === "telegramAccountLinks") return makeDocCollection(linkMap);
      throw new Error(`unexpected collection ${name}`);
    },
    async runTransaction(callback) {
      return callback({
        get: ref => ref.get(),
        set: (ref, data, options) => ref.set(data, options),
      });
    },
  };
}

function makeDocCollection(map) {
  return {
    doc(id) {
      return {
        id,
        async set(data, options) {
          const prior = map.get(id) || {};
          map.set(id, options?.merge ? { ...prior, ...data } : data);
        },
        async get() {
          return { exists: map.has(id), data: () => map.get(id) };
        },
      };
    },
  };
}

function makeUsersCollection(map) {
  return {
    ...makeDocCollection(map),
    where(field, op, value) {
      if (!["telegramId", "telegramChatId"].includes(field) || op !== "==") {
        throw new Error("unexpected users query");
      }
      return {
        limit() {
          return this;
        },
        async get() {
          const match = [...map.entries()].find(([, data]) => data[field] === value);
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
    state.verifyIdToken = vi.fn(async token => {
      if (token !== "valid-token") throw new Error("invalid token");
      return { uid: "web-user" };
    });
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

  it("starts an authenticated link session bound to the current Firebase user", async () => {
    state.db = makeFakeDb({ users: { "web-user": { authProvider: "google.com" } } });
    const res = mockResponse();
    await startHandler({
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
      body: { mode: "link" },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.botUrl).toBe(`https://t.me/projectman_notify_bot?start=link_${res.body.code}`);
    expect(state.db.sessions.get(res.body.code)).toMatchObject({
      status: "pending",
      mode: "link",
      uid: "web-user",
    });
  });

  it("rejects a link session without a valid Firebase ID token", async () => {
    const res = mockResponse();
    await startHandler({ method: "POST", headers: {}, body: { mode: "link" } }, res);
    expect(res.statusCode).toBe(401);
    expect(state.db.sessions.size).toBe(0);
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

  it("confirms /start link_<code> without changing a ProjectSfera user yet", async () => {
    const code = "abcdefghijklmnop";
    state.db = makeFakeDb({
      sessions: {
        [code]: {
          status: "pending",
          mode: "link",
          uid: "web-user",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      },
      users: { "web-user": { authProvider: "google.com" } },
    });

    const res = mockResponse();
    await webhookHandler({
      method: "POST",
      headers: { "x-telegram-bot-api-secret-token": "test-webhook-secret" },
      body: {
        message: {
          text: `/start link_${code}`,
          chat: { id: 991 },
          from: { id: 991, username: "linked_user", first_name: "Link" },
        },
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(state.db.sessions.get(code)).toMatchObject({
      status: "confirmed",
      mode: "link",
      telegramId: "991",
      telegramChatId: "991",
    });
    expect(state.db.users.get("web-user")).toEqual({ authProvider: "google.com" });
    expect(JSON.parse(fetch.mock.calls[0][1].body).text).toContain("Подтверждение получено");
  });

  it("links Telegram to the bound user and preserves the original auth provider", async () => {
    const code = "abcdefghijklmnop";
    state.db = makeFakeDb({
      sessions: {
        [code]: {
          status: "confirmed",
          mode: "link",
          uid: "web-user",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          telegramId: "992",
          telegramChatId: "992",
          telegramUsername: "notify_me",
        },
      },
      users: { "web-user": { authProvider: "google.com", organizationId: "org-1" } },
    });

    const res = mockResponse();
    await statusHandler({
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
      body: { code },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      status: "confirmed",
      linked: true,
      telegramId: "992",
      telegramChatId: "992",
      telegramUsername: "notify_me",
    });
    expect(state.db.users.get("web-user")).toMatchObject({
      authProvider: "google.com",
      organizationId: "org-1",
      telegramId: "992",
      telegramChatId: "992",
      telegramUsername: "notify_me",
    });
    expect(state.db.links.get("992")).toMatchObject({ uid: "web-user" });
    expect(state.db.sessions.get(code)).toMatchObject({ status: "consumed" });
    expect(state.createCustomToken).not.toHaveBeenCalled();
  });

  it("does not let a link session attach Telegram to a different Firebase user", async () => {
    const code = "abcdefghijklmnop";
    state.db = makeFakeDb({
      sessions: {
        [code]: {
          status: "pending",
          mode: "link",
          uid: "another-user",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
        },
      },
    });

    const res = mockResponse();
    await statusHandler({
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
      body: { code },
    }, res);
    expect(res.statusCode).toBe(403);
  });

  it("rejects linking a Telegram account already owned by another user", async () => {
    const code = "abcdefghijklmnop";
    state.db = makeFakeDb({
      sessions: {
        [code]: {
          status: "confirmed",
          mode: "link",
          uid: "web-user",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          telegramId: "993",
          telegramChatId: "993",
        },
      },
      users: {
        "web-user": { authProvider: "password" },
        "telegram-owner": { telegramId: "993", telegramChatId: "993", authProvider: "telegram" },
      },
    });

    const res = mockResponse();
    await statusHandler({
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
      body: { code },
    }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.status).toBe("conflict");
    expect(state.db.users.get("web-user")).toEqual({ authProvider: "password" });
  });

  it("honors the atomic Telegram reservation even if a legacy user query has not caught up", async () => {
    const code = "abcdefghijklmnop";
    state.db = makeFakeDb({
      sessions: {
        [code]: {
          status: "confirmed",
          mode: "link",
          uid: "web-user",
          expiresAt: new Date(Date.now() + 60000).toISOString(),
          telegramId: "994",
          telegramChatId: "994",
        },
      },
      users: { "web-user": { authProvider: "google.com" } },
      links: { "994": { uid: "another-user", telegramId: "994" } },
    });

    const res = mockResponse();
    await statusHandler({
      method: "POST",
      headers: { authorization: "Bearer valid-token" },
      body: { code },
    }, res);
    expect(res.statusCode).toBe(409);
    expect(res.body.status).toBe("conflict");
    expect(state.db.users.get("web-user")).toEqual({ authProvider: "google.com" });
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
