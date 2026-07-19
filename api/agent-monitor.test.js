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
// agentNotifications doc() refs; runTransaction set/update.
function makeFakeDb({ tasks = {}, projects = {}, users = {}, hooks = {} }) {
  const notes = [];            // committed agentNotifications payloads (+__noteId)
  const taskUpdates = {};      // taskId -> merged flag updates
  const noteUpdates = {};      // noteId -> post-send delivery marks
  const state = { notes, taskUpdates, noteUpdates, emailQueries: 0 };
  let noteSeq = 0;

  function taskRef(id) {
    return { __kind: "task", id };
  }

  const db = {
    collection(name) {
      if (name === "tasks") {
        return {
          where(field, op, value) {
            if (field !== "status" || op !== "==" || value !== "in-progress") throw new Error("unexpected tasks query");
            // Paginated sweep chain: orderBy/limit are no-ops here, startAfter
            // marks the second page — the fake returns everything on page one,
            // so the pagination loop must see an empty follow-up page.
            const chain = {
              afterCursor: false,
              orderBy() { return this; },
              limit() { return this; },
              startAfter() { this.afterCursor = true; return this; },
              async get() {
                if (this.afterCursor) return { docs: [] };
                return {
                  docs: Object.entries(tasks).map(([id, data]) => ({
                    id,
                    data: () => data,
                    ref: taskRef(id),
                  })),
                };
              },
            };
            return chain;
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
                if (hooks.onUserGet) hooks.onUserGet();
                return { exists: id in users, data: () => users[id] };
              },
            };
          },
          where(field, op, value) {
            if (field !== "email" || op !== "==") throw new Error("unexpected users query");
            return {
              limit() { return this; },
              async get() {
                state.emailQueries += 1;
                const hit = Object.entries(users).find(([, u]) => (u.email || "").toLowerCase() === value);
                return { empty: !hit, docs: hit ? [{ id: hit[0], data: () => hit[1] }] : [] };
              },
            };
          },
        };
      }
      if (name === "agentNotifications") {
        return {
          doc(id) {
            const noteId = id || `note-${(noteSeq += 1)}`;
            return {
              __kind: "note",
              id: noteId,
              async update(data) {
                noteUpdates[noteId] = { ...(noteUpdates[noteId] || {}), ...data };
              },
            };
          },
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
            if (o.ref.__kind === "note" && o.op === "set") notes.push({ ...o.data, __noteId: o.ref.id });
            if (o.ref.__kind === "task" && o.op === "update") {
              taskUpdates[o.ref.id] = { ...(taskUpdates[o.ref.id] || {}), ...o.data };
            }
          }
        },
      };
    },
    async runTransaction(fn) {
      const ops = [];
      const tx = {
        async get(ref) {
          if (ref.__kind === "task") {
            return {
              exists: ref.id in tasks,
              data: () => tasks[ref.id],
            };
          }
          throw new Error("unexpected transaction get");
        },
        set(ref, data) { ops.push({ op: "set", ref, data }); },
        update(ref, data) { ops.push({ op: "update", ref, data }); },
      };
      const result = await fn(tx);
      for (const o of ops) {
        if (o.ref.__kind === "note" && o.op === "set") notes.push({ ...o.data, __noteId: o.ref.id });
        if (o.ref.__kind === "task" && o.op === "update") {
          taskUpdates[o.ref.id] = { ...(taskUpdates[o.ref.id] || {}), ...o.data };
          tasks[o.ref.id] = { ...(tasks[o.ref.id] || {}), ...o.data };
        }
      }
      return result;
    },
  };
  return { db, state };
}

const holder = { db: null };
const telegramCalls = [];
const pushCalls = [];

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
vi.mock("../lib/push-send.js", () => ({
  sendPushToUser: vi.fn(async (uid, payload) => {
    pushCalls.push({ uid, payload });
    return { sent: 1 };
  }),
}));
// FieldValue.serverTimestamp is a sentinel here — the fake just stores it.
vi.mock("firebase-admin/firestore", () => ({
  FieldValue: { serverTimestamp: () => "__server_ts__" },
}));

const { default: handler } = await import("./agent-monitor.js");
const { sendTelegramMessage } = await import("../lib/telegram-send.js");

