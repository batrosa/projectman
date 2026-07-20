import { FieldValue } from "firebase-admin/firestore";

export const ORGANIZATION_STATS_VERSION = 1;

export const XP_CONFIG = {
  baseTaskXP: 10,
  onTimeBonus: 5,
  revisionPenalty: 3,
  levels: [
    { level: 1, xpRequired: 0 },
    { level: 2, xpRequired: 50 },
    { level: 3, xpRequired: 150 },
    { level: 4, xpRequired: 300 },
    { level: 5, xpRequired: 500 },
    { level: 6, xpRequired: 800 },
    { level: 7, xpRequired: 1200 },
  ],
};

export function getLevelFromXP(xp) {
  let level = 1;
  for (const item of XP_CONFIG.levels) {
    if (xp >= item.xpRequired) level = item.level;
    else break;
  }
  return level;
}

export function computeXpDelta(wasOnTime, wasReturned) {
  let xp = XP_CONFIG.baseTaskXP;
  if (wasOnTime) xp += XP_CONFIG.onTimeBonus;
  if (wasReturned) xp -= XP_CONFIG.revisionPenalty;
  return Math.max(1, xp);
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === "function") return value.toDate();
  if (typeof value === "object" && typeof value.seconds === "number") {
    return new Date(value.seconds * 1000);
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function computeWasOnTime(completedAt, deadlineString) {
  if (!deadlineString) return true;
  const deadline = new Date(deadlineString);
  if (Number.isNaN(deadline.getTime())) return true;
  deadline.setHours(23, 59, 59, 999);
  const completed = toDate(completedAt);
  if (!completed || Number.isNaN(completed.getTime())) return true;
  return completed <= deadline;
}

export function emptyOrganizationStats() {
  return {
    totalXP: 0,
    level: 1,
    completedTasksCount: 0,
    onTimeTasksCount: 0,
    noRevisionTasksCount: 0,
  };
}

function nonNegativeInteger(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : fallback;
}

export function readOrganizationStats(data = {}) {
  const totalXP = nonNegativeInteger(data.totalXP);
  return {
    totalXP,
    level: getLevelFromXP(totalXP),
    completedTasksCount: nonNegativeInteger(data.completedTasksCount),
    onTimeTasksCount: nonNegativeInteger(data.onTimeTasksCount),
    noRevisionTasksCount: nonNegativeInteger(data.noRevisionTasksCount),
  };
}

export function organizationStatsPatch(stats, { includeVersion = true } = {}) {
  const normalized = readOrganizationStats(stats);
  return {
    ...normalized,
    ...(includeVersion ? { statsScopeVersion: ORGANIZATION_STATS_VERSION } : {}),
  };
}

export function activeOrganizationStatsPatch(stats) {
  return {
    ...organizationStatsPatch(stats, { includeVersion: false }),
    activeStatsScopeVersion: ORGANIZATION_STATS_VERSION,
  };
}

export function membershipDocId(organizationId, userId) {
  return `${organizationId}_${userId}`;
}

export function membershipRef(db, organizationId, userId) {
  return db.collection("organizationMemberships").doc(membershipDocId(organizationId, userId));
}

function taskBelongsToUser(task, userId, userData) {
  if (Array.isArray(task.assigneeIds) && task.assigneeIds.includes(userId)) return true;
  const email = String(userData.email || "").trim().toLowerCase();
  if (email && task.assigneeEmail) {
    const emails = String(task.assigneeEmail).toLowerCase().split(",").map((item) => item.trim());
    if (emails.includes(email)) return true;
  }
  return false;
}

function addTaskToStats(stats, task) {
  const wasOnTime = typeof task.completedOnTime === "boolean"
    ? task.completedOnTime
    : computeWasOnTime(task.completedAt, task.deadline);
  const wasReturned = Boolean(task.wasReturned || task.revisionReason);
  stats.totalXP += computeXpDelta(wasOnTime, wasReturned);
  stats.completedTasksCount += 1;
  if (wasOnTime) stats.onTimeTasksCount += 1;
  if (!wasReturned) stats.noRevisionTasksCount += 1;
  stats.level = getLevelFromXP(stats.totalXP);
}

async function calculateStatsForOrganization(db, organizationId, userId, userData, excludedTaskIds) {
  const stats = emptyOrganizationStats();
  const projects = await db.collection("projects").where("organizationId", "==", organizationId).get();
  const projectIds = projects.docs.map((doc) => doc.id);
  for (let offset = 0; offset < projectIds.length; offset += 10) {
    const chunk = projectIds.slice(offset, offset + 10);
    if (chunk.length === 0) continue;
    const tasks = await db.collection("tasks").where("projectId", "in", chunk).get();
    tasks.docs.forEach((doc) => {
      if (excludedTaskIds.has(doc.id)) return;
      const task = doc.data() || {};
      const wasAwarded = task.xpProcessed === true
        || (task.xpProcessed == null && task.xpAwarded === true);
      if (!wasAwarded || !taskBelongsToUser(task, userId, userData)) return;
      addTaskToStats(stats, task);
    });
  }
  return stats;
}

function timestampMillis(value) {
  const date = toDate(value);
  return date ? date.getTime() : Number.POSITIVE_INFINITY;
}

// One-time migration from the old global users/{uid} counters. Reconstruct as
// much as possible from awarded tasks in each organization; any legacy balance
// whose task was deleted/unlinked is kept in the most plausible original
// membership (largest reconstructed history, then earliest join date).
export async function ensureScopedOrganizationStats(
  db,
  userId,
  providedUserData = null,
  { excludeTaskIds = [] } = {}
) {
  const excludedTaskIds = new Set(excludeTaskIds);
  let resolvedUserData = providedUserData;
  if (!resolvedUserData) {
    const userSnapshot = await db.collection("users").doc(userId).get();
    resolvedUserData = userSnapshot.exists ? (userSnapshot.data() || {}) : {};
  }
  const memberships = await db.collection("organizationMemberships")
    .where("userId", "==", userId)
    .get();
  if (memberships.empty) return new Map();

  const rows = memberships.docs.map((doc) => ({ doc, data: doc.data() || {} }));
  if (rows.every(({ data }) => data.statsScopeVersion === ORGANIZATION_STATS_VERSION)) {
    return new Map(rows.map(({ data }) => [data.organizationId, readOrganizationStats(data)]));
  }

  const reconstructed = new Map();
  for (const { data } of rows) {
    const organizationId = data.organizationId;
    if (!organizationId) continue;
    if (data.statsScopeVersion === ORGANIZATION_STATS_VERSION) {
      reconstructed.set(organizationId, readOrganizationStats(data));
      continue;
    }
    reconstructed.set(
      organizationId,
      await calculateStatsForOrganization(
        db,
        organizationId,
        userId,
        resolvedUserData,
        excludedTaskIds
      )
    );
  }

  const legacy = readOrganizationStats(resolvedUserData);
  const totals = [...reconstructed.values()].reduce((sum, stats) => ({
    totalXP: sum.totalXP + stats.totalXP,
    completedTasksCount: sum.completedTasksCount + stats.completedTasksCount,
    onTimeTasksCount: sum.onTimeTasksCount + stats.onTimeTasksCount,
    noRevisionTasksCount: sum.noRevisionTasksCount + stats.noRevisionTasksCount,
  }), { totalXP: 0, completedTasksCount: 0, onTimeTasksCount: 0, noRevisionTasksCount: 0 });

  const migrationCandidates = rows
    .filter(({ data }) => data.statsScopeVersion !== ORGANIZATION_STATS_VERSION && data.organizationId)
    .sort((left, right) => {
      const leftStats = reconstructed.get(left.data.organizationId) || emptyOrganizationStats();
      const rightStats = reconstructed.get(right.data.organizationId) || emptyOrganizationStats();
      if (rightStats.completedTasksCount !== leftStats.completedTasksCount) {
        return rightStats.completedTasksCount - leftStats.completedTasksCount;
      }
      if (rightStats.totalXP !== leftStats.totalXP) return rightStats.totalXP - leftStats.totalXP;
      return timestampMillis(left.data.joinedAt) - timestampMillis(right.data.joinedAt);
    });

  // Once users/{uid} has activeStatsScopeVersion, its counters are only a
  // mirror of the currently selected organization — never treat that mirror
  // as a historical aggregate during a later/partial migration.
  const legacyHome = resolvedUserData.activeStatsScopeVersion === ORGANIZATION_STATS_VERSION
    ? null
    : migrationCandidates[0]?.data.organizationId;
  if (legacyHome) {
    const stats = reconstructed.get(legacyHome) || emptyOrganizationStats();
    stats.totalXP += Math.max(0, legacy.totalXP - totals.totalXP);
    stats.completedTasksCount += Math.max(0, legacy.completedTasksCount - totals.completedTasksCount);
    stats.onTimeTasksCount += Math.max(0, legacy.onTimeTasksCount - totals.onTimeTasksCount);
    stats.noRevisionTasksCount += Math.max(0, legacy.noRevisionTasksCount - totals.noRevisionTasksCount);
    stats.level = getLevelFromXP(stats.totalXP);
    reconstructed.set(legacyHome, stats);
  }

  const batch = db.batch();
  let operations = 0;
  rows.forEach(({ doc, data }) => {
    if (data.statsScopeVersion === ORGANIZATION_STATS_VERSION || !data.organizationId) return;
    batch.set(doc.ref, {
      ...organizationStatsPatch(reconstructed.get(data.organizationId) || emptyOrganizationStats()),
      statsMigratedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    operations += 1;
  });
  if (operations > 0) await batch.commit();
  return reconstructed;
}
