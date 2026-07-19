import { describe, it, expect, afterEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {},
  verifyIdToken: async () => ({ uid: "u1" }),
}));

vi.mock("../lib/firebase-admin.js", () => ({
  adminDb: () => mocks.db,
  adminAuth: () => ({ verifyIdToken: mocks.verifyIdToken }),
}));

const { default: handler, validateUpload, extensionOf, isAllowedFileUrl, ALLOWED_EXTENSIONS, MAX_FILE_BYTES, callerCanManageProjectFiles } = await import("./project-files.js");

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

describe("isAllowedFileUrl", () => {
  it("accepts a URL under the app's own Cloudinary cloud", () => {
    expect(isAllowedFileUrl("https://res.cloudinary.com/dwoa1lqz1/raw/upload/x.pdf")).toBe(true);
  });

  it("rejects an internal/metadata-service URL (SSRF)", () => {
    expect(isAllowedFileUrl("http://169.254.169.254/")).toBe(false);
  });

  it("rejects an arbitrary external URL", () => {
    expect(isAllowedFileUrl("https://evil.com/x.pdf")).toBe(false);
  });

  it("rejects a different Cloudinary cloud name", () => {
    expect(isAllowedFileUrl("https://res.cloudinary.com/OTHERCLOUD/x.pdf")).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isAllowedFileUrl(undefined)).toBe(false);
    expect(isAllowedFileUrl(null)).toBe(false);
    expect(isAllowedFileUrl(123)).toBe(false);
    expect(isAllowedFileUrl({})).toBe(false);
  });

  it("rejects an http (non-https) URL even on the right host", () => {
    expect(isAllowedFileUrl("http://res.cloudinary.com/dwoa1lqz1/raw/upload/x.pdf")).toBe(false);
  });
});

describe("callerCanManageProjectFiles", () => {
  it("allows owner/admin for any org project", () => {
    expect(callerCanManageProjectFiles("owner", ["other"], "p1")).toBe(true);
    expect(callerCanManageProjectFiles("admin", ["other"], "p1")).toBe(true);
  });

  it("allows moderators only inside their project access list", () => {
    expect(callerCanManageProjectFiles("moderator", [], "p1")).toBe(true);
    expect(callerCanManageProjectFiles("moderator", ["p1"], "p1")).toBe(true);
    expect(callerCanManageProjectFiles("moderator", ["p2"], "p1")).toBe(false);
  });

  it("blocks employee/reader even when they can read the project", () => {
    expect(callerCanManageProjectFiles("employee", [], "p1")).toBe(false);
    expect(callerCanManageProjectFiles("reader", ["p1"], "p1")).toBe(false);
  });
});

// --- Handler-level tests (retry, dedup) ---

