import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "./firebase-admin.js";
import {
  buildPublicId,
  createPrivateDownloadUrl,
  createSignedUpload,
  destroyAsset,
  destroyLegacyAsset,
  cloudinaryClient,
  isProjectPublicId,
  isSecureStorageRef,
  legacyCloudinaryRef,
  secureStorageRef,
  validateFileRequest,
  verifyUploadedAsset,
  MAX_FILE_BYTES,
} from "./cloudinary-files.js";

const INTENT_TTL_MS = 10 * 60 * 1000;
const MAX_UPLOAD_INTENTS_PER_MINUTE = 20;
const LEGACY_PURGE_CONFIRMATION = "DELETE_ALL_LEGACY_CLOUDINARY_ASSETS";

export function callerCanViewProject(allowedProjects, projectId) {
  return !Array.isArray(allowedProjects)
    || allowedProjects.length === 0
    || allowedProjects.includes(projectId);
}

export function callerCanManageProject(orgRole, allowedProjects, projectId) {
  if (orgRole === "owner" || orgRole === "admin") return true;
  return orgRole === "moderator" && callerCanViewProject(allowedProjects, projectId);
}

async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function authenticate(request) {
  const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  try {
    return await adminAuth().verifyIdToken(token);
  } catch {
    return null;
  }
}

async function loadAccess(db, uid, projectId) {
  const [userDoc, projectDoc] = await Promise.all([
    db.collection("users").doc(uid).get(),
    db.collection("projects").doc(projectId).get(),
  ]);
  if (!userDoc.exists || !projectDoc.exists) return null;
  const user = userDoc.data();
  const project = projectDoc.data();
  if (!user.organizationId || project.organizationId !== user.organizationId) return null;
  return {
    organizationId: user.organizationId,
    orgRole: user.orgRole || null,
    allowedProjects: user.allowedProjects,
    canView: callerCanViewProject(user.allowedProjects, projectId),
    canManage: callerCanManageProject(user.orgRole, user.allowedProjects, projectId),
  };
}

async function enforceUploadRateLimit(db, uid) {
  const minute = Math.floor(Date.now() / 60000);
  const ref = db.collection("fileRateLimits").doc(`${uid}_${minute}`);
  await db.runTransaction(async (tx) => {
    const doc = await tx.get(ref);
    const count = doc.exists ? Number(doc.data().count || 0) : 0;
    if (count >= MAX_UPLOAD_INTENTS_PER_MINUTE) {
      const error = new Error("Upload rate limit exceeded");
      error.status = 429;
      throw error;
    }
    tx.set(ref, { uid, minute, count: count + 1, expiresAt: new Date(Date.now() + 2 * 60000).toISOString() });
  });
}

async function writeAudit(db, action, decoded, storage, metadata = {}) {
  try {
    await db.collection("fileAuditLogs").add({
      action,
      actorUid: decoded.uid,
      organizationId: storage.organizationId || null,
      projectId: storage.projectId,
      publicId: storage.publicId,
      at: new Date().toISOString(),
      metadata,
    });
  } catch (error) {
    console.error("files: audit log failed", { action, error });
  }
}

async function handleSignUpload({ response, db, decoded, body }) {
  const validation = validateFileRequest(body);
  if (!validation.ok) return response.status(validation.status).json({ error: validation.error });

  const access = await loadAccess(db, decoded.uid, body.projectId);
  if (!access || !access.canView || (body.purpose === "project_file" && !access.canManage)) {
    return response.status(403).json({ error: "Forbidden" });
  }

  try {
    await enforceUploadRateLimit(db, decoded.uid);
  } catch (error) {
    return response.status(error.status || 500).json({ error: error.message || "Rate limit failed" });
  }

  const publicId = buildPublicId({
    organizationId: access.organizationId,
    projectId: body.projectId,
    resourceType: validation.resourceType,
    extension: validation.extension,
  });
  const intentRef = db.collection("fileUploadIntents").doc();
  const intent = {
    id: intentRef.id,
    uid: decoded.uid,
    organizationId: access.organizationId,
    projectId: body.projectId,
    purpose: body.purpose,
    filename: String(body.filename).slice(0, 240),
    mimeType: typeof body.mimeType === "string" ? body.mimeType.slice(0, 160) : null,
    declaredSize: validation.size,
    extension: validation.extension,
    resourceType: validation.resourceType,
    fileType: typeof body.fileType === "string" ? body.fileType.slice(0, 32) : "other",
    publicId,
    status: "created",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + INTENT_TTL_MS).toISOString(),
  };
  await intentRef.set(intent);
  const signed = createSignedUpload({ publicId, resourceType: validation.resourceType });
  await writeAudit(db, "upload_signed", decoded, intent, { purpose: body.purpose });
  return response.status(200).json({ ok: true, intentId: intent.id, ...signed });
}

