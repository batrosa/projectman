import { describe, expect, it } from "vitest";
import fs from "node:fs";

const styles = fs.readFileSync(new URL("./style.css", import.meta.url), "utf8");

describe("task details lifecycle controls", () => {
  it("keeps lifecycle buttons visible for employee/read-only accounts", () => {
    expect(styles).toMatch(
      /body\.read-only #task-details-modal \.task-details-status-btn\s*\{[^}]*display:\s*flex\s*!important;/s,
    );
  });
});
