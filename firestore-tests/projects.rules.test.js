import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";

let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "projectman-rules-projects",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

async function seedOrgUser(ctx, uid, { organizationId, orgRole, role = "reader" }) {
  await ctx.firestore().collection("users").doc(uid).set({ role, organizationId, orgRole });
}

describe("project and task organization permissions", () => {
  it("allows an organization owner with legacy role=reader to create a project in their org", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await seedOrgUser(ctx, "owner1", { organizationId: "org-1", orgRole: "owner" });
    });

    const owner = testEnv.authenticatedContext("owner1").firestore();
    await assertSucceeds(
      owner.collection("projects").add({
        name: "New Project",
        description: "",
        organizationId: "org-1",
        createdAt: new Date(),
      })
    );
  });

  it("blocks employees and moderators from creating projects", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await seedOrgUser(ctx, "employee1", { organizationId: "org-1", orgRole: "employee" });
      await seedOrgUser(ctx, "moderator1", { organizationId: "org-1", orgRole: "moderator" });
    });

    const employee = testEnv.authenticatedContext("employee1").firestore();
    const moderator = testEnv.authenticatedContext("moderator1").firestore();
    const project = { name: "Blocked", organizationId: "org-1", createdAt: new Date() };

    await assertFails(employee.collection("projects").add(project));
    await assertFails(moderator.collection("projects").add(project));
  });

  it("blocks an owner from creating or deleting projects in another organization", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await seedOrgUser(ctx, "owner1", { organizationId: "org-1", orgRole: "owner" });
      await ctx.firestore().collection("projects").doc("other-project").set({
        name: "Other",
        organizationId: "org-2",
      });
    });

    const owner = testEnv.authenticatedContext("owner1").firestore();
    await assertFails(owner.collection("projects").add({ name: "Wrong Org", organizationId: "org-2" }));
    await assertFails(owner.collection("projects").doc("other-project").delete());
  });

  it("allows an organization admin to update and delete projects in their org", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await seedOrgUser(ctx, "admin1", { organizationId: "org-1", orgRole: "admin" });
      await ctx.firestore().collection("projects").doc("p1").set({
        name: "Project",
        organizationId: "org-1",
      });
    });

    const admin = testEnv.authenticatedContext("admin1").firestore();
    await assertSucceeds(admin.collection("projects").doc("p1").update({ name: "Renamed" }));
    await assertSucceeds(admin.collection("projects").doc("p1").delete());
  });

  it("allows a moderator to create a task only for a project in their organization", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await seedOrgUser(ctx, "moderator1", { organizationId: "org-1", orgRole: "moderator" });
      await ctx.firestore().collection("projects").doc("p1").set({ name: "Own", organizationId: "org-1" });
      await ctx.firestore().collection("projects").doc("p2").set({ name: "Other", organizationId: "org-2" });
    });

    const moderator = testEnv.authenticatedContext("moderator1").firestore();
    await assertSucceeds(
      moderator.collection("tasks").add({
        projectId: "p1",
        organizationId: "org-1",
        title: "Task",
        status: "todo",
      })
    );
    await assertFails(
      moderator.collection("tasks").add({
        projectId: "p2",
        organizationId: "org-1",
        title: "Cross-org task",
        status: "todo",
      })
    );
  });
});