async function handleFinalizeUpload({ response, db, decoded, body }) {
  const intentId = typeof body.intentId === "string" ? body.intentId : "";
  if (!intentId) return response.status(400).json({ error: "intentId is required" });
  const ref = db.collection("fileUploadIntents").doc(intentId);
  const doc = await ref.get();
  if (!doc.exists) return response.status(404).json({ error: "Upload intent not found" });
  const intent = { id: doc.id, ...doc.data() };
  if (intent.uid !== decoded.uid) return response.status(403).json({ error: "Forbidden" });
  if (intent.status === "completed" && intent.storage) {
    return response.status(200).json({ ok: true, file: intent.storage, idempotent: true });
  }
  if (Date.parse(intent.expiresAt) < Date.now()) return response.status(410).json({ error: "Upload intent expired" });

  const access = await loadAccess(db, decoded.uid, intent.projectId);
  if (!access
    || !access.canView
    || access.organizationId !== intent.organizationId
    || (intent.purpose === "project_file" && !access.canManage)) {
    return response.status(403).json({ error: "Forbidden" });
  }

  let asset;
  try {
    asset = await verifyUploadedAsset(intent);
  } catch (error) {
    return response.status(409).json({ error: "Uploaded asset was not found" });
  }
  const invalid = asset.public_id !== intent.publicId
    || asset.resource_type !== intent.resourceType
    || asset.type !== "authenticated"
    || !Number.isFinite(Number(asset.bytes))
    || Number(asset.bytes) <= 0
    || Number(asset.bytes) > MAX_FILE_BYTES
    || !isProjectPublicId(asset.public_id, intent.organizationId, intent.projectId);
  if (invalid) {
    try { await destroyAsset(intent); } catch (error) { console.error("files: rejected asset cleanup failed", error); }
    await ref.update({ status: "rejected", rejectedAt: new Date().toISOString() });
    return response.status(400).json({ error: "Uploaded asset failed validation" });
  }

  const storage = secureStorageRef({ asset, intent });
  await ref.update({ status: "completed", completedAt: new Date().toISOString(), storage });
  await writeAudit(db, "upload_completed", decoded, intent, { bytes: asset.bytes });
  return response.status(200).json({ ok: true, file: storage });
}

async function validateStorageAccess({ db, decoded, body }) {
  const storage = body.file || body.storage;
  if (!isSecureStorageRef(storage)) return { error: [400, "Invalid file reference"] };
  const access = await loadAccess(db, decoded.uid, storage.projectId);
  if (!access || !access.canView || !isProjectPublicId(storage.publicId, access.organizationId, storage.projectId)) {
    return { error: [403, "Forbidden"] };
  }
  return { storage: { ...storage, organizationId: access.organizationId }, access };
}

async function handleDownload({ response, db, decoded, body }) {
  const checked = await validateStorageAccess({ db, decoded, body });
  if (checked.error) return response.status(checked.error[0]).json({ error: checked.error[1] });
  const expiresAt = Math.floor(Date.now() / 1000) + 5 * 60;
  const url = createPrivateDownloadUrl({ ...checked.storage, filename: checked.storage.name, expiresAt });
  await writeAudit(db, "download_signed", decoded, checked.storage, { expiresAt });
  return response.status(200).json({ ok: true, url, expiresAt });
}

