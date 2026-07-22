// api/award-xp.js
// Server-side XP / per-user stats awarding on task approval.
//
// XP and the per-user counters (totalXP, level, completedTasksCount,
// onTimeTasksCount, noRevisionTasksCount) drive the leaderboard and "личный
// кабинет", so they are integrity-critical. They used to be written by the
// MANAGER's client (awardXP() in script.js). Because the Firestore rules did
// not lock those fields, ANY client could self-credit unlimited XP, and the
// client also computed "on time" from a client-writable completedAt — both
// forgeable.
//
// This endpoint moves the award server-side:
//   * the Admin SDK writes the stats (the rules now forbid client writes);
//   * the whole award runs in a transaction and is idempotent via the task's
//     `xpProcessed` flag (no double-credit on retries / double-clicks / a race
//     between two approvers);
//   * `wasOnTime` is computed on the server from the task's server-set
//     completedAt (a serverTimestamp — see script.js), so it can't be forged.
//
// Only a manager of the task's project (owner/admin, or a moderator whose
// allowedProjects includes the project) may trigger the award, and only for a
// task that was actually completed (it has a completedAt timestamp).
import { adminDb, adminAuth } from "../lib/firebase-admin.js";
import { FieldValue } from "firebase-admin/firestore";
import {
  activeOrganizationStatsPatch,
  computeWasOnTime,
  computeXpDelta,
  ensureScopedOrganizationStats,
  getLevelFromXP,
  membershipRef,
  organizationStatsPatch,
  readOrganizationStats,
  XP_CONFIG,
} from "../lib/organization-stats.js";
import { loadTaskDocumentForCaller } from "../lib/task-store.js";

export { computeWasOnTime, computeXpDelta, getLevelFromXP, XP_CONFIG };

