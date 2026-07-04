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

// agentNotifications пишет ТОЛЬКО сервер (Admin SDK — сид ниже это моделирует).
// Клиент читает/помечает прочитанным только СВОИ записи и только ТЕКУЩЕЙ
// организации: uid переживает смену организации, поэтому без org-проверки
// уведомления прежней организации «переезжали» за пользователем (прод-баг).
describe("agentNotifications — owner-read, scoped to the CURRENT organization", () => {
  it("recipient reads their note in THEIR CURRENT org; someone else's note is denied", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("u1").set({ organizationId: "org-1", orgRole: "employee" });
      await ctx.firestore().collection("users").doc("u2").set({ organizationId: "org-1", orgRole: "employee" });
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

  it("ORG SWITCH: notes from the PREVIOUS org become invisible (get and list)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      // u3 moved from org-old to org-new; an old note stays keyed to their uid.
      await ctx.firestore().collection("users").doc("u3").set({ organizationId: "org-new", orgRole: "employee" });
      await ctx.firestore().collection("agentNotifications").doc("n-old-org").set({
        uid: "u3", organizationId: "org-old", type: "overdue",
        text: "Из прежней организации", createdAt: new Date(), readAt: null,
      });
      await ctx.firestore().collection("agentNotifications").doc("n-new-org").set({
        uid: "u3", organizationId: "org-new", type: "deadline_tomorrow",
        text: "Из текущей организации", createdAt: new Date(), readAt: null,
      });
    });

    const u3 = testEnv.authenticatedContext("u3").firestore();
    // Точечное чтение старой записи — запрещено.
    await assertFails(u3.collection("agentNotifications").doc("n-old-org").get());
    // Запись текущей орг — доступна.
    await assertSucceeds(u3.collection("agentNotifications").doc("n-new-org").get());
    // Лента: запрос обязан скоупиться по uid И organizationId (как клиент).
    await assertSucceeds(
      u3.collection("agentNotifications")
        .where("uid", "==", "u3")
        .where("organizationId", "==", "org-new")
        .get()
    );
    // Запрос по одному uid (старый клиент) — отклоняется целиком: он мог бы
    // вернуть записи чужой (прежней) организации.
    await assertFails(u3.collection("agentNotifications").where("uid", "==", "u3").get());
    // И запрос, явно нацеленный на СТАРУЮ организацию, — тоже отклоняется.
    await assertFails(
      u3.collection("agentNotifications")
        .where("uid", "==", "u3")
        .where("organizationId", "==", "org-old")
        .get()
    );
  });

  it("client cannot CREATE a notification — even addressed to themselves in their own org", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("u1").set({ organizationId: "org-1", orgRole: "employee" });
    });
    const u1 = testEnv.authenticatedContext("u1").firestore();
    await assertFails(u1.collection("agentNotifications").doc("n-forged").set({
      uid: "u1", organizationId: "org-1", type: "overdue",
      text: "Подделка", createdAt: new Date(), readAt: null,
    }));
  });

  it("mark-read: own note in current org — ok (readAt only); other fields, foreign-org note, others' notes — denied", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("u1").set({ organizationId: "org-1", orgRole: "employee" });
      await ctx.firestore().collection("users").doc("u2").set({ organizationId: "org-1", orgRole: "employee" });
      await ctx.firestore().collection("agentNotifications").doc("n-read").set({
        uid: "u1", organizationId: "org-1", type: "overdue",
        text: "Оригинал", createdAt: new Date(), readAt: null,
      });
      await ctx.firestore().collection("agentNotifications").doc("n-read-oldorg").set({
        uid: "u1", organizationId: "org-old", type: "overdue",
        text: "Старая орг", createdAt: new Date(), readAt: null,
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
    await assertFails(u1.collection("agentNotifications").doc("n-read-oldorg").update({ readAt: new Date() }));
    await assertFails(u1.collection("agentNotifications").doc("n-read-2").update({ readAt: new Date() }));
  });

  it("client cannot DELETE a notification (deletion is server-side)", async () => {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      await ctx.firestore().collection("users").doc("u1").set({ organizationId: "org-1", orgRole: "employee" });
      await ctx.firestore().collection("agentNotifications").doc("n-del").set({
        uid: "u1", organizationId: "org-1", type: "overdue",
        text: "X", createdAt: new Date(), readAt: null,
      });
    });
    const u1 = testEnv.authenticatedContext("u1").firestore();
    await assertFails(u1.collection("agentNotifications").doc("n-del").delete());
  });
});
