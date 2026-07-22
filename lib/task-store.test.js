import { describe, expect, it, vi } from "vitest";
import {
  PRIVATE_TASKS_COLLECTION,
  PUBLIC_TASKS_COLLECTION,
  isPrivateTaskParticipant,
  canCallerReadPrivateTask,
  loadTaskDocumentForCaller,
  privateTaskViewerIds,
} from "./task-store.js";

describe("task-store private task boundary", () => {
  it("derives a unique audience from creator, assignees and co-creators", () => {
    expect(privateTaskViewerIds("creator", ["worker", "worker"], ["reviewer", "creator"]))
      .toEqual(["creator", "worker", "reviewer"]);
  });

  it("recognizes only explicit private-task participants", () => {
    const task = { viewerIds: ["creator", "worker"] };
    expect(isPrivateTaskParticipant(task, "worker")).toBe(true);
    expect(isPrivateTaskParticipant(task, "owner-who-is-not-involved")).toBe(false);
  });

  it("lets the organization owner read every private task without widening admin access", () => {
    const task = { organizationId: "org-1", viewerIds: ["creator"] };
    expect(canCallerReadPrivateTask(task, { uid: "owner", orgRole: "owner", organizationId: "org-1" })).toBe(true);
    expect(canCallerReadPrivateTask(task, { uid: "admin", orgRole: "admin", organizationId: "org-1" })).toBe(false);
  });

  it("marks a private task forbidden when Admin SDK loading would bypass rules", async () => {
    const privateSnapshot = {
      exists: true,
      ref: { path: `${PRIVATE_TASKS_COLLECTION}/private-1` },
      data: () => ({ viewerIds: ["creator"] }),
    };
    const db = {
      collection: vi.fn((name) => ({
        doc: () => ({
          get: vi.fn(async () => name === PUBLIC_TASKS_COLLECTION
            ? { exists: false }
            : privateSnapshot),
        }),
      })),
    };

    const loaded = await loadTaskDocumentForCaller(db, "private-1", null, "unrelated-owner");
    expect(loaded.collectionName).toBe(PRIVATE_TASKS_COLLECTION);
    expect(loaded.forbidden).toBe(true);
  });
});
