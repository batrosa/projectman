import { describe, it, expect } from "vitest";
import { mskDateString, classifyTask, buildEventText, buildDigestText, pluralRu } from "./agent-monitor-core.js";

// 2026-07-03 09:00 Moscow time (06:00 UTC).
const NOW = new Date("2026-07-03T06:00:00Z");
// 2026-07-03 18:13 Moscow time.
const EVENING = new Date("2026-07-03T15:13:00Z");

const base = {
  status: "in-progress",
  subStatus: "in_work",
  title: "Согласовать смету",
  deadline: "2026-07-01",
};

describe("mskDateString", () => {
  it("formats YYYY-MM-DD in Europe/Moscow (UTC+3 boundary cases)", () => {
    // 22:30 UTC = 01:30 МСК следующего дня
    expect(mskDateString(new Date("2026-07-03T22:30:00Z"))).toBe("2026-07-04");
    // 20:59 UTC = 23:59 МСК того же дня
    expect(mskDateString(new Date("2026-07-03T20:59:00Z"))).toBe("2026-07-03");
  });
});

describe("classifyTask", () => {
  it("overdue: deadline < today and not yet sent today", () => {
    expect(classifyTask({ ...base }, NOW).map((e) => e.type)).toContain("overdue");
  });

  it("overdue is NOT repeated within the same day (notifiedOverdueOn == today)", () => {
    expect(classifyTask({ ...base, notifiedOverdueOn: "2026-07-03" }, NOW)).toEqual([]);
  });

  it("overdue REPEATS the next day (flag holds yesterday's date)", () => {
    expect(classifyTask({ ...base, notifiedOverdueOn: "2026-07-02" }, NOW).map((e) => e.type))
      .toContain("overdue");
  });

  it("deadline_tomorrow: deadline == tomorrow, fires once in the evening", () => {
    const t = { ...base, deadline: "2026-07-04", assigneeIds: ["u1"] };
    expect(classifyTask(t, NOW).map((e) => e.type)).not.toContain("deadline_tomorrow");
    expect(classifyTask(t, EVENING).map((e) => e.type)).toContain("deadline_tomorrow");
    expect(classifyTask({ ...t, notifiedDeadlineSoonAt: "sent" }, EVENING)).toEqual([]);
  });

  it("deadline notifications do not fire at night in Moscow; hourly monitor waits for the daytime window", () => {
    const nightMsk = new Date("2026-07-02T21:13:00Z"); // 00:13 MSK, July 3
    expect(classifyTask({ ...base }, nightMsk).map((e) => e.type)).not.toContain("overdue");
    expect(classifyTask({ ...base, deadline: "2026-07-04" }, nightMsk).map((e) => e.type)).not.toContain("deadline_tomorrow");
  });

  it("deadline_today: deadline == today fires once in the 9:00–12:00 MSK morning window", () => {
    const t = { ...base, deadline: "2026-07-03" }; // дедлайн — сегодня
    expect(classifyTask(t, NOW).map((e) => e.type)).toEqual(["deadline_today"]);
    // дневной флаг дедуплицирует повторные прогоны
    expect(classifyTask({ ...t, notifiedDeadlineTodayOn: "2026-07-03" }, NOW)).toEqual([]);
    // флаг вчерашнего дня не мешает: на следующее утро задача уже просрочена
    const nextMorning = new Date("2026-07-04T06:00:00Z");
    expect(classifyTask({ ...t, notifiedDeadlineTodayOn: "2026-07-03" }, nextMorning).map((e) => e.type))
      .toContain("overdue");
  });

  it("deadline_today is the morning catch-up: silent at night and after noon, evening deadline_tomorrow untouched", () => {
    const t = { ...base, deadline: "2026-07-03" };
    // 01:00 МСК: дедлайн-день уже наступил, но люди спят — ждём утреннее окно
    const nightMsk = new Date("2026-07-02T22:00:00Z");
    expect(classifyTask(t, nightMsk)).toEqual([]);
    // 13:30 МСК: утреннее окно закрыто — следующий шанс только завтра (как overdue)
    const afternoonMsk = new Date("2026-07-03T10:30:00Z");
    expect(classifyTask(t, afternoonMsk)).toEqual([]);
    // Задача, чей «завтрашний» дедлайн поставили после вечернего окна,
    // не получила deadline_tomorrow — утром её ловит deadline_today:
    // вечером deadline == tomorrow, утром deadline == today.
    const t2 = { ...base, deadline: "2026-07-04", assigneeIds: ["u1"] };
    expect(classifyTask(t2, EVENING).map((e) => e.type)).toContain("deadline_tomorrow");
    expect(classifyTask(t2, EVENING).map((e) => e.type)).not.toContain("deadline_today");
  });

  it("not_taken_1h is quiet at night: a task assigned at 01:30 MSK fires the next morning, nothing lost", () => {
    const nightMsk = new Date("2026-07-02T22:30:00Z"); // 01:30 МСК, July 3
    const t = {
      ...base,
      deadline: "2026-08-01",
      subStatus: "assigned",
      assignedAt: { toMillis: () => nightMsk.getTime() - 2 * 3600_000 },
      assigneeIds: ["u1"],
    };
    expect(classifyTask(t, nightMsk)).toEqual([]);
    // утром флаг ещё не стоял — событие догорает в дневном окне
    expect(classifyTask(t, NOW).map((e) => e.type)).toEqual(["not_taken_1h"]);
  });

  it("not_taken_1h: assigned older than an hour, once; fresher than an hour — nothing", () => {
    const created = { toMillis: () => NOW.getTime() - 2 * 3600_000 };
    const t = { ...base, deadline: "2026-08-01", subStatus: "assigned", createdAt: created, assigneeIds: ["u1"] };
    expect(classifyTask(t, NOW).map((e) => e.type)).toEqual(["not_taken_1h"]);
    expect(classifyTask({ ...t, notifiedNotTakenAt: "sent" }, NOW)).toEqual([]);
    const fresh = { ...t, createdAt: { toMillis: () => NOW.getTime() - 10 * 60_000 } };
    expect(classifyTask(fresh, NOW)).toEqual([]);
  });

  it("not_taken_1h uses assignedAt when a task was reassigned", () => {
    const t = {
      ...base,
      deadline: "2026-08-01",
      subStatus: "assigned",
      createdAt: { toMillis: () => NOW.getTime() - 4 * 3600_000 },
      assignedAt: { toMillis: () => NOW.getTime() - 10 * 60_000 },
      assigneeIds: ["u1"],
    };
    expect(classifyTask(t, NOW)).toEqual([]);
  });

  it("legacy tasks without subStatus are treated as assigned, matching the board", () => {
    const t = { ...base, deadline: "2026-07-01", subStatus: undefined, assigneeIds: ["u1"] };
    expect(classifyTask(t, NOW).map((e) => e.type)).toContain("overdue");
  });

  it("unassigned_1h: after one hour notifies once instead of pretending it is not_taken", () => {
    const t = {
      ...base,
      deadline: "2026-08-01",
      subStatus: "assigned",
      createdAt: { toMillis: () => NOW.getTime() - 2 * 3600_000 },
      assignee: "Не назначен",
      assigneeIds: [],
    };
    expect(classifyTask(t, NOW).map((event) => event.type)).toEqual(["unassigned_1h"]);
    expect(classifyTask({ ...t, notifiedUnassignedAt: "sent" }, NOW)).toEqual([]);
  });

  it("does not send a second deadline-tomorrow reminder for an unassigned task", () => {
    const t = {
      ...base,
      deadline: "2026-07-04",
      subStatus: "assigned",
      createdAt: { toMillis: () => EVENING.getTime() - 2 * 3600_000 },
      assignee: "Не назначен",
      assigneeIds: [],
    };
    expect(classifyTask(t, EVENING).map((event) => event.type)).toEqual(["unassigned_1h"]);
  });

  it("submitted-for-review (subStatus completed) is not nagged; done/archived — nothing at all", () => {
    expect(classifyTask({ ...base, subStatus: "completed" }, NOW)).toEqual([]);
    expect(classifyTask({ ...base, status: "done" }, NOW)).toEqual([]);
  });

  it("an overdue assigned task can emit BOTH overdue and not_taken_1h", () => {
    const t = {
      ...base,
      subStatus: "assigned",
      assigneeIds: ["u1"],
      createdAt: { toMillis: () => NOW.getTime() - 3 * 3600_000 },
    };
    const types = classifyTask(t, NOW).map((e) => e.type).sort();
    expect(types).toEqual(["not_taken_1h", "overdue"]);
  });

  it("garbage/absent deadline never throws; only the not_taken branch can fire", () => {
    expect(() => classifyTask({ ...base, deadline: "мусор" }, NOW)).not.toThrow();
    expect(classifyTask({ ...base, deadline: null }, NOW)).toEqual([]);
    expect(classifyTask(null, NOW)).toEqual([]);
  });

  it("createdAt as ISO string also works for not_taken_1h", () => {
    const iso = new Date(NOW.getTime() - 2 * 3600_000).toISOString();
    const t = { ...base, deadline: "2026-08-01", subStatus: "assigned", createdAt: iso, assigneeIds: ["u1"] };
    expect(classifyTask(t, NOW).map((e) => e.type)).toEqual(["not_taken_1h"]);
  });
});

