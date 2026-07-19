import { describe, expect, it } from "vitest";
import { formatIsoDayRu } from "./date-display.js";

describe("formatIsoDayRu", () => {
  it("formats ISO storage dates for Russian UI", () => {
    expect(formatIsoDayRu("2026-07-31")).toBe("31.07.2026");
    expect(formatIsoDayRu("2026-07-31T12:00:00Z")).toBe("31.07.2026");
    expect(formatIsoDayRu(null, "—")).toBe("—");
  });
});
