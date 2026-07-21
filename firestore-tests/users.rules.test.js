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

  it("blocks a user from self-writing server-owned Telegram linkage fields", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("u3").set({
        role: "reader",
        organizationId: "org-1",
        orgRole: "employee",
        telegramChatId: "111",
      });
    });

    const u3 = testEnv.authenticatedContext("u3").firestore();
    // These fields are bound server-side during Telegram login/linking; a
    // client must not be able to point notifications at an arbitrary chat.
    await assertFails(u3.collection("users").doc("u3").update({ telegramId: "999" }));
    await assertFails(u3.collection("users").doc("u3").update({ telegramChatId: "999" }));
    await assertFails(u3.collection("users").doc("u3").update({ telegramUsername: "attacker" }));
    await assertFails(u3.collection("users").doc("u3").update({ telegramLinkedAt: "2026-07-21" }));
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
    // displayName/profilePhotoUrl/profileCompleted/lastLoginAt are legitimate
    // self-profile writes and must stay allowed (they are NOT in the locked set).
    await assertSucceeds(u2.collection("users").doc("u2").update({
      displayName: "New Name",
      profilePhotoUrl: "https://example.com/p.png",
      profileCompleted: true,
      lastLoginAt: "2026-07-02T10:00:00.000Z",
    }));
  });

  it("blocks direct client orgRole/allowedProjects manager writes; api/org is the only path", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("owner2").set({
        role: "reader", organizationId: "org-2", orgRole: "owner",
      });
      await ctx.firestore().collection("users").doc("emp2").set({
        role: "reader", organizationId: "org-2", orgRole: "employee",
      });
    });

    const owner2 = testEnv.authenticatedContext("owner2").firestore();
    await assertFails(owner2.collection("users").doc("emp2").update({
      orgRole: "moderator",
      allowedProjects: ["p1"],
    }));
  });
});

describe("users doc — reads are scoped to the same organization", () => {
  it("lets a member read another member of the SAME org (assignee list), but NOT a member of another org", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("a1").set({ organizationId: "orgA", orgRole: "employee", email: "a1@x.com" });
      await ctx.firestore().collection("users").doc("a2").set({ organizationId: "orgA", orgRole: "employee", email: "a2@x.com", telegramChatId: "111" });
      await ctx.firestore().collection("users").doc("b1").set({ organizationId: "orgB", orgRole: "employee", email: "b1@x.com", telegramChatId: "222" });
    });

    const a1 = testEnv.authenticatedContext("a1").firestore();
    await assertSucceeds(a1.collection("users").doc("a2").get()); // same org → ok
    await assertFails(a1.collection("users").doc("b1").get());    // other org → denied (no cross-tenant PII)
  });

  it("always lets a user read their OWN doc, even with no organization", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("solo").set({ organizationId: null, orgRole: null, email: "solo@x.com" });
      await ctx.firestore().collection("users").doc("member").set({ organizationId: "orgA", orgRole: "employee" });
    });

    const solo = testEnv.authenticatedContext("solo").firestore();
    await assertSucceeds(solo.collection("users").doc("solo").get()); // self → ok
    await assertFails(solo.collection("users").doc("member").get());  // no org → can't read others
  });

  it("blocks a totally unrelated authed user from reading an org member's doc", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("victim").set({ organizationId: "orgA", orgRole: "owner", telegramChatId: "999", email: "victim@x.com" });
    });
    // "stranger" has no user doc at all → myOrgId() resolves to null → denied.
    const stranger = testEnv.authenticatedContext("stranger").firestore();
    await assertFails(stranger.collection("users").doc("victim").get());
  });
});

describe("users/{uid}/devices — push-токены строго владельца (roadmap Этап 3)", () => {
  it("owner of the account can write and read his own device token", async () => {
    const me = testEnv.authenticatedContext("dev-owner").firestore();
    await assertSucceeds(me.collection("users").doc("dev-owner").collection("devices").doc("iphone-1").set({
      fcmToken: "token-abc",
      platform: "ios",
    }));
    await assertSucceeds(me.collection("users").doc("dev-owner").collection("devices").doc("iphone-1").get());
    await assertSucceeds(me.collection("users").doc("dev-owner").collection("devices").doc("iphone-1").delete());
  });

  it("another user (even same org) can neither read nor write someone else's device tokens", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("dev-victim").set({ organizationId: "orgA", orgRole: "employee" });
      await ctx.firestore().collection("users").doc("dev-mate").set({ organizationId: "orgA", orgRole: "owner" });
      await ctx.firestore().collection("users").doc("dev-victim").collection("devices").doc("iphone-1").set({ fcmToken: "secret-token", platform: "ios" });
    });

    const mate = testEnv.authenticatedContext("dev-mate").firestore();
    await assertFails(mate.collection("users").doc("dev-victim").collection("devices").doc("iphone-1").get());
    await assertFails(mate.collection("users").doc("dev-victim").collection("devices").doc("iphone-1").set({ fcmToken: "hijack" }));
    await assertFails(mate.collection("users").doc("dev-victim").collection("devices").doc("iphone-1").delete());

    const stranger = testEnv.authenticatedContext("dev-stranger").firestore();
    await assertFails(stranger.collection("users").doc("dev-victim").collection("devices").doc("iphone-1").get());
  });
});
