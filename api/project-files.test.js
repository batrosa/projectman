import { describe, it, expect } from "vitest";
import { validateUpload, extensionOf, ALLOWED_EXTENSIONS, MAX_FILE_BYTES } from "./project-files.js";

describe("extensionOf", () => {
  it("is case-insensitive", () => {
    expect(extensionOf("Report.PDF")).toBe("pdf");
  });

  it("handles filenames with multiple dots by taking the last segment", () => {
    expect(extensionOf("annual.report.v2.xlsx")).toBe("xlsx");
  });

  it("returns empty string when there is no extension", () => {
    expect(extensionOf("README")).toBe("");
  });

  it("returns empty string when the filename ends with a dot", () => {
    expect(extensionOf("weird.")).toBe("");
  });

  it("returns empty string for empty/undefined input", () => {
    expect(extensionOf("")).toBe("");
    expect(extensionOf(undefined)).toBe("");
  });
});

describe("validateUpload", () => {
  const base = { projectId: "p1", filename: "notes.md", url: "https://example.com/notes.md", sizeBytes: 100 };

  it("accepts a valid payload for each allowed extension", () => {
    for (const ext of ALLOWED_EXTENSIONS) {
      const result = validateUpload({ ...base, filename: `file.${ext}` });
      expect(result.ok).toBe(true);
    }
  });

  it("rejects when projectId is missing", () => {
    const result = validateUpload({ ...base, projectId: "" });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects when filename is missing", () => {
    const result = validateUpload({ ...base, filename: "" });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects when url is missing", () => {
    const result = validateUpload({ ...base, url: "" });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });

  it("rejects unsupported extensions", () => {
    const result = validateUpload({ ...base, filename: "virus.exe" });
    expect(result).toMatchObject({ ok: false, status: 400, error: "Unsupported file type: .exe" });
  });

  it("is case-insensitive for the extension check", () => {
    const result = validateUpload({ ...base, filename: "REPORT.XLSX" });
    expect(result.ok).toBe(true);
  });

  it("treats a filename with no extension as unsupported, not a crash", () => {
    const result = validateUpload({ ...base, filename: "README" });
    expect(result).toMatchObject({ ok: false, status: 400, error: "Unsupported file type: .?" });
  });

  it("rejects files over the 10 MB limit", () => {
    const result = validateUpload({ ...base, sizeBytes: MAX_FILE_BYTES + 1 });
    expect(result).toMatchObject({ ok: false, status: 400, error: "Invalid or oversized file size" });
  });

  it("rejects a non-numeric sizeBytes instead of silently letting it through", () => {
    const result = validateUpload({ ...base, sizeBytes: "not-a-number" });
    expect(result).toMatchObject({ ok: false, status: 400, error: "Invalid or oversized file size" });
  });

  it("rejects a negative sizeBytes", () => {
    const result = validateUpload({ ...base, sizeBytes: -500 });
    expect(result).toMatchObject({ ok: false, status: 400, error: "Invalid or oversized file size" });
  });

  it("rejects sizeBytes: Infinity", () => {
    const result = validateUpload({ ...base, sizeBytes: Infinity });
    expect(result).toMatchObject({ ok: false, status: 400, error: "Invalid or oversized file size" });
  });

  it("rejects sizeBytes: NaN", () => {
    const result = validateUpload({ ...base, sizeBytes: NaN });
    expect(result).toMatchObject({ ok: false, status: 400, error: "Invalid or oversized file size" });
  });

  it("accepts a file exactly at the size limit", () => {
    const result = validateUpload({ ...base, sizeBytes: MAX_FILE_BYTES });
    expect(result.ok).toBe(true);
  });

  it("does not reject when sizeBytes is missing (unknown size is allowed through)", () => {
    const result = validateUpload({ ...base, sizeBytes: undefined });
    expect(result.ok).toBe(true);
  });
});
