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

    it("allows the real createOrganization() write shape (organizationId + orgRole:'owner' + email + displayName) when the caller actually owns the referenced org", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("founder").set({ role: "reader" });
        await ctx.firestore().collection("organizations").doc("new-org").set({ ownerId: "founder", name: "New Org" });
      });

      const founder = testEnv.authenticatedContext("founder").firestore();
      await assertSucceeds(
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

    it("allows the real leaveOrganization() write shape (organizationId + orgRole both set to null)", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("leaver").set({
          role: "reader", organizationId: "some-org", orgRole: "employee",
        });
      });

      const leaver = testEnv.authenticatedContext("leaver").firestore();
      await assertSucceeds(
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

    it("allows the real createOrganization() write shape via create() when the caller actually owns the referenced org and their user doc doesn't exist yet", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("organizations").doc("new-org-2").set({ ownerId: "founder2", name: "New Org 2" });
      });

      const founder2 = testEnv.authenticatedContext("founder2").firestore();
      await assertSucceeds(
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

    it("allows a plain employee to bump membersCount by exactly 1 on the org they just joined (real joinOrganization() follow-up write)", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("joiner").set({ role: "reader", organizationId: "some-org", orgRole: "employee" });
        await ctx.firestore().collection("organizations").doc("some-org").set({ ownerId: "owner1", name: "Some Org", membersCount: 1 });
      });

      const joiner = testEnv.authenticatedContext("joiner").firestore();
      await assertSucceeds(
        joiner.collection("organizations").doc("some-org").update({ membersCount: 2 })
      );
    });

    it("blocks a plain employee from changing membersCount by more than 1 or touching other org fields", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("joiner2").set({ role: "reader", organizationId: "some-org", orgRole: "employee" });
        await ctx.firestore().collection("organizations").doc("some-org").set({ ownerId: "owner1", name: "Some Org", membersCount: 1 });
      });

      const joiner2 = testEnv.authenticatedContext("joiner2").firestore();
      await assertFails(
        joiner2.collection("organizations").doc("some-org").update({ membersCount: 5 })
      );
      await assertFails(
        joiner2.collection("organizations").doc("some-org").update({ membersCount: 2, name: "Renamed" })
      );
    });

    it("allows owner but blocks admin from deleting the organization", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("owner1").set({ role: "reader", organizationId: "org-owned", orgRole: "owner" });
        await ctx.firestore().collection("users").doc("admin1").set({ role: "reader", organizationId: "org-admin", orgRole: "admin" });
        await ctx.firestore().collection("organizations").doc("org-owned").set({ ownerId: "owner1", name: "Owned Org" });
        await ctx.firestore().collection("organizations").doc("org-admin").set({ ownerId: "owner2", name: "Admin Org" });
      });

      const owner = testEnv.authenticatedContext("owner1").firestore();
      const admin = testEnv.authenticatedContext("admin1").firestore();
      await assertSucceeds(owner.collection("organizations").doc("org-owned").delete());
      await assertFails(admin.collection("organizations").doc("org-admin").delete());
    });
  });

  describe("organizations read (invite-code enumeration closed)", () => {
    it("lets a member GET their own organization", async () => {
      await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await ctx.firestore().collection("users").doc("m1").set({ organizationId: "orgA", orgRole: "employee" });
        await ctx.firestore().collection("organizations").doc("orgA").set({ ownerId: "o", name: "Org A", inviteCode: "CODEA" });
      });
      const m1 = testEnv.authenticatedContext("m1").firestore();
      await assertSucceeds(m1.collection("organizations").doc("orgA").get());
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
});
