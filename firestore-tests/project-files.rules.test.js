import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";

let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "projectman-rules-test-2",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});

afterAll(async () => { await testEnv.cleanup(); });

describe("project files subcollection", () => {
  it("denies direct client writes even from an admin-looking client", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("someone").set({ role: "admin" });
    });
    const someone = testEnv.authenticatedContext("someone").firestore();
    await assertFails(
      someone.collection("projects").doc("p1").collection("files").doc("f1").set({ filename: "x.pdf" })
    );
  });

  it("allows read for a user who can view the project", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("viewer1").set({ role: "reader", allowedProjects: [] });
      await ctx.firestore().collection("projects").doc("p1").collection("files").doc("f1").set({ filename: "x.pdf" });
    });
    const viewer = testEnv.authenticatedContext("viewer1").firestore();
    await assertSucceeds(viewer.collection("projects").doc("p1").collection("files").doc("f1").get());
  });
});
