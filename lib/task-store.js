export const PUBLIC_TASKS_COLLECTION = "tasks";
export const PRIVATE_TASKS_COLLECTION = "privateTasks";

export function normalizeTaskCollection(value, fallback = PUBLIC_TASKS_COLLECTION) {
  if (value === PRIVATE_TASKS_COLLECTION) return PRIVATE_TASKS_COLLECTION;
  if (value === PUBLIC_TASKS_COLLECTION) return PUBLIC_TASKS_COLLECTION;
  return fallback;
}

export function isPrivateTaskParticipant(task, uid) {
  return !!uid && Array.isArray(task?.viewerIds) && task.viewerIds.includes(uid);
}

export function canCallerReadPrivateTask(task, caller) {
  const identity = typeof caller === "string" ? { uid: caller } : (caller || {});
  return isPrivateTaskParticipant(task, identity.uid)
    || (identity.orgRole === "owner"
      && !!identity.organizationId
      && identity.organizationId === task?.organizationId);
}

export function privateTaskViewerIds(creatorUid, assigneeIds = [], coCreatorIds = []) {
  return [...new Set([creatorUid, ...assigneeIds, ...coCreatorIds].filter(Boolean))];
}

export async function loadTaskDocument(db, taskId, collectionHint = null) {
  const collections = collectionHint
    ? [normalizeTaskCollection(collectionHint)]
    : [PUBLIC_TASKS_COLLECTION, PRIVATE_TASKS_COLLECTION];
  for (const collectionName of collections) {
    const snapshot = await db.collection(collectionName).doc(taskId).get();
    if (snapshot.exists) {
      return {
        collectionName,
        ref: snapshot.ref,
        snapshot,
        task: snapshot.data() || {},
      };
    }
  }
  return null;
}

export async function loadTaskDocumentForCaller(db, taskId, collectionHint, caller) {
  const loaded = await loadTaskDocument(db, taskId, collectionHint);
  if (!loaded) return null;
  if (loaded.collectionName === PRIVATE_TASKS_COLLECTION
      && !canCallerReadPrivateTask(loaded.task, caller)) {
    return { ...loaded, forbidden: true };
  }
  return loaded;
}
