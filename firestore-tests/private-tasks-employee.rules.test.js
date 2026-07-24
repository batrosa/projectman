import { describe, it, beforeAll, afterAll } from "vitest";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { serverTimestamp } from "@firebase/firestore";
import { readFileSync } from "node:fs";

let testEnv;

beforeAll(async () => {
  testEnv = await initializeTestEnvironment({
    projectId: "projectman-rules-private-employee",
    firestore: { rules: readFileSync("firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
  });
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await db.collection("users").doc("emp1").set({ role: "reader", organizationId: "org-1", orgRole: "employee" });
    await db.collection("users").doc("admin1").set({ role: "reader", organizationId: "org-1", orgRole: "admin" });
    await db.collection("projects").doc("p-1").set({ name: "Проект", organizationId: "org-1" });
  });
});

afterAll(async () => {
  await testEnv.cleanup();
});

// Поля ровно как собирает web createTask(isPrivate=true)
function privateTaskDoc(creatorUid, { assigneeIds = [], coCreatorIds = [] } = {}) {
  return {
    projectId: "p-1",
    organizationId: "org-1",
    title: "Приватная",
    description: "",
    assignee: "Не назначен",
    assigneeEmail: "",
    assigneeIds,
    deadline: "2026-08-01",
    status: "in-progress",
    subStatus: "assigned",
    assigneeCompleted: false,
    assignedAt: serverTimestamp(),
    attachments: [],
    createdAt: serverTimestamp(),
    createdBy: "Иван Исполнитель",
    createdByEmail: "emp@example.com",
    createdByUid: creatorUid,
    coCreatorIds,
    coCreators: "",
    isPrivate: true,
    viewerIds: [...new Set([creatorUid, ...assigneeIds, ...coCreatorIds])],
  };
}

describe("privateTasks: создание исполнителем (прод-баг «ошибка у исполнителя»)", () => {
  it("исполнитель создаёт приватную задачу на себя", async () => {
    const emp = testEnv.authenticatedContext("emp1").firestore();
    await assertSucceeds(
      emp.collection("privateTasks").add(privateTaskDoc("emp1", { assigneeIds: ["emp1"] }))
    );
  });

  it("исполнитель создаёт приватную задачу с чужим ответственным и доп. постановщиком", async () => {
    const emp = testEnv.authenticatedContext("emp1").firestore();
    await assertSucceeds(
      emp.collection("privateTasks").add(privateTaskDoc("emp1", { assigneeIds: ["admin1"], coCreatorIds: ["u-x"] }))
    );
  });

  it("админ создаёт приватную задачу", async () => {
    const admin = testEnv.authenticatedContext("admin1").firestore();
    await assertSucceeds(
      admin.collection("privateTasks").add(privateTaskDoc("admin1", { assigneeIds: ["emp1"] }))
    );
  });

  it("нельзя создать приватную задачу от чужого имени", async () => {
    const emp = testEnv.authenticatedContext("emp1").firestore();
    await assertFails(
      emp.collection("privateTasks").add(privateTaskDoc("admin1", { assigneeIds: ["emp1"] }))
    );
  });
});