describe("buildEventText", () => {
  const ctx = { title: "Смета", projectName: "Лазурный берег", deadline: "2026-07-01", assigneeNames: "Тэко Исаев" };
  it("русские тексты всех типов содержат задачу и проект", () => {
    expect(buildEventText("overdue", ctx)).toContain("просрочена");
    expect(buildEventText("overdue", ctx)).toContain("Смета");
    expect(buildEventText("overdue", ctx)).toContain("Лазурный берег");
    expect(buildEventText("overdue", ctx)).toContain("Ответственный: Тэко Исаев");
    expect(buildEventText("overdue", ctx)).toContain("01.07.2026");
    expect(buildEventText("deadline_today", ctx)).toContain("Срок сегодня");
    expect(buildEventText("deadline_today", ctx)).toContain("Смета");
    expect(buildEventText("deadline_today", ctx)).toContain("Ответственный: Тэко Исаев");
    expect(buildEventText("deadline_tomorrow", ctx)).toContain("1 день");
    expect(buildEventText("not_taken_1h", ctx)).toContain("не взята в работу");
    expect(buildEventText("unassigned_1h", ctx)).toContain("нет ответственного");
    expect(buildEventText("unassigned_1h", ctx)).toContain("ИИ-агент");
  });
  it("для нескольких ответственных пишет множественное число", () => {
    const text = buildEventText("deadline_tomorrow", { ...ctx, assigneeNames: ["А", "Б"] });
    expect(text).toContain("Ответственные: А, Б");
  });
  it("без projectName текст не ломается", () => {
    expect(buildEventText("overdue", { title: "X", deadline: "2026-07-01" })).toContain("X");
  });
  it("возраст просрочки с правильным множественным числом: день/дня/дней", () => {
    const at = (deadline, today) => buildEventText("overdue", { title: "X", deadline, today });
    expect(at("2026-07-02", "2026-07-03")).toContain("Просрочена на 1 день");
    expect(at("2026-07-01", "2026-07-03")).toContain("Просрочена на 2 дня");
    expect(at("2026-06-30", "2026-07-03")).toContain("Просрочена на 3 дня");
    expect(at("2026-06-28", "2026-07-03")).toContain("Просрочена на 5 дней");
    expect(at("2026-06-12", "2026-07-03")).toContain("Просрочена на 21 день");
    expect(at("2026-06-02", "2026-07-03")).toContain("Просрочена на 31 день");
    expect(at("2026-06-23", "2026-07-03")).toContain("Просрочена на 10 дней");
    // без today или с мусорной датой возраст просто опускается
    expect(buildEventText("overdue", { title: "X", deadline: "2026-07-01" })).not.toContain("Просрочена на");
    expect(at("мусор", "2026-07-03")).not.toContain("Просрочена на");
  });
});

