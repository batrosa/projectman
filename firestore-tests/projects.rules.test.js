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

  it("allows an organization owner with stale allowedProjects to read all projects in their org", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("owner1").set({
        role: "reader",
        organizationId: "org-1",
        orgRole: "owner",
        allowedProjects: ["old-project"],
      });
      await ctx.firestore().collection("projects").doc("p1").set({ name: "One", organizationId: "org-1" });
      await ctx.firestore().collection("projects").doc("p2").set({ name: "Two", organizationId: "org-1" });
      await ctx.firestore().collection("projects").doc("p3").set({ name: "Other", organizationId: "org-2" });
    });

    const owner = testEnv.authenticatedContext("owner1").firestore();
    await assertSucceeds(owner.collection("projects").where("organizationId", "==", "org-1").get());
    await assertFails(owner.collection("projects").where("organizationId", "==", "org-2").get());
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

  it("allows a moderator to edit and delete tasks in their org project even when the task misses organizationId", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await seedOrgUser(ctx, "moderator1", { organizationId: "org-1", orgRole: "moderator" });
      await ctx.firestore().collection("projects").doc("p1").set({ name: "Own", organizationId: "org-1" });
      await ctx.firestore().collection("tasks").doc("t1").set({
        projectId: "p1",
        title: "Legacy task without org",
        status: "in-progress",
        subStatus: "assigned",
      });
    });

    const moderator = testEnv.authenticatedContext("moderator1").firestore();
    await assertSucceeds(moderator.collection("tasks").doc("t1").update({ title: "Edited" }));
    await assertSucceeds(moderator.collection("tasks").doc("t1").delete());
  });

  it("blocks a reader from deleting tasks but allows moving their assigned task to work/completed states", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("reader1").set({
        role: "reader",
        organizationId: "org-1",
        orgRole: "employee",
        allowedProjects: ["p1"],
      });
      await ctx.firestore().collection("users").doc("reader2").set({
        role: "reader",
        organizationId: "org-1",
        orgRole: "employee",
        allowedProjects: ["p1"],
      });
      await ctx.firestore().collection("projects").doc("p1").set({ name: "Own", organizationId: "org-1" });
      await ctx.firestore().collection("tasks").doc("t1").set({
        projectId: "p1",
        organizationId: "org-1",
        title: "Reader task",
        status: "in-progress",
        subStatus: "assigned",
        assigneeCompleted: false,
        assigneeIds: ["reader1"],
      });
    });

    const reader = testEnv.authenticatedContext("reader1").firestore();
    const otherReader = testEnv.authenticatedContext("reader2").firestore();
    await assertFails(reader.collection("tasks").doc("t1").delete());
    await assertFails(otherReader.collection("tasks").doc("t1").update({
      status: "in-progress",
      subStatus: "in_work",
      assigneeCompleted: false,
      takenToWorkAt: "2026-07-02T00:00:00.000Z",
      takenToWorkBy: "Other Reader",
    }));
    await assertSucceeds(reader.collection("tasks").doc("t1").update({
      status: "in-progress",
      subStatus: "in_work",
      assigneeCompleted: false,
      takenToWorkAt: "2026-07-02T00:00:00.000Z",
      takenToWorkBy: "Reader",
    }));
    await assertSucceeds(reader.collection("tasks").doc("t1").update({
      status: "in-progress",
      subStatus: "completed",
      assigneeCompleted: true,
      completedAt: "2026-07-02T01:00:00.000Z",
      completedBy: "Reader",
      completionComment: "Done",
      completionProof: null,
      completionProofs: [],
      revisionReason: null,
      revisionReturnedBy: null,
      revisionReturnedAt: null,
    }));

    // A non-admin assignee still must not be able to change protected task fields,
    // even when bundled with an otherwise-legal subStatus transition.
    await assertFails(reader.collection("tasks").doc("t1").update({
      title: "Renamed by reader",
      status: "in-progress",
      subStatus: "in_work",
      assigneeCompleted: false,
      takenToWorkAt: "2026-07-02T02:00:00.000Z",
      takenToWorkBy: "Reader",
    }));
    await assertFails(reader.collection("tasks").doc("t1").update({
      deadline: "2099-01-01",
      status: "in-progress",
      subStatus: "in_work",
      assigneeCompleted: false,
    }));
    await assertFails(reader.collection("tasks").doc("t1").update({
      assignee: "Someone Else",
      assigneeEmail: "someone@else.com",
      assigneeIds: ["reader2"],
      status: "in-progress",
      subStatus: "in_work",
      assigneeCompleted: false,
    }));
    await assertFails(reader.collection("tasks").doc("t1").update({
      description: "Rewritten description",
      status: "in-progress",
      subStatus: "in_work",
      assigneeCompleted: false,
    }));
  });

  it("legacy-shaped data (organizationId:null orgRole:null user, task without assigneeIds/organizationId) still allows the assignee to take the task into work", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("legacyReader1").set({
        role: "reader",
        organizationId: null,
        orgRole: null,
        allowedProjects: [],
      });
      await ctx.firestore().collection("projects").doc("legacy-p1").set({ name: "Legacy Project" });
      await ctx.firestore().collection("tasks").doc("legacy-t1").set({
        projectId: "legacy-p1",
        title: "Legacy task",
        assignee: "Legacy Reader",
        assigneeEmail: "legacyreader1@example.com",
        status: "in-progress",
        subStatus: "assigned",
        assigneeCompleted: false,
      });
    });

    const legacyReader = testEnv.authenticatedContext("legacyReader1").firestore();
    await assertSucceeds(legacyReader.collection("tasks").doc("legacy-t1").update({
      status: "in-progress",
      subStatus: "in_work",
      assigneeCompleted: false,
      takenToWorkAt: "2026-07-02T00:00:00.000Z",
      takenToWorkBy: "Legacy Reader",
      completedAt: null,
      completionComment: null,
      completionProof: null,
      completionProofs: null,
      completedBy: null,
      archivedAt: null,
      archivedBy: null,
    }));
  });

  it("denies a member of another org from reading a project/task by direct get (cross-tenant)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await seedOrgUser(ctx, "member1", { organizationId: "org-1", orgRole: "employee" });
      await seedOrgUser(ctx, "outsider1", { organizationId: "org-2", orgRole: "employee" });
      await ctx.firestore().collection("projects").doc("p-a").set({ name: "A", organizationId: "org-1" });
      await ctx.firestore().collection("tasks").doc("t-a").set({
        projectId: "p-a", organizationId: "org-1", title: "Secret", status: "in-progress", subStatus: "assigned",
      });
    });

    const member = testEnv.authenticatedContext("member1").firestore();
    const outsider = testEnv.authenticatedContext("outsider1").firestore();

    // Same-org member can read.
    await assertSucceeds(member.collection("projects").doc("p-a").get());
    await assertSucceeds(member.collection("tasks").doc("t-a").get());

    // Member of a different org cannot read either by direct id.
    await assertFails(outsider.collection("projects").doc("p-a").get());
    await assertFails(outsider.collection("tasks").doc("t-a").get());
  });
});
