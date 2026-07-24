import { describe, expect, it } from "vitest";
import {
  accountDeletionPreview,
  participantPatch,
} from "./account-deletion.js";

function snapshot(entries) {
  return {
    size: entries.length,
    docs: entries.map(([id, data]) => ({ id, data: () => data })),
  };
}

function fakeDb(collections) {
  return {
    collection(name) {
      const entries = Object.entries(collections[name] || {});
      return {
        where(field, op, value) {
          if (op !== "==") throw new Error("unexpected operator");
          return {
            async get() {
              return snapshot(entries.filter(([, data]) => data[field] === value));
            },
          };
        },
      };
    },
  };
}

describe("account deletion invariants", () => {
  it("includes every organization owned by ownerId or owner membership", async () => {
    const db = fakeDb({
      organizations: {
        "org-direct": { ownerId: "owner-1" },
        "org-membership": { ownerId: "legacy-owner" },
      },
      organizationMemberships: {
        one: { organizationId: "org-direct", userId: "owner-1", orgRole: "owner" },
        two: { organizationId: "org-membership", userId: "owner-1", orgRole: "owner" },
        three: { organizationId: "org-other", userId: "owner-1", orgRole: "admin" },
      },
      projects: {
        p1: { organizationId: "org-direct" },
        p2: { organizationId: "org-membership" },
        p3: { organizationId: "org-other" },
      },
    });

    await expect(accountDeletionPreview({ db, uid: "owner-1" })).resolves.toEqual({
      ownedOrganizations: 2,
      projects: 2,
      members: 2,
    });
  });

  it("removes a deleted user from retained task roles and anonymizes authorship", () => {
    expect(participantPatch({
      assigneeIds: ["delete-me", "keep-me"],
      assignee: "Удаляемый, Оставшийся",
      assigneeEmail: "delete@example.com, keep@example.com",
      coCreatorIds: ["keep-me", "delete-me"],
      coCreators: "Оставшийся, Удаляемый",
      viewerIds: ["delete-me", "keep-me"],
      createdByUid: "delete-me",
      createdBy: "Удаляемый",
      createdByEmail: "delete@example.com",
      takenToWorkBy: "Удаляемый",
    }, "delete-me", { displayName: "Удаляемый" })).toMatchObject({
      assigneeIds: ["keep-me"],
      assignee: "Оставшийся",
      assigneeEmail: "keep@example.com",
      coCreatorIds: ["keep-me"],
      coCreators: "Оставшийся",
      viewerIds: ["keep-me"],
      createdByUid: null,
      createdBy: "Удалённый пользователь",
      createdByEmail: null,
      takenToWorkBy: "Удалённый пользователь",
    });
  });
});
