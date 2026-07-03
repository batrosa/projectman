import { describe, it, beforeAll, afterAll } from "vitest";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { readFileSync } from "node:fs";

let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "projectman-rules-agentnotes",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

// agentNotifications is written ONLY by the server (Admin SDK bypasses rules —
// seeding below via withSecurityRulesDisabled models that). The client may
// read its own entries and mark them read; nothing else.
describe("agentNotifications — server-write, owner-read feed", () => {
  it("recipient reads THEIR OWN notification; someone else's is denied", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("agentNotifications").doc("n-mine").set({
        uid: "u1", organizationId: "org-1", taskId: "t1", projectId: "p1",
        type: "overdue", text: "Задача просрочена", createdAt: new Date(), readAt: null,
      });
      await ctx.firestore().collection("agentNotifications").doc("n-theirs").set({
        uid: "u2", organizationId: "org-1", taskId: "t2", projectId: "p1",
        type: "overdue", text: "Чужое", createdAt: new Date(), readAt: null,
      });
    });

    const u1 = testEnv.authenticatedContext("u1").firestore();
    await assertSucceeds(u1.collection("agentNotifications").doc("n-mine").get());
    await assertFails(u1.collection("agentNotifications").doc("n-theirs").get());
  });

  it("recipient can LIST their own feed (where uid == mine)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("agentNotifications").doc("n-list-1").set({
        uid: "u3", organizationId: "org-1", type: "deadline_tomorrow",
        text: "Остался 1 день", createdAt: new Date(), readAt: null,
      });
    });
    const u3 = testEnv.authenticatedContext("u3").firestore();
    await assertSucceeds(u3.collection("agentNotifications").where("uid", "==", "u3").get());
    // A query NOT scoped to the caller must be rejected wholesale.
    await assertFails(u3.collection("agentNotifications").get());
  });

  it("client cannot CREATE a notification — even addressed to themselves", async () => {
    const u1 = testEnv.authenticatedContext("u1").firestore();
    await assertFails(u1.collection("agentNotifications").doc("n-forged").set({
      uid: "u1", organizationId: "org-1", type: "overdue",
      text: "Подделка", createdAt: new Date(), readAt: null,
    }));
  });

  it("recipient can mark THEIR notification read (readAt only); other fields / others' docs are denied", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("agentNotifications").doc("n-read").set({
        uid: "u1", organizationId: "org-1", type: "overdue",
        text: "Оригинал", createdAt: new Date(), readAt: null,
      });
      await ctx.firestore().collection("agentNotifications").doc("n-read-2").set({
        uid: "u2", organizationId: "org-1", type: "overdue",
        text: "Чужое", createdAt: new Date(), readAt: null,
      });
    });

    const u1 = testEnv.authenticatedContext("u1").firestore();
    await assertSucceeds(u1.collection("agentNotifications").doc("n-read").update({ readAt: new Date() }));
    await assertFails(u1.collection("agentNotifications").doc("n-read").update({ text: "Переписал" }));
    await assertFails(u1.collection("agentNotifications").doc("n-read").update({ uid: "u2", readAt: new Date() }));
    await assertFails(u1.collection("agentNotifications").doc("n-read-2").update({ readAt: new Date() }));
  });

  it("client cannot DELETE their notification (history is server-owned)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("agentNotifications").doc("n-del").set({
        uid: "u1", organizationId: "org-1", type: "overdue",
        text: "X", createdAt: new Date(), readAt: null,
      });
    });
    const u1 = testEnv.authenticatedContext("u1").firestore();
    await assertFails(u1.collection("agentNotifications").doc("n-del").delete());
  });
});
