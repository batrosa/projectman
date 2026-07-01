import { describe, it, expect } from "vitest";
import { extractMaterialText } from "./material-parser.js";

describe("extractMaterialText", () => {
  it("extracts plain text from a .md file", async () => {
    const base64 = Buffer.from("# Заметка\nПривет мир").toString("base64");
    const result = await extractMaterialText({ filename: "note.md", contentType: "text/markdown", base64 });
    expect(result.parser).toBe("md");
    expect(result.text).toContain("Привет мир");
  });

  it("returns a warning for an empty file", async () => {
    const result = await extractMaterialText({ filename: "empty.pdf", contentType: "application/pdf", base64: "" });
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