async function handleDelete({ response, db, decoded, body }) {
  const checked = await validateStorageAccess({ db, decoded, body });
  if (checked.error) return response.status(checked.error[0]).json({ error: checked.error[1] });
  let ownsUpload = false;
  if (checked.storage.uploadIntentId) {
    const intentDoc = await db.collection("fileUploadIntents").doc(checked.storage.uploadIntentId).get();
    ownsUpload = intentDoc.exists
      && intentDoc.data().uid === decoded.uid
      && intentDoc.data().publicId === checked.storage.publicId;
  }
  if (!ownsUpload && !checked.access.canManage) return response.status(403).json({ error: "Forbidden" });
  const result = await destroyAsset(checked.storage);
  if (!["ok", "not found"].includes(result.result)) {
    return response.status(502).json({ error: "Cloud storage deletion failed" });
  }
  if (checked.storage.uploadIntentId) {
    await db.collection("fileUploadIntents").doc(checked.storage.uploadIntentId).set({
      status: "deleted",
      deletedAt: new Date().toISOString(),
    }, { merge: true });
  }
  await writeAudit(db, "deleted", decoded, checked.storage);
  return response.status(200).json({ ok: true });
}

async function handleDeleteTask({ response, db, decoded, body }) {
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  if (!taskId) return response.status(400).json({ error: "taskId is required" });
  const taskRef = db.collection("tasks").doc(taskId);
  const taskDoc = await taskRef.get();
  if (!taskDoc.exists) return response.status(404).json({ error: "Task not found" });
  const task = taskDoc.data();
  const access = await loadAccess(db, decoded.uid, task.projectId);
  if (!access || !access.canManage) return response.status(403).json({ error: "Forbidden" });

  const references = [
    ...(Array.isArray(task.attachments) ? task.attachments : []),
    ...(Array.isArray(task.completionProofs) ? task.completionProofs : []),
  ];
  const seen = new Set();
  let deletedAssets = 0;
  for (const file of references) {
    const key = file?.publicId || file?.url;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const result = isSecureStorageRef(file)
      ? await destroyAsset(file)
      : await destroyLegacyAsset(file);
    if (["ok", "not found"].includes(result.result)) deletedAssets += 1;
    else if (result.result !== "skipped") {
      return response.status(502).json({ error: "Cloud storage deletion failed" });
    }
  }
  await taskRef.delete();
  await writeAudit(db, "task_deleted_with_files", decoded, {
    organizationId: access.organizationId,
    projectId: task.projectId,
    publicId: null,
  }, { taskId, deletedAssets });
  return response.status(200).json({ ok: true, deletedAssets });
}

async function listLegacyAssets(resourceType) {
  const resources = [];
  let nextCursor;
  do {
    const page = await cloudinaryClient().api.resources({
      resource_type: resourceType,
      type: "upload",
      max_results: 500,
      next_cursor: nextCursor,
    });
    resources.push(...(page.resources || []));
    nextCursor = page.next_cursor;
  } while (nextCursor);
  return resources;
}

async function commitWrites(writes) {
  for (let index = 0; index < writes.length; index += 400) {
    const batch = writes[index].ref.firestore.batch();
    for (const write of writes.slice(index, index + 400)) {
      if (write.type === "delete") batch.delete(write.ref);
      else batch.update(write.ref, write.patch);
    }
    await batch.commit();
  }
}

export function withoutLegacyFiles(files) {
  if (!Array.isArray(files)) return files;
  return files.filter((file) => !legacyCloudinaryRef(file));
}

