import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

function mockResponse() {
  return {
    statusCode: null,
    headers: {},
    body: null,
    setHeader(key, value) { this.headers[key] = value; },
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

// In-memory fake Firestore implementing only what api/agent-monitor.js uses:
// tasks where(status==in-progress).limit().get(); projects/users doc get;
// agentNotifications doc() refs; db.batch() set/update/commit.
function makeFakeDb({ tasks = {}, projects = {}, users = {} }) {
  const notes = [];            // committed agentNotifications payloads
  const taskUpdates = {};      // taskId -> merged flag updates
  const state = { notes, taskUpdates };

  function taskRef(id) {
    return { __kind: "task", id };
  }

  const db = {
    collection(name) {
      if (name === "tasks") {
        return {
          where(field, op, value) {
            if (field !== "status" || op !== "==" || value !== "in-progress") throw new Error("unexpected tasks query");
            return {
              limit() { return this; },
              async get() {
                return {
                  docs: Object.entries(tasks).map(([id, data]) => ({
                    id,
                    data: () => data,
                    ref: taskRef(id),
                  })),
                };
              },
            };
          },
          doc(id) { return taskRef(id); },
        };
      }
      if (name === "projects") {
        return {
          doc(id) {
            return {
              async get() {
                return { exists: id in projects, data: () => projects[id] };
              },
            };
          },
        };
      }
      if (name === "users") {
        return {
          doc(id) {
            return {
              async get() {
                return { exists: id in users, data: () => users[id] };
              },
            };
          },
          where(field, op, value) {
            if (field !== "email" || op !== "==") throw new Error("unexpected users query");
            return {
              limit() { return this; },
              async get() {
                const hit = Object.entries(users).find(([, u]) => (u.email || "").toLowerCase() === value);
                return { empty: !hit, docs: hit ? [{ id: hit[0], data: () => hit[1] }] : [] };
              },
            };
          },
        };
      }
      if (name === "agentNotifications") {
        return {
          doc() { return { __kind: "note", id: `n${notes.length + Math.random()}` }; },
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
    batch() {
      const ops = [];
      return {
        set(ref, data) { ops.push({ op: "set", ref, data }); },
        update(ref, data) { ops.push({ op: "update", ref, data }); },
        async commit() {
          for (const o of ops) {
            if (o.ref.__kind === "note" && o.op === "set") notes.push(o.data);
            if (o.ref.__kind === "task" && o.op === "update") {
              taskUpdates[o.ref.id] = { ...(taskUpdates[o.ref.id] || {}), ...o.data };
            }
          }
        },
      };
    },
  };
  return { db, state };
}

const holder = { db: null };
const telegramCalls = [];

vi.mock("../lib/firebase-admin.js", () => ({
  adminDb: () => holder.db,
  adminAuth: () => ({}),
}));
vi.mock("../lib/telegram-send.js", () => ({
  sendTelegramMessage: vi.fn(async (chatId, text) => {
    telegramCalls.push({ chatId, text });
    return { ok: true, messageId: 1 };
  }),
}));
// FieldValue.serverTimestamp is a sentinel here — the fake just stores it.
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "__server_ts__" },
}));

const { default: handler } = await import("./agent-monitor.js");

// 2026-07-03 09:00 МСК
const NOW = new Date("2026-07-03T06:00:00Z");

function makeRequest(overrides = {}) {
  return {
    method: "POST",
    headers: { authorization: "Bearer sekret" },
    ...overrides,
  };
}

describe("POST /api/agent-monitor", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "sekret";
    telegramCalls.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CRON_SECRET;
  });

  it("405 on GET", async () => {
    const res = mockResponse();
    await handler(makeRequest({ method: "GET" }), res);
    expect(res.statusCode).toBe(405);
  });

  it("401 without/with wrong secret, and 401 when CRON_SECRET env is missing (fail closed)", async () => {
    holder.db = makeFakeDb({}).db;
    let res = mockResponse();
    await handler(makeRequest({ headers: {} }), res);
    expect(res.statusCode).toBe(401);

    res = mockResponse();
    await handler(makeRequest({ headers: { authorization: "Bearer wrong" } }), res);
    expect(res.statusCode).toBe(401);

    delete process.env.CRON_SECRET;
    res = mockResponse();
    await handler(makeRequest(), res);
    expect(res.statusCode).toBe(401);
  });

  it("overdue task → notes for assignee AND creator, telegram to both, daily flag stamped; fresh task untouched", async () => {
    const fake = makeFakeDb({
      tasks: {
        "t-over": {
          status: "in-progress", subStatus: "in_work", title: "Смета",
          deadline: "2026-07-01", projectId: "p1", organizationId: "org-1",
          assigneeIds: ["u-assignee"], createdByUid: "u-creator",
        },
        "t-fresh": {
          status: "in-progress", subStatus: "in_work", title: "Новая",
          deadline: "2026-08-01", projectId: "p1", organizationId: "org-1",
          assigneeIds: ["u-assignee"], createdByUid: "u-creator",
        },
      },
      projects: { p1: { name: "Лазурный берег", organizationId: "org-1" } },
      users: {
        "u-assignee": { telegramChatId: "111", organizationId: "org-1" },
        "u-creator": { telegramChatId: "222", organizationId: "org-1" },
      },
    });
    holder.db = fake.db;

    const res = mockResponse();
    await handler(makeRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.scanned).toBe(2);
    expect(res.body.events).toBe(1);

    // Two feed entries (assignee + creator), correct shape.
    expect(fake.state.notes).toHaveLength(2);
    const uids = fake.state.notes.map((n) => n.uid).sort();
    expect(uids).toEqual(["u-assignee", "u-creator"]);
    for (const n of fake.state.notes) {
      expect(n.type).toBe("overdue");
      expect(n.taskId).toBe("t-over");
      expect(n.projectId).toBe("p1");
      expect(n.organizationId).toBe("org-1");
      expect(n.text).toContain("Смета");
      expect(n.text).toContain("Лазурный берег");
      expect(n.readAt).toBe(null);
    }

    // Daily anti-spam stamp with today's MSK date; fresh task got no updates.
    expect(fake.state.taskUpdates["t-over"].notifiedOverdueOn).toBe("2026-07-03");
    expect(fake.state.taskUpdates["t-fresh"]).toBeUndefined();

    // Telegram duplicated to both linked recipients.
    const chats = telegramCalls.map((c) => c.chatId).sort();
    expect(chats).toEqual(["111", "222"]);
  });

  it("same-day rerun is a no-op (notifiedOverdueOn == today) — no duplicate spam", async () => {
    const fake = makeFakeDb({
      tasks: {
        "t-over": {
          status: "in-progress", subStatus: "in_work", title: "Смета",
          deadline: "2026-07-01", projectId: "p1", organizationId: "org-1",
          assigneeIds: ["u-assignee"], createdByUid: "u-creator",
          notifiedOverdueOn: "2026-07-03",
        },
      },
      projects: { p1: { name: "П", organizationId: "org-1" } },
      users: { "u-assignee": { telegramChatId: "111" }, "u-creator": {} },
    });
    holder.db = fake.db;

    const res = mockResponse();
    await handler(makeRequest(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.events).toBe(0);
    expect(fake.state.notes).toHaveLength(0);
    expect(telegramCalls).toHaveLength(0);
  });

  it("recipient without telegramChatId still gets a feed entry, just no telegram", async () => {
    const fake = makeFakeDb({
      tasks: {
        "t-not-taken": {
          status: "in-progress", subStatus: "assigned", title: "Взять",
          deadline: "2026-08-01", projectId: "p1", organizationId: "org-1",
          assigneeIds: ["u-nochat"], createdByUid: "u-nochat",
          createdAt: new Date(NOW.getTime() - 2 * 3600_000).toISOString(),
        },
      },
      projects: { p1: { name: "П", organizationId: "org-1" } },
      users: { "u-nochat": { organizationId: "org-1" } },
    });
    holder.db = fake.db;

    const res = mockResponse();
    await handler(makeRequest(), res);
    expect(res.body.events).toBe(1);
    // Creator == assignee → deduped to ONE feed entry.
    expect(fake.state.notes).toHaveLength(1);
    expect(fake.state.notes[0].type).toBe("not_taken_1h");
    expect(fake.state.taskUpdates["t-not-taken"].notifiedNotTakenAt).toBe("__server_ts__");
    expect(telegramCalls).toHaveLength(0);
  });
});
