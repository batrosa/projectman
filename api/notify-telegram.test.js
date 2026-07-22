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

// In-memory fake Firestore: users lookup (doc + telegramChatId query), the
// users/{uid}/devices subcollection push-send reads (empty), and the
// agentNotifications feed the event path writes into (captured for asserts).
function makeFakeDb(usersById = {}, privateTasksById = {}) {
  const users = new Map(Object.entries(usersById));
  const feed = [];
  return {
    feed,
    collection(name) {
      if (name === "agentNotifications") {
        return {
          async add(doc) {
            feed.push(doc);
            return { id: `note-${feed.length}` };
          },
        };
      }
      if (name === "privateTasks") {
        return {
          doc(id) {
            return {
              async get() {
                return {
                  exists: Object.hasOwn(privateTasksById, id),
                  data: () => privateTasksById[id],
                  ref: { id },
                };
              },
            };
          },
        };
      }
      if (name !== "users") throw new Error(`unexpected collection ${name}`);
      return {
        doc(id) {
          return {
            async get() {
              return { exists: users.has(id), data: () => users.get(id) };
            },
            collection(sub) {
              if (sub !== "devices") throw new Error(`unexpected subcollection ${sub}`);
              return { async get() { return { docs: [] }; } };
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
      [CALLER_UID]: { organizationId: CALLER_ORG, orgRole: "admin" },
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

  it("succeeds without TELEGRAM_BOT_TOKEN — push/feed are delivered, telegram is skipped", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = mockResponse();
    await handler({ method: "POST", headers: AUTH_HEADERS, body: { chatId: "123", text: "hello" } }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, telegram: "skipped" });
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("rejects (403) a caller who has no organization", async () => {
    state.db = makeFakeDb({
      [CALLER_UID]: {},
      recipient_no_org: { telegramChatId: "555" },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = mockResponse();
    await handler({ method: "POST", headers: AUTH_HEADERS, body: { chatId: "555", text: "hello" } }, res);

    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects (403) a no-organization caller even when the recipient has an organization", async () => {
    state.db = makeFakeDb({
      [CALLER_UID]: {},
      recipient_in_org: { organizationId: CALLER_ORG, telegramChatId: "123" },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = mockResponse();
    await handler({ method: "POST", headers: AUTH_HEADERS, body: { chatId: "123", text: "hello" } }, res);

    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
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

  it("rejects (403) notifying a recipient in a DIFFERENT organization (tenant isolation)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = mockResponse();
    await handler({ method: "POST", headers: AUTH_HEADERS, body: { chatId: "999", text: "hello" } }, res);

    expect(res.statusCode).toBe(403);
    expect(res.body).toMatchObject({ ok: false, error: "Recipient is not in your organization" });
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

  // ===== события задач: recipientUid, лента agentNotifications =====

  it("delivers to a recipientUid WITHOUT telegram: feed entry written, 200 ok, no telegram call", async () => {
    state.db = makeFakeDb({
      [CALLER_UID]: { organizationId: CALLER_ORG },
      no_tg_user: { organizationId: CALLER_ORG }, // без telegramChatId
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = mockResponse();
    await handler({
      method: "POST",
      headers: AUTH_HEADERS,
      body: {
        recipientUid: "no_tg_user",
        text: "<b>Новая задача:</b> «Смета»",
        event: { type: "task_created", taskId: "task-1", projectId: "proj-1" },
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, telegram: "no-chat" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.db.feed).toHaveLength(1);
    expect(state.db.feed[0]).toMatchObject({
      uid: "no_tg_user",
      organizationId: CALLER_ORG,
      taskId: "task-1",
      projectId: "proj-1",
      type: "task_created",
      text: "Новая задача: «Смета»", // HTML срезан
      readAt: null,
    });
  });

  it("writes the feed entry AND sends telegram when the uid recipient has a linked chat", async () => {
    state.db = makeFakeDb({
      [CALLER_UID]: { organizationId: CALLER_ORG },
      recipient_in_org: { organizationId: CALLER_ORG, telegramChatId: "123" },
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 7 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const res = mockResponse();
    await handler({
      method: "POST",
      headers: AUTH_HEADERS,
      body: {
        recipientUid: "recipient_in_org",
        text: "Задача принята",
        event: { type: "task_done", taskId: "task-2", projectId: "proj-1" },
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, messageId: 7 });
    expect(state.db.feed).toHaveLength(1);
    expect(state.db.feed[0]).toMatchObject({ uid: "recipient_in_org", type: "task_done" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ chat_id: "123" });
  });

  it("ignores unknown event types (no feed entry) but still delivers", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: 9 } }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const res = mockResponse();
    await handler({
      method: "POST",
      headers: AUTH_HEADERS,
      body: { chatId: "123", text: "hello", event: { type: "hack_everything", taskId: "t" } },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, messageId: 9 });
    expect(state.db.feed).toHaveLength(0);
  });

  it("rejects (403) a recipientUid from a DIFFERENT organization", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const res = mockResponse();
    await handler({
      method: "POST",
      headers: AUTH_HEADERS,
      body: { recipientUid: "recipient_other_org", text: "hello" },
    }, res);

    expect(res.statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.db.feed).toHaveLength(0);
  });

  it("delivers a private-task notification only between authorized viewers", async () => {
    state.db = makeFakeDb({
      [CALLER_UID]: { organizationId: CALLER_ORG, orgRole: "moderator" },
      assignee: { organizationId: CALLER_ORG, orgRole: "employee" },
    }, {
      private_task: {
        organizationId: CALLER_ORG,
        projectId: "proj-1",
        viewerIds: [CALLER_UID, "assignee"],
      },
    });
    delete process.env.TELEGRAM_BOT_TOKEN;
    const res = mockResponse();

    await handler({
      method: "POST",
      headers: AUTH_HEADERS,
      body: {
        recipientUid: "assignee",
        text: "Приватная задача",
        event: {
          type: "task_created",
          taskId: "private_task",
          projectId: "proj-1",
          taskCollection: "privateTasks",
        },
      },
    }, res);

    expect(res.statusCode).toBe(200);
    expect(state.db.feed).toHaveLength(1);
    expect(state.db.feed[0]).toMatchObject({ taskCollection: "privateTasks" });
  });

  it("rejects a private-task notification to an unrelated admin", async () => {
    state.db = makeFakeDb({
      [CALLER_UID]: { organizationId: CALLER_ORG, orgRole: "owner" },
      unrelated_admin: { organizationId: CALLER_ORG, orgRole: "admin" },
    }, {
      private_task: {
        organizationId: CALLER_ORG,
        projectId: "proj-1",
        viewerIds: ["creator", "assignee"],
      },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const res = mockResponse();

    await handler({
      method: "POST",
      headers: AUTH_HEADERS,
      body: {
        recipientUid: "unrelated_admin",
        text: "Не должно уйти",
        event: {
          type: "task_created",
          taskId: "private_task",
          projectId: "proj-1",
          taskCollection: "privateTasks",
        },
      },
    }, res);

    expect(res.statusCode).toBe(403);
    expect(state.db.feed).toHaveLength(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
