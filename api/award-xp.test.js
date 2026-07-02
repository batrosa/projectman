import { describe, it, expect } from "vitest";
import {
  XP_CONFIG,
  getLevelFromXP,
  computeXpDelta,
  computeWasOnTime,
  callerCanManageProject,
} from "./award-xp.js";

describe("award-xp pure helpers", () => {
  describe("getLevelFromXP", () => {
    it("maps XP to the highest reached level", () => {
      expect(getLevelFromXP(0)).toBe(1);
      expect(getLevelFromXP(49)).toBe(1);
      expect(getLevelFromXP(50)).toBe(2);
      expect(getLevelFromXP(149)).toBe(2);
      expect(getLevelFromXP(150)).toBe(3);
      expect(getLevelFromXP(1200)).toBe(7);
      expect(getLevelFromXP(99999)).toBe(7);
    });
    it("never goes below level 1 for negative/zero XP", () => {
      expect(getLevelFromXP(-10)).toBe(1);
    });
  });

  describe("computeXpDelta", () => {
    it("base = 10", () => {
      expect(computeXpDelta(false, false)).toBe(10);
    });
    it("on time adds the bonus", () => {
      expect(computeXpDelta(true, false)).toBe(XP_CONFIG.baseTaskXP + XP_CONFIG.onTimeBonus); // 15
    });
    it("revision subtracts the penalty", () => {
      expect(computeXpDelta(false, true)).toBe(XP_CONFIG.baseTaskXP - XP_CONFIG.revisionPenalty); // 7
    });
    it("on time + revision nets both", () => {
      expect(computeXpDelta(true, true)).toBe(10 + 5 - 3); // 12
    });
    it("floors at 1", () => {
      expect(computeXpDelta(false, false)).toBeGreaterThanOrEqual(1);
    });
  });

  describe("computeWasOnTime", () => {
    it("no deadline → on time", () => {
      expect(computeWasOnTime(new Date("2026-07-10T00:00:00Z"), null)).toBe(true);
      expect(computeWasOnTime(new Date("2026-07-10T00:00:00Z"), "")).toBe(true);
    });
    it("completed well before the deadline → on time", () => {
      expect(computeWasOnTime(new Date("2026-07-09T12:00:00"), "2026-07-10")).toBe(true);
    });
    it("completed after the deadline's end of day → late", () => {
      expect(computeWasOnTime(new Date("2026-07-11T12:00:00"), "2026-07-10")).toBe(false);
    });
    it("invalid deadline → on time (parity fallback)", () => {
      expect(computeWasOnTime(new Date("2026-07-11T12:00:00"), "not-a-date")).toBe(true);
    });
    it("missing completion time → on time (parity fallback)", () => {
      expect(computeWasOnTime(null, "2026-07-10")).toBe(true);
    });
  });

  describe("callerCanManageProject", () => {
    it("owner and admin manage any project", () => {
      expect(callerCanManageProject("owner", ["other"], "p1")).toBe(true);
      expect(callerCanManageProject("admin", null, "p1")).toBe(true);
    });
    it("moderator manages only allowed projects", () => {
      expect(callerCanManageProject("moderator", ["p1"], "p1")).toBe(true);
      expect(callerCanManageProject("moderator", ["p2"], "p1")).toBe(false);
    });
    it("moderator with empty/absent allowedProjects manages all", () => {
      expect(callerCanManageProject("moderator", [], "p1")).toBe(true);
      expect(callerCanManageProject("moderator", null, "p1")).toBe(true);
    });
    it("employee and reader can never manage", () => {
      expect(callerCanManageProject("employee", [], "p1")).toBe(false);
      expect(callerCanManageProject("reader", [], "p1")).toBe(false);
      expect(callerCanManageProject(null, [], "p1")).toBe(false);
    });
  });
});