async function handlePurgeLegacyFiles({ response, db, decoded, body }) {
  if (body.confirm !== LEGACY_PURGE_CONFIRMATION) {
    return response.status(400).json({ error: "Explicit purge confirmation is required" });
  }
  const callerDoc = await db.collection("users").doc(decoded.uid).get();
  const caller = callerDoc.exists ? callerDoc.data() : null;
  if (!caller || caller.orgRole !== "owner") return response.status(403).json({ error: "Owner access required" });

  const [imageAssets, rawAssets, videoAssets, tasks, projects, users] = await Promise.all([
    listLegacyAssets("image"),
    listLegacyAssets("raw"),
    listLegacyAssets("video"),
    db.collection("tasks").get(),
    db.collection("projects").get(),
    db.collection("users").get(),
  ]);

  const writes = [];
  let cleanedTaskReferences = 0;
  for (const taskDoc of tasks.docs) {
    const task = taskDoc.data();
    const attachments = withoutLegacyFiles(task.attachments);
    const completionProofs = withoutLegacyFiles(task.completionProofs);
    const patch = {};
    if (Array.isArray(task.attachments) && attachments.length !== task.attachments.length) {
      cleanedTaskReferences += task.attachments.length - attachments.length;
      patch.attachments = attachments;
    }
    if (Array.isArray(task.completionProofs) && completionProofs.length !== task.completionProofs.length) {
      cleanedTaskReferences += task.completionProofs.length - completionProofs.length;
      patch.completionProofs = completionProofs;
    }
    if (typeof task.completionProof === "string" && legacyCloudinaryRef({ url: task.completionProof })) {
      cleanedTaskReferences += 1;
      patch.completionProof = FieldValue.delete();
    }
    if (Object.keys(patch).length) writes.push({ type: "update", ref: taskDoc.ref, patch });
  }

  let deletedProjectFileRecords = 0;
  for (const projectDoc of projects.docs) {
    const files = await projectDoc.ref.collection("files").get();
    for (const fileDoc of files.docs) {
      if (legacyCloudinaryRef(fileDoc.data())) {
        writes.push({ type: "delete", ref: fileDoc.ref });
        deletedProjectFileRecords += 1;
      }
    }
  }

  let cleanedProfilePhotos = 0;
  for (const userDoc of users.docs) {
    const user = userDoc.data();
    if (typeof user.profilePhotoUrl === "string" && legacyCloudinaryRef({ url: user.profilePhotoUrl })) {
      writes.push({ type: "update", ref: userDoc.ref, patch: { profilePhotoUrl: FieldValue.delete() } });
      cleanedProfilePhotos += 1;
    }
  }
  if (writes.length) await commitWrites(writes);

  const groups = [
    ["image", imageAssets],
    ["raw", rawAssets],
    ["video", videoAssets],
  ];
  let deletedAssets = 0;
  let deletedBytes = 0;
  for (const [resourceType, assets] of groups) {
    for (let index = 0; index < assets.length; index += 100) {
      const chunk = assets.slice(index, index + 100);
      const result = await cloudinaryClient().api.delete_resources(chunk.map((asset) => asset.public_id), {
        resource_type: resourceType,
        type: "upload",
        invalidate: true,
      });
      for (const asset of chunk) {
        if (["deleted", "not_found"].includes(result.deleted?.[asset.public_id])) {
          deletedAssets += 1;
          deletedBytes += Number(asset.bytes || 0);
        }
      }
    }
  }

  const remainingGroups = await Promise.all(["image", "raw", "video"].map(listLegacyAssets));
  const remainingLegacyAssets = remainingGroups.reduce((sum, assets) => sum + assets.length, 0);
  await writeAudit(db, "legacy_cloudinary_purged", decoded, {
    organizationId: caller.organizationId || null,
    projectId: null,
    publicId: null,
  }, { deletedAssets, deletedBytes, cleanedTaskReferences, deletedProjectFileRecords, cleanedProfilePhotos, remainingLegacyAssets });
  return response.status(200).json({
    ok: true,
    deletedAssets,
    deletedBytes,
    cleanedTaskReferences,
    deletedProjectFileRecords,
    cleanedProfilePhotos,
    remainingLegacyAssets,
  });
}

export default async function handler(request, response) {
  response.setHeader("Cache-Control", "private, no-store");
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }
  const decoded = await authenticate(request);
  if (!decoded) return response.status(401).json({ error: "Unauthorized" });
  let body;
  try { body = await parseJsonBody(request); }
  catch { return response.status(400).json({ error: "Invalid JSON body" }); }
  const db = adminDb();
  try {
    if (body.action === "signUpload") return await handleSignUpload({ response, db, decoded, body });
    if (body.action === "finalizeUpload") return await handleFinalizeUpload({ response, db, decoded, body });
    if (body.action === "download") return await handleDownload({ response, db, decoded, body });
    if (body.action === "delete") return await handleDelete({ response, db, decoded, body });
    if (body.action === "deleteTask") return await handleDeleteTask({ response, db, decoded, body });
    if (body.action === "purgeLegacyFiles") return await handlePurgeLegacyFiles({ response, db, decoded, body });
    return response.status(400).json({ error: "Unsupported action" });
  } catch (error) {
    console.error("files endpoint failed", error);
    return response.status(500).json({ error: "File operation failed" });
  }
}