// 2026-07-03 09:00 МСК
const NOW = new Date("2026-07-03T06:00:00Z");
const EVENING = new Date("2026-07-03T15:13:00Z");

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
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AGENT_MONITOR_BUDGET_MS;
    telegramCalls.length = 0;
    pushCalls.length = 0;
    sendTelegramMessage.mockClear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete process.env.CRON_SECRET;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.AGENT_MONITOR_BUDGET_MS;
  });

  it("405 only on non-GET/POST methods (Vercel Cron invokes with GET)", async () => {
    const res = mockResponse();
    await handler(makeRequest({ method: "PUT" }), res);
    expect(res.statusCode).toBe(405);
  });

  it("GET with the correct secret runs the sweep (the daily Vercel cron path)", async () => {
    holder.db = makeFakeDb({ tasks: {}, projects: {}, users: {} }).db;
    const res = mockResponse();
    await handler(makeRequest({ method: "GET" }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("recipient from ANOTHER organization is skipped (cross-tenant guard)", async () => {
    const fake = makeFakeDb({
      tasks: {
        "t-cross": {
          status: "in-progress", subStatus: "in_work", title: "Смета",
          deadline: "2026-07-01", projectId: "p1", organizationId: "org-1",
          assigneeIds: ["u-foreign"], createdByUid: "u-local",
        },
      },
      projects: { p1: { name: "П", organizationId: "org-1" } },
      users: {
        "u-foreign": { organizationId: "org-OTHER", telegramChatId: "666", firstName: "Чужой", lastName: "Пользователь" },
        "u-local": { organizationId: "org-1", telegramChatId: "111", firstName: "Локальный", lastName: "Автор" },
      },
    });
    holder.db = fake.db;

    const res = mockResponse();
    await handler(makeRequest(), res);
    expect(res.statusCode).toBe(200);
    // Only the same-org creator got the feed entry + telegram.
    expect(fake.state.notes).toHaveLength(1);
    expect(fake.state.notes[0].uid).toBe("u-local");
    expect(fake.state.notes[0].text).not.toContain("Чужой Пользователь");
    expect(telegramCalls.map((c) => c.chatId)).toEqual(["111"]);
  });

  it("skips a task when neither the task nor its project has a verifiable organization", async () => {
    const fake = makeFakeDb({
      tasks: {
        "t-orphan": {
          status: "in-progress", subStatus: "in_work", title: "Смета",
          deadline: "2026-07-01", projectId: "missing-project",
          assigneeIds: ["u-local"],
        },
      },
      projects: {},
      users: {
        "u-local": { organizationId: "org-1", telegramChatId: "111", firstName: "Локальный" },
      },
    });
    holder.db = fake.db;

    const res = mockResponse();
    await handler(makeRequest(), res);
    expect(res.statusCode).toBe(200);
    expect(fake.state.notes).toHaveLength(0);
    expect(telegramCalls).toHaveLength(0);
    expect(fake.state.taskUpdates).toEqual({});
  });

  it("uses the project organization, not a stale task organizationId, for delivery", async () => {
    const fake = makeFakeDb({
      tasks: {
        "t-stale-org": {
          status: "in-progress", subStatus: "in_work", title: "Смета",
          deadline: "2026-07-01", projectId: "p2", organizationId: "org-OLD",
          assigneeIds: ["u-project"], createdByUid: "u-old",
        },
      },
      projects: { p2: { name: "П", organizationId: "org-2" } },
      users: {
        "u-project": { organizationId: "org-2", telegramChatId: "222", firstName: "Свой" },
        "u-old": { organizationId: "org-OLD", telegramChatId: "111", firstName: "Старый" },
      },
    });
    holder.db = fake.db;

    const res = mockResponse();
    await handler(makeRequest(), res);
    expect(res.statusCode).toBe(200);
    expect(fake.state.notes).toHaveLength(1);
    expect(fake.state.notes[0].uid).toBe("u-project");
    expect(fake.state.notes[0].organizationId).toBe("org-2");
    expect(telegramCalls.map((c) => c.chatId)).toEqual(["222"]);
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
        "u-assignee": { telegramChatId: "111", organizationId: "org-1", firstName: "Тэко", lastName: "Исаев" },
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
      expect(n.text).toContain("Ответственный: Тэко Исаев");
      expect(n.readAt).toBe(null);
    }

    // Daily anti-spam stamp with today's MSK date; fresh task got no updates.
    expect(fake.state.taskUpdates["t-over"].notifiedOverdueOn).toBe("2026-07-03");
    expect(fake.state.taskUpdates["t-fresh"]).toBeUndefined();

    // Telegram duplicated to both linked recipients.
    const chats = telegramCalls.map((c) => c.chatId).sort();
    expect(chats).toEqual(["111", "222"]);
    expect(telegramCalls[0].text).toContain("Ответственный: Тэко Исаев");
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

  it("notifies the creator once when a task remains without an assignee for an hour", async () => {
    const fake = makeFakeDb({
      tasks: {
        "t-unassigned": {
          status: "in-progress", subStatus: "assigned", title: "Подготовить документы",
          projectId: "p1", organizationId: "org-1", assigneeIds: [], assignee: "Не назначен",
          createdByUid: "u-creator",
          createdAt: new Date(NOW.getTime() - 2 * 3600_000).toISOString(),
        },
      },
      projects: { p1: { name: "Дом", organizationId: "org-1" } },
      users: { "u-creator": { organizationId: "org-1", telegramChatId: "222", firstName: "Тэко" } },
    });
    holder.db = fake.db;

    const res = mockResponse();
    await handler(makeRequest(), res);

    expect(res.body.events).toBe(1);
    expect(res.body.aiAttempts).toBe(0);
    expect(fake.state.notes).toHaveLength(1);
    expect(fake.state.notes[0]).toMatchObject({
      uid: "u-creator",
      type: "unassigned_1h",
      generatedBy: "rules",
    });
    expect(fake.state.notes[0].text).toContain("ИИ-агент");
    expect(fake.state.notes[0].text).toContain("нет ответственного");
    expect(fake.state.notes[0].text).toContain("Назначьте ответственного");
    expect(fake.state.taskUpdates["t-unassigned"].notifiedUnassignedAt).toBe("__server_ts__");
    expect(telegramCalls).toHaveLength(1);
  });

  it("sends the tomorrow-deadline progress reminder in the Moscow evening", async () => {
    vi.setSystemTime(EVENING);
    const fake = makeFakeDb({
      tasks: {
        "t-tomorrow": {
          status: "in-progress", subStatus: "in_work", title: "Подготовить договор",
          deadline: "2026-07-04", projectId: "p1", organizationId: "org-1",
          assigneeIds: ["u-assignee"], createdByUid: "u-creator",
        },
      },
      projects: { p1: { name: "Дом", organizationId: "org-1" } },
      users: {
        "u-assignee": { organizationId: "org-1", firstName: "Иван", telegramChatId: "111" },
        "u-creator": { organizationId: "org-1", firstName: "Тэко", telegramChatId: "222" },
      },
    });
    holder.db = fake.db;

    const res = mockResponse();
    await handler(makeRequest(), res);

    expect(res.body.events).toBe(1);
    expect(fake.state.notes).toHaveLength(2);
    expect(fake.state.notes.every((note) => note.type === "deadline_tomorrow")).toBe(true);
    expect(fake.state.notes[0].text).toContain("остался 1 день");
    expect(fake.state.notes[0].text).toContain("Сверьте текущий прогресс");
    expect(fake.state.notes[0].text).toContain("04.07.2026");
    expect(fake.state.taskUpdates["t-tomorrow"].notifiedDeadlineSoonAt).toBe("__server_ts__");
  });

  it("morning deadline_today reminder: once a day, with template advice, catch-up for late-set deadlines", async () => {
    const fake = makeFakeDb({
      tasks: {
        "t-today": {
          status: "in-progress", subStatus: "in_work", title: "Сдать отчёт",
          deadline: "2026-07-03", projectId: "p1", organizationId: "org-1",
          assigneeIds: ["u-assignee"], createdByUid: "u-creator",
        },
      },
      projects: { p1: { name: "Дом", organizationId: "org-1" } },
      users: {
        "u-assignee": { organizationId: "org-1", firstName: "Иван", telegramChatId: "111" },
        "u-creator": { organizationId: "org-1", telegramChatId: "222" },
      },
    });
    holder.db = fake.db;

    const res = mockResponse();
    await handler(makeRequest(), res);

    expect(res.body.events).toBe(1);
    expect(fake.state.notes).toHaveLength(2);
    expect(fake.state.notes.every((note) => note.type === "deadline_today")).toBe(true);
    expect(fake.state.notes[0].text).toContain("Срок сегодня");
    expect(fake.state.notes[0].text).toContain("Сдать отчёт");
    // Не-LLM тип тоже получает шаблонную рекомендацию.
    expect(fake.state.notes[0].text).toContain("Рекомендация: Согласуйте");
    expect(fake.state.notes[0].generatedBy).toBe("rules");
    expect(res.body.aiAttempts).toBe(0);
    expect(fake.state.taskUpdates["t-today"].notifiedDeadlineTodayOn).toBe("2026-07-03");

    // Повторный прогон в тот же день — тишина (дневной флаг).
    const rerun = mockResponse();
    await handler(makeRequest(), rerun);
    expect(rerun.body.events).toBe(0);
    expect(fake.state.notes).toHaveLength(2);
  });

  it("overdue note includes the age in days and a template recommendation", async () => {
    const fake = makeFakeDb({
      tasks: {
        "t-over": {
          status: "in-progress", subStatus: "in_work", title: "Смета",
          deadline: "2026-07-01", projectId: "p1", organizationId: "org-1",
          assigneeIds: ["u-assignee"],
        },
      },
      projects: { p1: { name: "П", organizationId: "org-1" } },
      users: { "u-assignee": { organizationId: "org-1", telegramChatId: "111", firstName: "Тэко" } },
    });
    holder.db = fake.db;

    const res = mockResponse();
    await handler(makeRequest(), res);

    expect(res.body.events).toBe(1);
    expect(fake.state.notes[0].text).toContain("Срок был 01.07.2026");
    expect(fake.state.notes[0].text).toContain("Просрочена на 2 дня");
    expect(fake.state.notes[0].text).toContain("Рекомендация: Уточните причину задержки");
    expect(telegramCalls[0].text).toContain("Просрочена на 2 дня");
  });

  it("digest: >3 same-type messages for one recipient collapse into ONE telegram + push; feed stays per-task", async () => {
    const tasks = {};
    for (let i = 1; i <= 5; i += 1) {
      tasks[`t-${i}`] = {
        status: "in-progress", subStatus: "in_work", title: `Задача ${i}`,
        deadline: "2026-07-01", projectId: "p1", organizationId: "org-1",
        createdByUid: "u-creator",
      };
    }
    const fake = makeFakeDb({
      tasks,
      projects: { p1: { name: "П", organizationId: "org-1" } },
      users: { "u-creator": { organizationId: "org-1", telegramChatId: "222", firstName: "Тэко" } },
    });
    holder.db = fake.db;

    const res = mockResponse();
    await handler(makeRequest(), res);

    expect(res.body.events).toBe(5);
    // Лента — по записи на задачу (deep-link), без агрегации.
    expect(fake.state.notes).toHaveLength(5);
    // Telegram и push — один дайджест вместо пяти сообщений.
    expect(telegramCalls).toHaveLength(1);
    expect(telegramCalls[0].chatId).toBe("222");
    expect(telegramCalls[0].text).toContain("5 задач просрочены");
    expect(telegramCalls[0].text).toContain("«Задача 1», «Задача 2», «Задача 3» и ещё 2");
    expect(pushCalls).toHaveLength(1);
    expect(pushCalls[0].uid).toBe("u-creator");
    expect(pushCalls[0].payload.title).toBe("Просрочено задач: 5");
    expect(pushCalls[0].payload.body).toContain("и ещё 2");
    expect(pushCalls[0].payload.data).toEqual({ digestType: "overdue" });
  });

  it("≤3 same-type messages per recipient stay individual (no digest)", async () => {
    const tasks = {};
    for (let i = 1; i <= 3; i += 1) {
      tasks[`t-${i}`] = {
        status: "in-progress", subStatus: "in_work", title: `Задача ${i}`,
        deadline: "2026-07-01", projectId: "p1", organizationId: "org-1",
        createdByUid: "u-creator",
      };
    }
    const fake = makeFakeDb({
      tasks,
      projects: { p1: { name: "П", organizationId: "org-1" } },
      users: { "u-creator": { organizationId: "org-1", telegramChatId: "222" } },
    });
    holder.db = fake.db;

    const res = mockResponse();
    await handler(makeRequest(), res);

    expect(res.body.events).toBe(3);
    expect(telegramCalls).toHaveLength(3);
    expect(telegramCalls.every((c) => c.text.includes("просрочена"))).toBe(true);
    expect(telegramCalls.some((c) => c.text.includes("и ещё"))).toBe(false);
    expect(pushCalls).toHaveLength(3);
    expect(pushCalls.every((c) => c.payload.title === "Задача просрочена")).toBe(true);
  });

  it("delivery marks: deliveredAt on success, deliveryFailed + counters on telegram failure (never throws)", async () => {
    const fake = makeFakeDb({
      tasks: {
        "t-over": {
          status: "in-progress", subStatus: "in_work", title: "Смета",
          deadline: "2026-07-01", projectId: "p1", organizationId: "org-1",
          assigneeIds: ["u-assignee"], createdByUid: "u-creator",
        },
      },
      projects: { p1: { name: "П", organizationId: "org-1" } },
      users: {
        "u-assignee": { organizationId: "org-1", telegramChatId: "111", firstName: "Тэко" },
        "u-creator": { organizationId: "org-1" }, // без telegram — только лента/push
      },
    });
    holder.db = fake.db;
    sendTelegramMessage.mockImplementationOnce(async () => ({
      ok: false, httpStatus: 429, errorCode: 429, description: "Too Many Requests",
    }));

    const res = mockResponse();
    await handler(makeRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.telegramSent).toBe(0);
    expect(res.body.telegramFailed).toBe(1);
    expect(res.body.pushFailed).toBe(0);

    const byUid = Object.fromEntries(fake.state.notes.map((n) => [n.uid, n]));
    const failedMark = fake.state.noteUpdates[byUid["u-assignee"].__noteId];
    expect(failedMark.deliveryFailed).toEqual({ telegram: true, push: false });
    expect(failedMark.deliveredAt).toBeUndefined();
    const okMark = fake.state.noteUpdates[byUid["u-creator"].__noteId];
    expect(okMark).toEqual({ deliveredAt: "__server_ts__" });
  });

  it("resolves each assignee email at most once per run (uid + display-name lookups share the cache)", async () => {
    const fake = makeFakeDb({
      tasks: {
        "t-1": {
          status: "in-progress", subStatus: "in_work", title: "Раз",
          deadline: "2026-07-01", projectId: "p1", organizationId: "org-1",
          assigneeEmail: "ivan@example.com", createdByUid: "u-creator",
        },
        "t-2": {
          status: "in-progress", subStatus: "in_work", title: "Два",
          deadline: "2026-07-01", projectId: "p1", organizationId: "org-1",
          assigneeEmail: "ivan@example.com", createdByUid: "u-creator",
        },
      },
      projects: { p1: { name: "П", organizationId: "org-1" } },
      users: {
        "u-ivan": { organizationId: "org-1", email: "ivan@example.com", firstName: "Иван" },
        "u-creator": { organizationId: "org-1" },
      },
    });
    holder.db = fake.db;

    const res = mockResponse();
    await handler(makeRequest(), res);

    expect(res.body.events).toBe(2);
    // Без кэша было бы 4 запроса (uid + имя на каждую из двух задач).
    expect(fake.state.emailQueries).toBe(1);
    expect(fake.state.notes[0].text).toContain("Ответственный: Иван");
  });

  it("run budget: stops claiming NEW events when exceeded, still delivers claimed ones (truncated)", async () => {
    const fake = makeFakeDb({
      tasks: {
        "t-1": {
          status: "in-progress", subStatus: "in_work", title: "Раз",
          deadline: "2026-07-01", projectId: "p1", organizationId: "org-1",
          createdByUid: "u-creator",
        },
        "t-2": {
          status: "in-progress", subStatus: "in_work", title: "Два",
          deadline: "2026-07-01", projectId: "p1", organizationId: "org-1",
          createdByUid: "u-creator",
        },
      },
      projects: { p1: { name: "П", organizationId: "org-1" } },
      users: { "u-creator": { organizationId: "org-1", telegramChatId: "222" } },
      // Эмулируем медленное окружение: каждое чтение user-дока «съедает» минуту.
      hooks: { onUserGet: () => vi.advanceTimersByTime(60_000) },
    });
    holder.db = fake.db;

    const res = mockResponse();
    await handler(makeRequest(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.truncated).toBe(true);
    expect(res.body.processed).toBe(1);
    expect(res.body.remaining).toBe(1);
    // Захваченное до превышения бюджета доставлено полностью.
    expect(res.body.events).toBe(1);
    expect(fake.state.notes).toHaveLength(1);
    expect(telegramCalls).toHaveLength(1);
    expect(res.body.telegramSent).toBe(1);
    // Нетронутая задача не получила флагов — её обработает следующий прогон.
    expect(fake.state.taskUpdates["t-2"]).toBeUndefined();
  });
});
