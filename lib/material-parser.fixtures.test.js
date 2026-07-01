import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { extractMaterialText } from "./material-parser.js";

function fixtureBase64(name) {
  const path = fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url));
  return readFileSync(path).toString("base64");
}

describe("extractMaterialText with real Office fixtures", () => {
  it("extracts text from a real .xlsx file", async () => {
    const base64 = fixtureBase64("sample.xlsx");
    const result = await extractMaterialText({
      filename: "sample.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64,
    });
    expect(result.parser).toBe("xlsx");
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).toContain("Привет");
    expect(result.text).toContain("мир");
  });

  it("extracts text from a real .docx file", async () => {
    const base64 = fixtureBase64("sample.docx");
    const result = await extractMaterialText({
      filename: "sample.docx",
      contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      base64,
    });
    expect(result.parser).toBe("docx");
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.text).toContain("Привет мир из docx фикстуры");
  });
});
