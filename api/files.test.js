import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  db: {},
}));

vi.mock("../lib/firebase-admin.js", () => ({
  adminAuth: () => ({ verifyIdToken: mocks.verifyIdToken }),
  adminDb: () => mocks.db,
}));

const { default: handler, callerCanManageProject, callerCanViewProject } = await import("./files.js");

function response() {
  return {
    statusCode: 0,
    body: null,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

describe("file access helpers", () => {
  it("uses the product's empty-list-means-all access model", () => {
    expect(callerCanViewProject(undefined, "p1")).toBe(true);
    expect(callerCanViewProject([], "p1")).toBe(true);
    expect(callerCanViewProject(["p1"], "p1")).toBe(true);
    expect(callerCanViewProject(["p2"], "p1")).toBe(false);
  });

  it("limits management to owner/admin/moderator", () => {
    expect(callerCanManageProject("owner", ["p2"], "p1")).toBe(true);
    expect(callerCanManageProject("admin", ["p2"], "p1")).toBe(true);
    expect(callerCanManageProject("moderator", ["p1"], "p1")).toBe(true);
    expect(callerCanManageProject("moderator", ["p2"], "p1")).toBe(false);
    expect(callerCanManageProject("employee", [], "p1")).toBe(false);
  });
});

describe("files endpoint boundary", () => {
  it("rejects non-POST methods", async () => {
    const res = response();
    await handler({ method: "GET", headers: {} }, res);
    expect(res.statusCode).toBe(405);
  });

  it("rejects requests without a verified Firebase token", async () => {
    mocks.verifyIdToken.mockRejectedValueOnce(new Error("invalid"));
    const res = response();
    await handler({ method: "POST", headers: { authorization: "Bearer bad" }, body: {} }, res);
    expect(res.statusCode).toBe(401);
  });
});
