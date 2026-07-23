import { FieldValue } from "firebase-admin/firestore";
import {
  destroyAsset,
  destroyLegacyAsset,
  isSecureStorageRef,
  legacyCloudinaryRef,
} from "./cloudinary-files.js";

const BATCH_SIZE = 400;
const ANONYMOUS_NAME = "Удалённый пользователь";

function addDocs(target, snapshot) {
  (snapshot?.docs || []).forEach((doc) => target.set(doc.ref.path, doc));
}

async function deleteDocs(db, docs) {
  const refs = [...docs.values()].map((doc) => doc.ref || doc);
  for (let offset = 0; offset < refs.length; offset += BATCH_SIZE) {
    const batch = db.batch();
    refs.slice(offset, offset + BATCH_SIZE).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
}

function collectFile(target, value) {
  if (!value || typeof value !== "object") return;
  if (isSecureStorageRef(value)) {
    target.set(`secure:${value.resourceType}:${value.publicId}`, { secure: true, value });
    return;
  }
  const legacy = legacyCloudinaryRef(value);
  if (legacy) target.set(`legacy:${legacy.resourceType}:${legacy.publicId}`, { secure: false, value });
}

function collectTaskFiles(target, task = {}) {
  [
    ...(Array.isArray(task.attachments) ? task.attachments : []),
    ...(Array.isArray(task.completionProofs) ? task.completionProofs : []),
    task.completionProof,
  ].forEach((file) => collectFile(target, file));
}

function collectUploadIntent(target, intent = {}) {
  if (!intent.publicId || !["image", "raw"].includes(intent.resourceType)) return;
  collectFile(target, {
    ...intent,
    storageProvider: "cloudinary",
    deliveryType: "authenticated",
  });
}

async function destroyFiles(files, destroyers = {}) {
  const secureDestroy = destroyers.destroyAsset || destroyAsset;
  const legacyDestroy = destroyers.destroyLegacyAsset || destroyLegacyAsset;
  const values = [...files.values()];
  for (let offset = 0; offset < values.length; offset += 5) {
    const results = await Promise.all(values.slice(offset, offset + 5).map(async (entry) => (
      entry.secure ? secureDestroy(entry.value) : legacyDestroy(entry.value)
    )));
    const failed = results.find((result) => !["ok", "not found", "skipped"].includes(String(result?.result || "")));
    if (failed) throw new Error(`Cloudinary deletion failed: ${String(failed?.result || "unknown")}`);
  }
}

async function queryBy(db, collection, field, value) {
  return db.collection(collection).where(field, "==", value).get();
}

async function collectOrganizationDocs(db, orgId) {
  const docs = new Map();
  const files = new Map();
  const projects = await queryBy(db, "projects", "organizationId", orgId);
  for (const project of projects.docs) {
    const projectFiles = await project.ref.collection("files").get();
    projectFiles.docs.forEach((doc) => {
      const data = doc.data() || {};
      collectFile(files, data.storage || data);
    });
    addDocs(docs, projectFiles);

    for (const collection of ["tasks", "privateTasks"]) {
      const tasks = await queryBy(db, collection, "projectId", project.id);
      tasks.docs.forEach((doc) => collectTaskFiles(files, doc.data() || {}));
      addDocs(docs, tasks);
    }
    for (const collection of [
      "agentNotifications",
      "deadlineChangeRequests",
      "fileUploadIntents",
      "fileAuditLogs",
      "agentActionAudit",
    ]) {
      const snapshot = await queryBy(db, collection, "projectId", project.id);
      if (collection === "fileUploadIntents") {
        snapshot.docs.forEach((doc) => collectUploadIntent(files, doc.data() || {}));
      }
      addDocs(docs, snapshot);
    }
    docs.set(project.ref.path, project);
  }

  // Also catch org-scoped records created before projectId became mandatory.
  for (const collection of [
    "tasks",
    "privateTasks",
    "agentNotifications",
    "deadlineChangeRequests",
    "fileUploadIntents",
    "fileAuditLogs",
    "agentActionAudit",
    "auditLogs",
  ]) {
    const snapshot = await queryBy(db, collection, "organizationId", orgId);
    if (collection === "tasks" || collection === "privateTasks") {
      snapshot.docs.forEach((doc) => collectTaskFiles(files, doc.data() || {}));
    } else if (collection === "fileUploadIntents") {
      snapshot.docs.forEach((doc) => collectUploadIntent(files, doc.data() || {}));
    }
    addDocs(docs, snapshot);
  }
  return { docs, files, projectCount: projects.size };
}

export async function deleteOrganizationCascade({ db, orgId, deletingUid = "", destroyers = {} }) {
  const orgRef = db.collection("organizations").doc(orgId);
  const orgDoc = await orgRef.get();
  if (!orgDoc.exists) return { orgId, projectCount: 0, memberCount: 0, alreadyDeleted: true };

  const [{ docs, files, projectCount }, memberships, activeUsers] = await Promise.all([
    collectOrganizationDocs(db, orgId),
    queryBy(db, "organizationMemberships", "organizationId", orgId),
    queryBy(db, "users", "organizationId", orgId),
  ]);

  // Physical objects go first. Firestore metadata remains available for a
  // safe retry if Cloudinary reports a real failure.
  await destroyFiles(files, destroyers);

  // Keep the organization and owner membership until the very end. If a
  // later batch fails, the owner relationship remains discoverable and the
  // same account-deletion request can safely resume.
  await deleteDocs(db, docs);

  const survivors = activeUsers.docs.filter((doc) => doc.id !== deletingUid);
  for (let offset = 0; offset < survivors.length; offset += BATCH_SIZE) {
    const batch = db.batch();
    survivors.slice(offset, offset + BATCH_SIZE).forEach((doc) => {
      batch.set(doc.ref, {
        organizationId: null,
        orgRole: null,
        allowedProjects: FieldValue.delete(),
      }, { merge: true });
    });
    await batch.commit();
  }
  await deleteDocs(db, new Map(memberships.docs.map((doc) => [doc.ref.path, doc])));
  await deleteDocs(db, new Map([[orgRef.path, orgDoc]]));
  return { orgId, projectCount, memberCount: memberships.size, fileCount: files.size };
}

function removeNameAtIndexes(value, ids, uid) {
  if (!Array.isArray(ids)) return String(value || "");
  const names = String(value || "").split(",").map((part) => part.trim());
  return names.filter((_, index) => ids[index] !== uid).filter(Boolean).join(", ");
}

export function participantPatch(task, uid, user = {}) {
  const patch = {};
  if (Array.isArray(task.assigneeIds) && task.assigneeIds.includes(uid)) {
    patch.assignee = removeNameAtIndexes(task.assignee, task.assigneeIds, uid);
    if (task.assigneeEmail) {
      patch.assigneeEmail = removeNameAtIndexes(task.assigneeEmail, task.assigneeIds, uid);
    }
    patch.assigneeIds = task.assigneeIds.filter((id) => id !== uid);
  }
  if (Array.isArray(task.coCreatorIds) && task.coCreatorIds.includes(uid)) {
    patch.coCreators = removeNameAtIndexes(task.coCreators, task.coCreatorIds, uid);
    patch.coCreatorIds = task.coCreatorIds.filter((id) => id !== uid);
  }
  if (task.createdByUid === uid) {
    patch.createdByUid = null;
    patch.createdBy = ANONYMOUS_NAME;
    patch.createdByEmail = null;
  }
  const viewerIds = new Set(Array.isArray(task.viewerIds) ? task.viewerIds : []);
  if (viewerIds.delete(uid)) patch.viewerIds = [...viewerIds];
  const aliases = new Set([
    user.displayName,
    `${user.firstName || ""} ${user.lastName || ""}`.trim(),
  ].filter(Boolean));
  for (const field of ["takenToWorkBy", "completedBy", "archivedBy", "revisionReturnedBy"]) {
    if (aliases.has(String(task[field] || "").trim())) patch[field] = ANONYMOUS_NAME;
  }
  if (task.deadlineChangeRequest?.requestedByUid === uid
      || task.deadlineChangeRequest?.createdByUid === uid) {
    patch.deadlineChangeRequest = FieldValue.delete();
  }
  return patch;
}

async function anonymizeRetainedTasks(db, uid, user) {
  for (const collection of ["tasks", "privateTasks"]) {
    const docs = new Map();
    for (const field of ["assigneeIds", "coCreatorIds"]) {
      addDocs(docs, await db.collection(collection).where(field, "array-contains", uid).get());
    }
    addDocs(docs, await queryBy(db, collection, "createdByUid", uid));
    const values = [...docs.values()];
    for (let offset = 0; offset < values.length; offset += BATCH_SIZE) {
      const batch = db.batch();
      values.slice(offset, offset + BATCH_SIZE).forEach((doc) => {
        const patch = participantPatch(doc.data() || {}, uid, user);
        if (Object.keys(patch).length > 0) batch.set(doc.ref, patch, { merge: true });
      });
      await batch.commit();
    }
  }
}

async function ownedOrganizationIds(db, uid) {
  const ids = new Set();
  const [ownerDocs, memberships] = await Promise.all([
    queryBy(db, "organizations", "ownerId", uid),
    queryBy(db, "organizationMemberships", "userId", uid),
  ]);
  ownerDocs.docs.forEach((doc) => ids.add(doc.id));
  memberships.docs.forEach((doc) => {
    const data = doc.data() || {};
    if (data.orgRole === "owner" && data.organizationId) ids.add(data.organizationId);
  });
  return [...ids];
}

export async function accountDeletionPreview({ db, uid }) {
  const organizationIds = await ownedOrganizationIds(db, uid);
  let projects = 0;
  let members = 0;
  for (const orgId of organizationIds) {
    const [projectSnap, membershipSnap] = await Promise.all([
      queryBy(db, "projects", "organizationId", orgId),
      queryBy(db, "organizationMemberships", "organizationId", orgId),
    ]);
    projects += projectSnap.size;
    members += membershipSnap.size;
  }
  return { ownedOrganizations: organizationIds.length, projects, members };
}

export async function deleteAccountCascade({ db, auth, uid, destroyers = {} }) {
  const userRef = db.collection("users").doc(uid);
  const userDoc = await userRef.get();
  const user = userDoc.exists ? (userDoc.data() || {}) : {};
  const personalFiles = new Map();
  if (user.profilePhotoUrl) collectFile(personalFiles, { url: user.profilePhotoUrl });
  const ownedOrgIds = await ownedOrganizationIds(db, uid);
  const deletedOrganizations = [];
  for (const orgId of ownedOrgIds) {
    deletedOrganizations.push(await deleteOrganizationCascade({
      db,
      orgId,
      deletingUid: uid,
      destroyers,
    }));
  }

  await anonymizeRetainedTasks(db, uid, user);

  const personalDocs = new Map();
  const memberships = await queryBy(db, "organizationMemberships", "userId", uid);
  addDocs(personalDocs, memberships);
  for (const collectionAndFields of [
    ["agentNotifications", ["uid", "recipientUid"]],
    ["deadlineChangeRequests", ["requestedByUid", "createdByUid"]],
    ["auditLogs", ["actorUid", "targetUid"]],
    ["fileAuditLogs", ["actorUid"]],
    ["agentActionAudit", ["uid"]],
    ["fileUploadIntents", ["uid"]],
    ["fileRateLimits", ["uid"]],
    ["telegramLoginSessions", ["uid"]],
    ["telegramAccountLinks", ["uid", "previousUid"]],
  ]) {
    const [collection, fields] = collectionAndFields;
    for (const field of fields) addDocs(personalDocs, await queryBy(db, collection, field, uid));
  }

  const devices = await userRef.collection("devices").get();
  addDocs(personalDocs, devices);
  if (userDoc.exists) personalDocs.set(userRef.path, userDoc);

  const telegramId = String(user.telegramId || user.telegramChatId || "");
  if (telegramId) {
    const linkRef = db.collection("telegramAccountLinks").doc(telegramId);
    const linkDoc = await linkRef.get();
    if (linkDoc.exists) personalDocs.set(linkRef.path, linkDoc);
    addDocs(personalDocs, await queryBy(db, "telegramLoginSessions", "telegramId", telegramId));
  }

  await destroyFiles(personalFiles, destroyers);

  // Remove remaining memberships and counters before deleting the profile.
  for (const membership of memberships.docs) {
    const data = membership.data() || {};
    if (!data.organizationId || ownedOrgIds.includes(data.organizationId)) continue;
    const orgRef = db.collection("organizations").doc(data.organizationId);
    const orgDoc = await orgRef.get();
    if (orgDoc.exists) {
      await orgRef.set({ membersCount: FieldValue.increment(-1) }, { merge: true });
    }
  }
  await deleteDocs(db, personalDocs);

  try {
    await auth.deleteUser(uid);
  } catch (error) {
    if (error?.code !== "auth/user-not-found") throw error;
  }
  return { ok: true, deletedOrganizations };
}