function fakeResponse() {
  return {
    statusCode: null,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
}

function fakeRequest(body) {
  return { method: "POST", headers: { authorization: "Bearer token" }, body };
}

// Minimal Firestore fake covering the handler's access patterns: caller
// userDoc, project doc, files subcollection doc CRUD and the dedup query.
function fakeDb({ caller = { organizationId: "org1", orgRole: "owner" }, projectData = { organizationId: "org1" }, files = [] } = {}) {
  const state = {
    fileDocs: new Map(files.map((file) => [file.id, { ...file.data }])),
    created: [],
    updated: [],
    nextId: 1,
  };
  const filesCollection = {
    doc(id) {
      const docId = id || `newfile${state.nextId++}`;
      return {
        id: docId,
        get: async () => ({ exists: state.fileDocs.has(docId), id: docId, data: () => state.fileDocs.get(docId) }),
        set: async (data) => { state.created.push({ id: docId, data }); state.fileDocs.set(docId, data); },
        update: async (data) => {
          state.updated.push({ id: docId, data });
          state.fileDocs.set(docId, { ...state.fileDocs.get(docId), ...data });
        },
      };
    },
    where(field, _op, value) {
      this.filters = [...(this.filters || []), [field, value]];
      return this;
    },
    limit() { return this; },
    async get() {
      const filters = this.filters || [];
      const docs = [...state.fileDocs.entries()]
        .filter(([, data]) => filters.every(([field, value]) => (data[field] ?? null) === value))
        .map(([id, data]) => ({ id, data: () => data }));
      return { empty: docs.length === 0, docs };
    },
  };
  return {
    state,
    collection(name) {
      if (name === "users") {
        return { doc: () => ({ get: async () => ({ exists: true, data: () => caller }) }) };
      }
      return {
        doc: () => ({
          get: async () => ({ exists: true, data: () => projectData }),
          collection: () => filesCollection,
        }),
      };
    },
  };
}

// The background extraction is fire-and-forget (waitUntil no-ops outside
// Vercel), so give the microtask queue a few macrotasks to settle.
async function flushAsync(rounds = 30) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

const CLOUDINARY_URL = "https://res.cloudinary.com/dwoa1lqz1/raw/upload/notes.md";

describe("project-files handler", () => {
  afterEach(() => {
    mocks.db = {};
    vi.unstubAllGlobals();
  });

  it("returns the existing file doc when the same file is uploaded again", async () => {
    const db = fakeDb({
      files: [{ id: "f1", data: { filename: "notes.md", url: CLOUDINARY_URL, sizeBytes: 100, extractionStatus: "done" } }],
    });
    mocks.db = db;
    const response = fakeResponse();
    await handler(fakeRequest({ projectId: "p1", filename: "notes.md", url: CLOUDINARY_URL, sizeBytes: 100 }), response);
    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.duplicate).toBe(true);
    expect(response.body.fileId).toBe("f1");
    expect(response.body.file).toMatchObject({ id: "f1", filename: "notes.md", extractionStatus: "done" });
    expect(db.state.created).toHaveLength(0);
  });

  it("creates a new doc when no duplicate exists", async () => {
    const db = fakeDb();
    mocks.db = db;
    vi.stubGlobal("fetch", async () => new Response(Buffer.from("# Заметка\nПривет мир"), { status: 200 }));
    const response = fakeResponse();
    await handler(fakeRequest({ projectId: "p1", filename: "notes.md", url: CLOUDINARY_URL, mimeType: "text/markdown", sizeBytes: 100 }), response);
    expect(response.statusCode).toBe(200);
    expect(response.body.ok).toBe(true);
    expect(response.body.duplicate).toBeUndefined();
    expect(db.state.created).toHaveLength(1);
    expect(db.state.created[0].data).toMatchObject({ filename: "notes.md", extractionStatus: "pending", uploadedBy: "u1" });
    await flushAsync();
    const doc = db.state.fileDocs.get(db.state.created[0].id);
    expect(doc.extractionStatus).toBe("done");
    expect(doc.extractedText).toContain("Привет мир");
  });

  it("retry: true re-runs extraction for an existing file doc", async () => {
    const db = fakeDb({
      files: [{
        id: "f1",
        data: {
          filename: "notes.md",
          url: CLOUDINARY_URL,
          mimeType: "text/markdown",
          sizeBytes: 12,
          extractionStatus: "error",
          extractionWarnings: ["Failed to download file: 503"],
        },
      }],
    });
    mocks.db = db;
    vi.stubGlobal("fetch", async () => new Response(Buffer.from("# Заметка\nПривет мир"), { status: 200 }));
    const response = fakeResponse();
    await handler(fakeRequest({ projectId: "p1", fileId: "f1", retry: true }), response);
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ ok: true, fileId: "f1" });
    expect(db.state.created).toHaveLength(0);
    expect(db.state.updated[0]).toMatchObject({ id: "f1" });
    expect(db.state.updated[0].data).toMatchObject({ extractionStatus: "pending", extractionWarnings: [] });
    await flushAsync();
    const doc = db.state.fileDocs.get("f1");
    expect(doc.extractionStatus).toBe("done");
    expect(doc.extractedText).toContain("Привет мир");
    expect(doc.extractionWarnings).toEqual([]);
  });

  it("retry on a missing file doc returns 404", async () => {
    mocks.db = fakeDb();
    const response = fakeResponse();
    await handler(fakeRequest({ projectId: "p1", fileId: "nope", retry: true }), response);
    expect(response.statusCode).toBe(404);
  });

  it("retry requires manage rights", async () => {
    mocks.db = fakeDb({ caller: { organizationId: "org1", orgRole: "employee" } });
    const response = fakeResponse();
    await handler(fakeRequest({ projectId: "p1", fileId: "f1", retry: true }), response);
    expect(response.statusCode).toBe(403);
  });
});
