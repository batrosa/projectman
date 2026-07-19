import { describe, expect, it } from "vitest";
import { canRequestDeadlineChangeForTask, canUserViewProject, isValidIsoDay } from "./deadline-change.js";

describe("deadline change validation", () => {
  it("accepts only real ISO calendar days", () => {
    expect(isValidIsoDay("2026-07-31")).toBe(true);
    expect(isValidIsoDay("2026-02-29")).toBe(false);
    expect(isValidIsoDay("31.07.2026")).toBe(false);
  });

  it("uses the same unrestricted/allow-list project access semantics", () => {
    expect(canUserViewProject({}, "p1")).toBe(true);
    expect(canUserViewProject({ allowedProjects: [] }, "p1")).toBe(true);
    expect(canUserViewProject({ allowedProjects: ["p1"] }, "p1")).toBe(true);
    expect(canUserViewProject({ allowedProjects: ["p2"] }, "p1")).toBe(false);
  });

  it("allows an assigned executor even when that user is also the task creator", () => {
    const task = { assigneeIds: ["same-user"], createdByUid: "same-user" };
    expect(canRequestDeadlineChangeForTask(task, "same-user")).toBe(true);
    expect(canRequestDeadlineChangeForTask(task, "other-user")).toBe(false);
  });
});
