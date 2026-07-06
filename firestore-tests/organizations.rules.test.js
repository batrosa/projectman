import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";

let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "projectman-rules-test",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

describe("organizations privilege escalation", () => {
  describe("users update path", () => {
    it("blocks a user from self-granting orgRole=owner on an arbitrary org", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("attacker").set({ role: "reader" });
        await ctx.firestore().collection("organizations").doc("victim-org").set({ ownerId: "victim", name: "Victim Org" });
      });

      const attacker = testEnv.authenticatedContext("attacker").firestore();
      await assertFails(
        attacker.collection("users").doc("attacker").update({
          organizationId: "victim-org",
          orgRole: "owner",
        })
      );
    });

    it("blocks client-side self-join: a user cannot set their own organizationId (join is server-only now)", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("newbie").set({ role: "reader" });
        await ctx.firestore().collection("organizations").doc("some-org").set({ ownerId: "owner1", name: "Some Org", inviteCode: "ABC123" });
      });

      const newbie = testEnv.authenticatedContext("newbie").firestore();
      // Direct self-assignment of organizationId is denied — joining must go
      // through api/join-org (Admin SDK), which validates the invite code.
      await assertFails(
        newbie.collection("users").doc("newbie").update({
          organizationId: "some-org",
          orgRole: "employee",
        })
      );
    });

    it("blocks a client self-service org create via update (organizationId + orgRole:'owner') — create is server-only now (api/org)", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("founder").set({ role: "reader" });
        await ctx.firestore().collection("organizations").doc("new-org").set({ ownerId: "founder", name: "New Org" });
      });

      const founder = testEnv.authenticatedContext("founder").firestore();
      // Even the real owner can no longer self-write org membership from the
      // client — api/org 'create' assigns organizationId+orgRole server-side.
      await assertFails(
        founder.collection("users").doc("founder").update({
          organizationId: "new-org",
          orgRole: "owner",
          email: "founder@example.com",
          displayName: "Founder",
        })
      );
    });

    it("blocks self-granting orgRole:'owner' by pointing organizationId at an org the caller does not own", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("faker").set({ role: "reader" });
        await ctx.firestore().collection("organizations").doc("real-org").set({ ownerId: "realowner", name: "Real Org" });
      });

      const faker = testEnv.authenticatedContext("faker").firestore();
      await assertFails(
        faker.collection("users").doc("faker").update({
          organizationId: "real-org",
          orgRole: "owner",
        })
      );
    });

    it("blocks a client-side self-leave (organizationId/orgRole → null) — leaving is server-only now (api/org)", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("leaver").set({
          role: "reader", organizationId: "some-org", orgRole: "employee",
        });
      });

      const leaver = testEnv.authenticatedContext("leaver").firestore();
      // Direct client leave used to be allowed (isSelfServiceOrgLeave); it's
      // removed so it can't skip the membersCount decrement / allowedProjects
      // cleanup that api/org 'leave' does.
      await assertFails(
        leaver.collection("users").doc("leaver").update({ organizationId: null, orgRole: null })
      );
    });
  });

  describe("users create path", () => {
    it("blocks self-granting orgRole:'owner' via create() when the user doc doesn't exist yet (the bypass code-quality review found)", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("organizations").doc("victim-org").set({ ownerId: "victim", name: "Victim Org" });
      });

      const attacker = testEnv.authenticatedContext("attacker-no-doc").firestore();
      await assertFails(
        attacker.collection("users").doc("attacker-no-doc").set({
          role: "reader", organizationId: "victim-org", orgRole: "owner",
        })
      );
    });

    it("blocks a client self-service org create via create() (fresh user doc carrying org fields) — create is server-only now", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("organizations").doc("new-org-2").set({ ownerId: "founder2", name: "New Org 2" });
      });

      const founder2 = testEnv.authenticatedContext("founder2").firestore();
      // A fresh user doc may not carry org fields — membership is granted
      // server-side (api/org), so this create is rejected.
      await assertFails(
        founder2.collection("users").doc("founder2").set({
          organizationId: "new-org-2", orgRole: "owner", email: "founder2@example.com", displayName: "Founder 2",
        })
      );
    });
  });

  describe("organizations doc", () => {
    it("blocks reading/writing organizations doc fields by non-owner non-admin", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("bystander").set({ role: "reader", orgRole: "employee", organizationId: "some-org" });
        await ctx.firestore().collection("organizations").doc("some-org").set({ ownerId: "owner1", name: "Some Org" });
      });

      const bystander = testEnv.authenticatedContext("bystander").firestore();
      await assertFails(
        bystander.collection("organizations").doc("some-org").update({ name: "Hijacked" })
      );
    });

    it("blocks any plain member from changing membersCount — it is server-only (Admin SDK) now", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("joiner").set({ role: "reader", organizationId: "some-org", orgRole: "employee" });
        await ctx.firestore().collection("organizations").doc("some-org").set({ ownerId: "owner1", name: "Some Org", membersCount: 1 });
      });

      const joiner = testEnv.authenticatedContext("joiner").firestore();
      // ±1 used to be allowed via isMemberCountStep — that client rule is removed;
      // join/leave/remove all change membersCount server-side via the Admin SDK.
      await assertFails(joiner.collection("organizations").doc("some-org").update({ membersCount: 2 }));
      await assertFails(joiner.collection("organizations").doc("some-org").update({ membersCount: 0 }));
      await assertFails(joiner.collection("organizations").doc("some-org").update({ membersCount: 5 }));
    });

    it("blocks client-side org deletion entirely — deletion is server-only (api/org cascade)", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("owner1").set({ role: "reader", organizationId: "org-owned", orgRole: "owner" });
        await ctx.firestore().collection("users").doc("admin1").set({ role: "reader", organizationId: "org-admin", orgRole: "admin" });
        await ctx.firestore().collection("organizations").doc("org-owned").set({ ownerId: "owner1", name: "Owned Org" });
        await ctx.firestore().collection("organizations").doc("org-admin").set({ ownerId: "owner2", name: "Admin Org" });
      });

      const owner = testEnv.authenticatedContext("owner1").firestore();
      const admin = testEnv.authenticatedContext("admin1").firestore();
      // Even the owner can't delete the org doc directly now — api/org 'deleteOrg'
      // (Admin SDK) does it, so the projects/tasks/files cascade + member cleanup run.
      await assertFails(owner.collection("organizations").doc("org-owned").delete());
      await assertFails(admin.collection("organizations").doc("org-admin").delete());
    });

    it("blocks reassigning ownerId (no silent org takeover) but allows editing other fields", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("adm").set({ organizationId: "orgX", orgRole: "admin" });
        await ctx.firestore().collection("users").doc("ownr").set({ organizationId: "orgX", orgRole: "owner" });
        await ctx.firestore().collection("organizations").doc("orgX").set({ ownerId: "ownr", name: "Org X", membersCount: 2 });
      });
      const adm = testEnv.authenticatedContext("adm").firestore();
      const ownr = testEnv.authenticatedContext("ownr").firestore();
      await assertFails(adm.collection("organizations").doc("orgX").update({ ownerId: "adm" }));      // admin can't take over
      await assertFails(ownr.collection("organizations").doc("orgX").update({ ownerId: "someone" })); // even owner can't reassign via client
      await assertSucceeds(ownr.collection("organizations").doc("orgX").update({ name: "Renamed" })); // name edit still works
      // Server-managed fields (incl. settings — settings.maxUsers self-bypass)
      // can no longer be written from the client; only api/org (Admin SDK).
      await assertFails(ownr.collection("organizations").doc("orgX").update({ settings: { maxUsers: 999 } }));
      await assertFails(ownr.collection("organizations").doc("orgX").update({ inviteCode: "HACKED" }));
      await assertFails(ownr.collection("organizations").doc("orgX").update({ plan: "enterprise" }));
      await assertFails(ownr.collection("organizations").doc("orgX").update({ membersCount: 999 }));
    });

    it("blocks a client from creating an organizations doc directly (create is server-only)", async () => {
      const creator = testEnv.authenticatedContext("creator1").firestore();
      // Even naming yourself owner no longer works — api/org is the only path.
      await assertFails(
        creator.collection("organizations").doc("brand-new-org").set({
          ownerId: "creator1", name: "Mine", inviteCode: "MINE01", plan: "enterprise", membersCount: 1,
        })
      );
    });
  });

  describe("organizations read (invite-code enumeration closed)", () => {
    it("blocks plain members from direct GET of their organization doc (inviteCode stays server-filtered)", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("m1").set({ organizationId: "orgA", orgRole: "employee" });
        await ctx.firestore().collection("organizations").doc("orgA").set({ ownerId: "o", name: "Org A", inviteCode: "CODEA" });
      });
      const m1 = testEnv.authenticatedContext("m1").firestore();
      await assertFails(m1.collection("organizations").doc("orgA").get());
    });

    it("lets owner/admin GET their organization doc for organization management", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("own").set({ organizationId: "orgA-admin", orgRole: "owner" });
        await ctx.firestore().collection("users").doc("adm").set({ organizationId: "orgA-admin", orgRole: "admin" });
        await ctx.firestore().collection("organizations").doc("orgA-admin").set({ ownerId: "own", name: "Org A", inviteCode: "CODEA" });
      });
      const own = testEnv.authenticatedContext("own").firestore();
      const adm = testEnv.authenticatedContext("adm").firestore();
      await assertSucceeds(own.collection("organizations").doc("orgA-admin").get());
      await assertSucceeds(adm.collection("organizations").doc("orgA-admin").get());
    });

    it("blocks GET of an organization the caller is NOT a member of", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("out1").set({ organizationId: "orgB", orgRole: "employee" });
        await ctx.firestore().collection("organizations").doc("orgA2").set({ ownerId: "o", name: "Org A2", inviteCode: "SECRET" });
      });
      const out1 = testEnv.authenticatedContext("out1").firestore();
      await assertFails(out1.collection("organizations").doc("orgA2").get());
    });

    it("blocks LISTING / querying organizations (no harvesting invite codes)", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("snoop").set({ organizationId: "orgC", orgRole: "employee" });
        await ctx.firestore().collection("organizations").doc("orgC").set({ ownerId: "o", name: "Org C", inviteCode: "C1" });
        await ctx.firestore().collection("organizations").doc("orgD").set({ ownerId: "o2", name: "Org D", inviteCode: "D1" });
      });
      const snoop = testEnv.authenticatedContext("snoop").firestore();
      await assertFails(snoop.collection("organizations").get());
      await assertFails(snoop.collection("organizations").where("inviteCode", "==", "D1").get());
    });
  });

  describe("audit logs", () => {
    it("blocks client-side audit log reads and writes even for an organization owner", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("audit-owner").set({
          role: "reader",
          organizationId: "audit-org",
          orgRole: "owner",
        });
        await ctx.firestore().collection("auditLogs").doc("log-1").set({
          action: "org.delete",
          organizationId: "audit-org",
          actorUid: "audit-owner",
        });
      });

      const owner = testEnv.authenticatedContext("audit-owner").firestore();
      await assertFails(owner.collection("auditLogs").doc("log-1").get());
      await assertFails(owner.collection("auditLogs").add({
        action: "org.delete",
        organizationId: "audit-org",
        actorUid: "audit-owner",
      }));
    });
  });
});
