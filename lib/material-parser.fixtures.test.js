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

  it("extracts text from a real .xlsx file using the shared-strings table (t=\"s\" cells)", async () => {
    // Unlike sample.xlsx (which uses inline strings, t="inlineStr"), this fixture was
    // hand-built with a genuine xl/sharedStrings.xml <sst> table and worksheet cells
    // referencing it by index (t="s"), exercising parseSharedStrings() and the
    // type === "s" branch of parseSheetRows() in material-parser.js.
    const base64 = fixtureBase64("sample-shared-strings.xlsx");
    const result = await extractMaterialText({
      filename: "sample-shared-strings.xlsx",
      contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64,
    });
    expect(result.parser).toBe("xlsx");
    expect(result.text).toContain("SharedStringsFixture\tповтор");
    expect(result.text).toContain("повтор\tуникальный");
  });

  it("extracts text from a real .pdf file with a genuine text layer", async () => {
    const base64 = fixtureBase64("sample.pdf");
    const result = await extractMaterialText({
      filename: "sample.pdf",
      contentType: "application/pdf",
      base64,
    });
    expect(result.parser).toBe("pdf");
    expect(result.text).toContain("PdfFixtureSmokeTest real extractable text 12345");
    expect(result.text).toContain("Second line for good measure.");
  });
});
