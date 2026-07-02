import { describe, it, beforeAll, afterAll } from "vitest";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";

let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "projectman-rules-users",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

describe("users doc — XP/stats are server-only", () => {
  it("blocks a user from self-crediting XP / stats (totalXP, level, counts)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("u1").set({
        role: "reader",
        organizationId: "org-1",
        orgRole: "employee",
        displayName: "User One",
        totalXP: 0,
        level: 1,
        completedTasksCount: 0,
      });
    });

    const u1 = testEnv.authenticatedContext("u1").firestore();
    // Self-crediting any locked field is rejected.
    await assertFails(u1.collection("users").doc("u1").update({ totalXP: 9999 }));
    await assertFails(u1.collection("users").doc("u1").update({ level: 7 }));
    await assertFails(u1.collection("users").doc("u1").update({ completedTasksCount: 500 }));
    await assertFails(u1.collection("users").doc("u1").update({ onTimeTasksCount: 500 }));
    await assertFails(u1.collection("users").doc("u1").update({ noRevisionTasksCount: 500 }));
  });

  it("blocks a moderator (and owner) from writing ANOTHER user's stats via the client", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("mod").set({
        role: "reader", organizationId: "org-1", orgRole: "moderator", allowedProjects: [],
      });
      await ctx.firestore().collection("users").doc("owner").set({
        role: "reader", organizationId: "org-1", orgRole: "owner",
      });
      await ctx.firestore().collection("users").doc("emp").set({
        role: "reader", organizationId: "org-1", orgRole: "employee", totalXP: 0, level: 1,
      });
    });

    const mod = testEnv.authenticatedContext("mod").firestore();
    const owner = testEnv.authenticatedContext("owner").firestore();
    // Manager-writes-stats (isOrgUserStatsUpdate) was removed — only the server may.
    await assertFails(mod.collection("users").doc("emp").update({ totalXP: 100 }));
    await assertFails(owner.collection("users").doc("emp").update({ totalXP: 100 }));
  });

  it("still lets a user edit their own non-restricted profile fields (lock didn't over-block)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("u2").set({
        role: "reader", organizationId: "org-1", orgRole: "employee", displayName: "Old",
      });
    });

    const u2 = testEnv.authenticatedContext("u2").firestore();
    await assertSucceeds(u2.collection("users").doc("u2").update({
      displayName: "New Name",
      profilePhotoUrl: "https://example.com/p.png",
    }));
  });

  it("still lets an owner change another member's orgRole/allowedProjects (manager update intact)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("owner2").set({
        role: "reader", organizationId: "org-2", orgRole: "owner",
      });
      await ctx.firestore().collection("users").doc("emp2").set({
        role: "reader", organizationId: "org-2", orgRole: "employee",
      });
    });

    const owner2 = testEnv.authenticatedContext("owner2").firestore();
    await assertSucceeds(owner2.collection("users").doc("emp2").update({
      orgRole: "moderator",
      allowedProjects: ["p1"],
    }));
  });
});