// Mirrors the canManageProject Firestore rule: owner/admin manage any project in
// their org; a moderator manages only projects in their allowedProjects
// (empty/absent = all). employee/reader can never manage.
export function callerCanManageProject(orgRole, allowedProjects, projectId) {
  if (orgRole === "owner" || orgRole === "admin") return true;
  if (orgRole === "moderator") {
    if (!Array.isArray(allowedProjects) || allowedProjects.length === 0) return true;
    return allowedProjects.includes(projectId);
  }
  return false;
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const idToken = (request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!idToken) return response.status(401).json({ error: "Unauthorized" });

  let decoded;
  try {
    decoded = await adminAuth().verifyIdToken(idToken);
  } catch {
    return response.status(401).json({ error: "Unauthorized" });
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return response.status(400).json({ error: "Invalid JSON body" });
  }
  const taskId = body && body.taskId;
  if (!taskId || typeof taskId !== "string") {
    return response.status(400).json({ error: "taskId is required" });
  }

  const db = adminDb();

  // Caller must be a manager of the task's project, in the same org.
  let callerOrgId = null;
  let callerOrgRole = null;
  let callerAllowedProjects = null;
  try {
    const callerDoc = await db.collection("users").doc(decoded.uid).get();
    const cd = callerDoc.exists ? callerDoc.data() : null;
    callerOrgId = cd ? cd.organizationId : null;
    callerOrgRole = cd ? cd.orgRole : null;
    callerAllowedProjects = cd ? cd.allowedProjects : null;
  } catch (error) {
    console.error("award-xp: failed to load caller", error);
    return response.status(500).json({ error: "Failed to verify caller" });
  }
  if (!callerOrgId) return response.status(403).json({ error: "No organization" });

  // Load the task + its project to check org membership and manage rights.
  let task;
  let taskRef;
  try {
    const loaded = await loadTaskDocumentForCaller(db, taskId, body.taskCollection, {
      uid: decoded.uid,
      organizationId: callerOrgId,
      orgRole: callerOrgRole,
    });
    if (!loaded) return response.status(404).json({ error: "Task not found" });
    if (loaded.forbidden) return response.status(403).json({ error: "Forbidden" });
    task = loaded.task;
    taskRef = loaded.ref;
  } catch (error) {
    console.error("award-xp: failed to load task", error);
    return response.status(500).json({ error: "Failed to load task" });
  }

  const projectId = task.projectId;
  if (!projectId) return response.status(400).json({ error: "Task has no projectId" });

  let taskOrganizationId = null;
  try {
    const projectDoc = await db.collection("projects").doc(projectId).get();
    taskOrganizationId = projectDoc.exists ? projectDoc.data().organizationId : null;
    if (!projectDoc.exists || taskOrganizationId !== callerOrgId) {
      return response.status(403).json({ error: "Forbidden" });
    }
  } catch (error) {
    console.error("award-xp: failed to load project", error);
    return response.status(500).json({ error: "Failed to verify project" });
  }

  // Принять задачу (и тем самым запустить начисление XP) может менеджер
  // проекта ИЛИ доп. постановщик задачи (uid в coCreatorIds) — зеркало
  // carve-out'а в firestore.rules.
  const callerIsCoCreator = Array.isArray(task.coCreatorIds) && task.coCreatorIds.includes(decoded.uid);
  if (!callerCanManageProject(callerOrgRole, callerAllowedProjects, projectId) && !callerIsCoCreator) {
    return response.status(403).json({ error: "Forbidden — not a manager of this project" });
  }

  // Resolve the assignees to credit. Prefer uids (Telegram-login users have no
  // email); fall back to resolving legacy assigneeEmail → uid. Done before the
  // transaction so the uid set is fixed when we read/write inside it.
  let assigneeUids = Array.isArray(task.assigneeIds) ? task.assigneeIds.filter(Boolean) : [];
  if (assigneeUids.length === 0 && task.assigneeEmail) {
    const emails = String(task.assigneeEmail).toLowerCase().split(",").map((e) => e.trim()).filter(Boolean);
    for (const email of emails) {
      try {
        const q = await db.collection("users").where("email", "==", email).limit(1).get();
        if (!q.empty) assigneeUids.push(q.docs[0].id);
      } catch (error) {
        console.error("award-xp: failed to resolve assignee email", email, error);
      }
    }
  }
  // De-duplicate (a task could list the same uid twice).
  assigneeUids = [...new Set(assigneeUids)];

  // Migrate legacy global counters before the transaction. After this point
  // every award is written to the assignee's membership in THIS organization.
  try {
    await Promise.all(assigneeUids.map((uid) => ensureScopedOrganizationStats(
      db,
      uid,
      null,
      { excludeTaskIds: [taskId] }
    )));
  } catch (error) {
    console.error("award-xp: failed to prepare organization stats", error);
    return response.status(500).json({ error: "Failed to prepare organization stats" });
  }

  try {
    const result = await db.runTransaction(async (tx) => {
      const freshTaskSnap = await tx.get(taskRef);
      if (!freshTaskSnap.exists) return { status: 404 };
      const fresh = freshTaskSnap.data();

      // Idempotent: never credit the same task twice.
      if (fresh.xpProcessed === true) {
        return { ok: true, alreadyProcessed: true };
      }
      // The task must actually have been completed. We gate on completedAt (set
      // when the assignee submits, an unforgeable serverTimestamp, and preserved
      // through approval) rather than assigneeCompleted — the approval write
      // flips assigneeCompleted back to false, so it is not a reliable signal
      // here. No completedAt → the task was never completed → award nothing.
      if (!fresh.completedAt) {
        return { status: 409, error: "Task has no completion timestamp" };
      }

      const wasOnTime = computeWasOnTime(fresh.completedAt, fresh.deadline);
      const wasReturned = !!(fresh.wasReturned || fresh.revisionReason);
      const xpDelta = computeXpDelta(wasOnTime, wasReturned);

      // Read every assignee's user doc BEFORE any write (transaction rule).
      const userRefs = assigneeUids.map((uid) => db.collection("users").doc(uid));
      const memberRefs = assigneeUids.map((uid) => membershipRef(db, taskOrganizationId, uid));
      const userSnaps = [];
      const memberSnaps = [];
      for (const ref of userRefs) {
        userSnaps.push(await tx.get(ref));
      }
      for (const ref of memberRefs) {
        memberSnaps.push(await tx.get(ref));
      }

      const awarded = [];
      userSnaps.forEach((snap, i) => {
        if (!snap.exists || !memberSnaps[i]?.exists) return;
        const ud = snap.data();
        const current = readOrganizationStats(memberSnaps[i].data());
        const newXP = current.totalXP + xpDelta;
        const nextStats = {
          totalXP: newXP,
          level: getLevelFromXP(newXP),
          completedTasksCount: current.completedTasksCount + 1,
          onTimeTasksCount: current.onTimeTasksCount + (wasOnTime ? 1 : 0),
          noRevisionTasksCount: current.noRevisionTasksCount + (wasReturned ? 0 : 1),
        };
        tx.set(memberRefs[i], {
          ...organizationStatsPatch(nextStats),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        // users/{uid} is a compatibility mirror only for the active org.
        if (ud.organizationId === taskOrganizationId) {
          tx.set(userRefs[i], activeOrganizationStatsPatch(nextStats), { merge: true });
        }
        awarded.push({ uid: assigneeUids[i], xp: xpDelta, newXP });
      });

      // Mark the task processed (idempotency) and record the trusted on-time flag.
      tx.update(taskRef, {
        xpProcessed: true,
        xpProcessedAt: FieldValue.serverTimestamp(),
        completedOnTime: wasOnTime,
      });

      return { ok: true, wasOnTime, wasReturned, xpDelta, awarded };
    });

    if (result.status) {
      return response.status(result.status).json({ error: result.error || "Error" });
    }
    return response.status(200).json(result);
  } catch (error) {
    console.error("award-xp: transaction failed", error);
    return response.status(500).json({ error: "Failed to award XP" });
  }
}

async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