describe("pluralRu", () => {
  it("день/дня/дней по последним цифрам", () => {
    const day = (n) => pluralRu(n, "день", "дня", "дней");
    expect([1, 21, 31, 101].map(day)).toEqual(["день", "день", "день", "день"]);
    expect([2, 3, 4, 22, 44].map(day)).toEqual(["дня", "дня", "дня", "дня", "дня"]);
    expect([5, 10, 11, 12, 14, 25, 111].map(day)).toEqual(["дней", "дней", "дней", "дней", "дней", "дней", "дней"]);
  });
});

describe("buildDigestText", () => {
  it("перечисляет до 3 названий и считает остальные", () => {
    const text = buildDigestText("overdue", { count: 7, titles: ["А", "Б", "В", "Г", "Д", "Е", "Ж"] });
    expect(text).toContain("ИИ-агент");
    expect(text).toContain("7 задач просрочены");
    expect(text).toContain("«А», «Б», «В» и ещё 4");
  });
  it("склоняет существительное и глагол по счёту", () => {
    expect(buildDigestText("overdue", { count: 4, titles: ["А", "Б", "В", "Г"] }))
      .toContain("4 задачи просрочены");
    expect(buildDigestText("not_taken_1h", { count: 21, titles: ["А"] }))
      .toContain("21 задача не взята в работу");
    expect(buildDigestText("deadline_today", { count: 5, titles: ["А", "Б", "В", "Г", "Д"] }))
      .toContain("5 задач с дедлайном сегодня");
  });
  it("без названий — просто счётчик; неизвестный тип не падает", () => {
    expect(buildDigestText("unassigned_1h", { count: 6, titles: [] }))
      .toBe("📋 ИИ-агент: 6 задач без ответственного.");
    expect(buildDigestText("что-то", { count: 4, titles: ["А", "Б", "В", "Г"] }))
      .toContain("4 задачи требуют внимания");
  });
});
