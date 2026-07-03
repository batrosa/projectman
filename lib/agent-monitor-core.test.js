import { describe, it, expect } from "vitest";
import { mskDateString, classifyTask, buildEventText } from "./agent-monitor-core.js";

// 2026-07-03 09:00 Moscow time (06:00 UTC).
const NOW = new Date("2026-07-03T06:00:00Z");

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

  it("deadline_tomorrow: deadline == tomorrow, fires once", () => {
    const t = { ...base, deadline: "2026-07-04" };
    expect(classifyTask(t, NOW).map((e) => e.type)).toContain("deadline_tomorrow");
    expect(classifyTask({ ...t, notifiedDeadlineSoonAt: "sent" }, NOW)).toEqual([]);
  });

  it("not_taken_1h: assigned older than an hour, once; fresher than an hour — nothing", () => {
    const created = { toMillis: () => NOW.getTime() - 2 * 3600_000 };
    const t = { ...base, deadline: "2026-08-01", subStatus: "assigned", createdAt: created };
    expect(classifyTask(t, NOW).map((e) => e.type)).toEqual(["not_taken_1h"]);
    expect(classifyTask({ ...t, notifiedNotTakenAt: "sent" }, NOW)).toEqual([]);
    const fresh = { ...t, createdAt: { toMillis: () => NOW.getTime() - 10 * 60_000 } };
    expect(classifyTask(fresh, NOW)).toEqual([]);
  });

  it("submitted-for-review (subStatus completed) is not nagged; done/archived — nothing at all", () => {
    expect(classifyTask({ ...base, subStatus: "completed" }, NOW)).toEqual([]);
    expect(classifyTask({ ...base, status: "done" }, NOW)).toEqual([]);
  });

  it("an overdue assigned task can emit BOTH overdue and not_taken_1h", () => {
    const t = {
      ...base,
      subStatus: "assigned",
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
    const t = { ...base, deadline: "2026-08-01", subStatus: "assigned", createdAt: iso };
    expect(classifyTask(t, NOW).map((e) => e.type)).toEqual(["not_taken_1h"]);
  });
});

describe("buildEventText", () => {
  const ctx = { title: "Смета", projectName: "Лазурный берег", deadline: "2026-07-01" };
  it("русские тексты всех типов содержат задачу и проект", () => {
    expect(buildEventText("overdue", ctx)).toContain("просрочена");
    expect(buildEventText("overdue", ctx)).toContain("Смета");
    expect(buildEventText("overdue", ctx)).toContain("Лазурный берег");
    expect(buildEventText("overdue", ctx)).toContain("2026-07-01");
    expect(buildEventText("deadline_tomorrow", ctx)).toContain("1 день");
    expect(buildEventText("not_taken_1h", ctx)).toContain("не взята в работу");
  });
  it("без projectName текст не ломается", () => {
    expect(buildEventText("overdue", { title: "X", deadline: "2026-07-01" })).toContain("X");
  });
});
