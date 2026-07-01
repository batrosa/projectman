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

  it("allows a user to self-join an org with orgRole=employee only", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("newbie").set({ role: "reader" });
      await ctx.firestore().collection("organizations").doc("some-org").set({ ownerId: "owner1", name: "Some Org" });
    });

    const newbie = testEnv.authenticatedContext("newbie").firestore();
    await assertSucceeds(
      newbie.collection("users").doc("newbie").update({
        organizationId: "some-org",
        orgRole: "employee",
      })
    );
  });

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
