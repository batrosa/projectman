// Server-side organization lifecycle: preview-by-code, create, and
// regenerate-invite-code — all via the Admin SDK. This lets the `organizations`
// collection stop being client-readable/listable, which closes the invite-code
// ENUMERATION hole: previously `allow read: if request.auth != null` let any
// authenticated user list every organization and harvest its inviteCode, then
// join an arbitrary org. Joining itself lives in api/join-org.
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../lib/firebase-admin.js";
import { buildAuthProfilePatch, selectedProviderId } from "../lib/auth-profile.js";
import {
  activeOrganizationStatsPatch,
  emptyOrganizationStats,
  ensureScopedOrganizationStats,
  organizationStatsPatch,
} from "../lib/organization-stats.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing 0/O, 1/I
const MAX_ORG_NAME = 80;
const AUDIT_LOG_COLLECTION = "auditLogs";
const MEMBERSHIP_COLLECTION = "organizationMemberships";
const VALID_ORG_ROLES = new Set(["owner", "admin", "moderator", "employee", "reader"]);

async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function randomCode() {
  let code = "";
  for (let i = 0; i < 6; i += 1) code += CODE_CHARS.charAt(Math.floor(Math.random() * CODE_CHARS.length));
  return code;
}

async function writeAuditLog(db, { action, actorUid, organizationId = null, targetUid = null, metadata = {} }) {
  try {
    await db.collection(AUDIT_LOG_COLLECTION).add({
      action,
      actorUid,
      organizationId,
      targetUid,
      metadata,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (error) {
    console.error("org audit log failed", { action, actorUid, organizationId, targetUid, error });
  }
}

// Server-side uniqueness check (the client can no longer query organizations).
async function generateUniqueCode(db) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = randomCode();
    const snap = await db.collection("organizations").where("inviteCode", "==", code).limit(1).get();
    if (snap.empty) return code;
  }
  return randomCode() + randomCode(); // astronomically unlikely fallback
}

function membershipDocId(orgId, userId) {
  return `${orgId}_${userId}`;
}

function membershipRef(db, orgId, userId) {
  return db.collection(MEMBERSHIP_COLLECTION).doc(membershipDocId(orgId, userId));
}

function publicIdentityFields(userData = {}) {
  return {
    firstName: userData.firstName || "",
    lastName: userData.lastName || "",
    displayName: userData.displayName || "",
    email: userData.email || "",
    telegramChatId: userData.telegramChatId || null,
    telegramUsername: userData.telegramUsername || null,
    profilePhotoUrl: userData.profilePhotoUrl || null,
    authProvider: userData.authProvider || null,
    lastLoginAt: userData.lastLoginAt || null,
    lastSeenAt: userData.lastSeenAt || null,
    lastSeenClientAt: userData.lastSeenClientAt || null,
  };
}

function canSeeInviteCode(orgRole) {
  return orgRole === "owner" || orgRole === "admin";
}

function organizationPayload(orgId, orgData = {}, orgRole, membersCount = orgData.membersCount || 0) {
  const organization = {
    id: orgId,
    name: orgData.name || "",
    ownerId: orgData.ownerId || null,
    membersCount,
    settings: orgData.settings || null,
  };
  if (canSeeInviteCode(orgRole)) {
    organization.inviteCode = orgData.inviteCode || null;
  }
  return organization;
}

function activeUserPatch(orgId, orgRole, allowedProjects, stats = null) {
  const patch = {
    organizationId: orgId,
    orgRole,
    ...(stats ? activeOrganizationStatsPatch(stats) : {}),
  };
  if (Array.isArray(allowedProjects)) patch.allowedProjects = allowedProjects;
  else patch.allowedProjects = FieldValue.delete();
  return patch;
}

function replaceDenormalizedName(value, userIds, userId, displayName) {
  if (!Array.isArray(userIds)) return null;
  const index = userIds.indexOf(userId);
  if (index < 0) return null;
  const names = String(value || "").split(",").map((name) => name.trim());
  while (names.length <= index) names.push("");
  if (names[index] === displayName) return null;
  names[index] = displayName;
  return names.filter(Boolean).join(", ");
}

function membershipPatch({ organizationId, userId, orgRole, userData, allowedProjects, includeJoinedAt = false }) {
  const patch = {
    organizationId,
    userId,
    orgRole,
    ...publicIdentityFields(userData),
    updatedAt: FieldValue.serverTimestamp(),
  };
  if (Array.isArray(allowedProjects)) patch.allowedProjects = allowedProjects;
  if (includeJoinedAt) patch.joinedAt = FieldValue.serverTimestamp();
  return patch;
}

async function ensureActiveMembership(db, userId, userData) {
  const orgId = userData && userData.organizationId;
  if (!orgId) return;
  const ref = membershipRef(db, orgId, userId);
  const snap = await ref.get();
  if (snap.exists) return;
  await ref.set(membershipPatch({
    organizationId: orgId,
    userId,
    orgRole: userData.orgRole || "employee",
    allowedProjects: Array.isArray(userData.allowedProjects) ? userData.allowedProjects : undefined,
    userData,
    includeJoinedAt: true,
  }), { merge: true });
}

async function backfillLegacyMembershipsForOrg(db, orgId) {
  if (!orgId) return { legacyUsers: 0, memberships: 0 };
  const [legacyUsersSnap, membershipsSnap] = await Promise.all([
    db.collection("users").where("organizationId", "==", orgId).get(),
    db.collection(MEMBERSHIP_COLLECTION).where("organizationId", "==", orgId).get(),
  ]);
  const existingUserIds = new Set();
  membershipsSnap.docs.forEach((doc) => {
    const data = doc.data() || {};
    if (data.userId) existingUserIds.add(data.userId);
  });

  const CHUNK = 450;
  let batch = db.batch();
  let ops = 0;
  const flush = async () => {
    if (ops > 0) {
      await batch.commit();
      batch = db.batch();
      ops = 0;
    }
  };

  for (const userDoc of legacyUsersSnap.docs) {
    const userData = userDoc.data() || {};
    const alreadyExists = existingUserIds.has(userDoc.id);
    batch.set(
      membershipRef(db, orgId, userDoc.id),
      membershipPatch({
        organizationId: orgId,
        userId: userDoc.id,
        orgRole: userData.orgRole || "employee",
        allowedProjects: Array.isArray(userData.allowedProjects) ? userData.allowedProjects : undefined,
        userData,
        includeJoinedAt: !alreadyExists,
      }),
      { merge: true }
    );
    ops += 1;
    if (ops >= CHUNK) await flush();
  }
  await flush();

  return {
    legacyUsers: legacyUsersSnap.size,
    memberships: Math.max(membershipsSnap.size, legacyUsersSnap.size),
  };
}

async function loadCaller(db, uid) {
  const userSnap = await db.collection("users").doc(uid).get();
  if (!userSnap.exists) return null;
  return userSnap.data() || {};
}

async function countOrgProjects(db, orgId) {
  const snap = await db.collection("projects").where("organizationId", "==", orgId).get();
  return snap.size;
}

async function countOrgMemberships(db, orgId, fallback = 0) {
  try {
    const [membershipsSnap, legacyUsersSnap] = await Promise.all([
      db.collection(MEMBERSHIP_COLLECTION).where("organizationId", "==", orgId).get(),
      db.collection("users").where("organizationId", "==", orgId).get(),
    ]);
    return Math.max(membershipsSnap.size || 0, legacyUsersSnap.size || 0, fallback || 0);
  } catch {
    return fallback || 0;
  }
}

async function buildOrganizationRow(db, membershipDoc, activeOrgId) {
  const membership = membershipDoc.data() || {};
  const orgId = membership.organizationId;
  if (!orgId) return null;
  const orgSnap = await db.collection("organizations").doc(orgId).get();
  if (!orgSnap.exists) return null;
  await backfillLegacyMembershipsForOrg(db, orgId);
  const orgData = orgSnap.data() || {};
  const [projectsCount, membersCount] = await Promise.all([
    countOrgProjects(db, orgId),
    countOrgMemberships(db, orgId, orgData.membersCount || 0),
  ]);
  return {
    id: orgId,
    name: orgData.name || "",
    role: membership.orgRole || "employee",
    projectsCount,
    membersCount,
    active: orgId === activeOrgId,
  };
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

  const action = String(body.action || "");
  const db = adminDb();

  // Common post-auth bootstrap for web and iOS. It makes Google/Apple users
  // share the same users/{firebaseUid} profile on every platform and never
  // overwrites organization, role or a name already confirmed by the user.
  if (action === "bootstrapAuth") {
    try {
      const userRef = db.collection("users").doc(decoded.uid);
      const [userSnap, authUser] = await Promise.all([
        userRef.get(),
        adminAuth().getUser(decoded.uid),
      ]);
      const existing = userSnap.exists ? (userSnap.data() || {}) : {};
      const signInProvider = String(decoded.firebase?.sign_in_provider || "");
      const incomingProvider = selectedProviderId(authUser, existing, signInProvider);
      const storedProvider = String(existing.authProvider || "");
      if (storedProvider && incomingProvider && storedProvider !== incomingProvider) {
        return response.status(409).json({
          code: "AUTH_PROVIDER_MISMATCH",
          authProvider: storedProvider,
          error: "Этот аккаунт использует другой способ входа. Войдите тем способом, который выбрали при регистрации.",
        });
      }
      const patch = buildAuthProfilePatch({ authUser, existing, signInProvider });
      patch.lastLoginAt = FieldValue.serverTimestamp();
      patch.updatedAt = FieldValue.serverTimestamp();
      if (!userSnap.exists) patch.createdAt = FieldValue.serverTimestamp();
      await userRef.set(patch, { merge: true });
      return response.status(200).json({
        ok: true,
        uid: decoded.uid,
        email: patch.email || existing.email || "",
        authProvider: patch.authProvider || existing.authProvider || "",
      });
    } catch (error) {
      console.error("auth bootstrap failed", error);
      return response.status(500).json({ error: "Не удалось подготовить профиль" });
    }
  }

  if (action === "completeProfile") {
    const firstName = String(body.firstName || "").trim().replace(/\s+/g, " ").slice(0, 40);
    const lastName = String(body.lastName || "").trim().replace(/\s+/g, " ").slice(0, 40);
    if (firstName.length < 2 || lastName.length < 2) {
      return response.status(400).json({ error: "Введите имя и фамилию: минимум по 2 символа." });
    }
    try {
      const userRef = db.collection("users").doc(decoded.uid);
      const [userSnap, membershipsSnap, assigneeTasks, coCreatorTasks, createdTasks] = await Promise.all([
        userRef.get(),
        db.collection(MEMBERSHIP_COLLECTION).where("userId", "==", decoded.uid).get(),
        db.collection("tasks").where("assigneeIds", "array-contains", decoded.uid).get(),
        db.collection("tasks").where("coCreatorIds", "array-contains", decoded.uid).get(),
        db.collection("tasks").where("createdByUid", "==", decoded.uid).get(),
      ]);
      if (!userSnap.exists) return response.status(404).json({ error: "Профиль не найден" });

      const displayName = `${firstName} ${lastName}`;
      const userPatch = {
        firstName,
        lastName,
        displayName,
        profileCompleted: true,
        updatedAt: FieldValue.serverTimestamp(),
      };
      const membershipPatch = {
        firstName,
        lastName,
        displayName,
        updatedAt: FieldValue.serverTimestamp(),
      };

      // The roster is denormalized per organization. Update every membership
      // so the new name appears immediately in all teams after an org switch.
      const writes = [
        { ref: userRef, patch: userPatch },
        ...membershipsSnap.docs.map((doc) => ({ ref: doc.ref, patch: membershipPatch })),
      ];

      // Tasks keep display-name snapshots for fast web/iOS rendering. Refresh
      // those snapshots by UID so existing cards do not retain the old name.
      const taskDocs = new Map();
      [assigneeTasks, coCreatorTasks, createdTasks].forEach((snapshot) => {
        snapshot.docs.forEach((doc) => taskDocs.set(doc.ref.path, doc));
      });
      taskDocs.forEach((doc) => {
        const task = doc.data() || {};
        const patch = {};
        const assignee = replaceDenormalizedName(
          task.assignee,
          task.assigneeIds,
          decoded.uid,
          displayName
        );
        if (assignee !== null) patch.assignee = assignee;
        const coCreators = replaceDenormalizedName(
          task.coCreators,
          task.coCreatorIds,
          decoded.uid,
          displayName
        );
        if (coCreators !== null) patch.coCreators = coCreators;
        if (task.createdByUid === decoded.uid && task.createdBy !== displayName) {
          patch.createdBy = displayName;
        }
        if (Object.keys(patch).length > 0) writes.push({ ref: doc.ref, patch });
      });

      for (let offset = 0; offset < writes.length; offset += 400) {
        const batch = db.batch();
        writes.slice(offset, offset + 400).forEach(({ ref, patch }) => {
          batch.set(ref, patch, { merge: true });
        });
        await batch.commit();
      }

      return response.status(200).json({ ok: true, firstName, lastName, displayName });
    } catch (error) {
      console.error("profile completion failed", error);
      return response.status(500).json({ error: "Не удалось сохранить имя и фамилию" });
    }
  }

  // ── List organizations where the caller is a member. This is server-side
  // because the client cannot safely list organization docs or infer counts.
  if (action === "list") {
    try {
      const userData = await loadCaller(db, decoded.uid);
      if (!userData) return response.status(403).json({ error: "Профиль не найден" });
      await ensureActiveMembership(db, decoded.uid, userData);
      await ensureScopedOrganizationStats(db, decoded.uid, userData);

      const membershipsSnap = await db.collection(MEMBERSHIP_COLLECTION)
        .where("userId", "==", decoded.uid)
        .get();
      const rows = (await Promise.all(
        membershipsSnap.docs.map((doc) => buildOrganizationRow(db, doc, userData.organizationId || null))
      ))
        .filter(Boolean)
        .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, "ru"));

      return response.status(200).json({ ok: true, organizations: rows });
    } catch (error) {
      console.error("org list failed", error);
      return response.status(500).json({ error: "Не удалось загрузить организации" });
    }
  }

  if (action === "current") {
    const requestedOrgId = String(body.organizationId || "").trim();
    try {
      const userData = await loadCaller(db, decoded.uid);
      if (!userData) return response.status(403).json({ error: "Профиль не найден" });
      const orgId = userData.organizationId || null;
      if (!orgId) return response.status(404).json({ error: "Организация не выбрана" });
      if (requestedOrgId && requestedOrgId !== orgId) {
        return response.status(403).json({ error: "Нет доступа к этой организации" });
      }
      await ensureActiveMembership(db, decoded.uid, userData);
      const [orgSnap, backfill] = await Promise.all([
        db.collection("organizations").doc(orgId).get(),
        backfillLegacyMembershipsForOrg(db, orgId),
      ]);
      if (!orgSnap.exists) return response.status(404).json({ error: "Организация не найдена" });
      const statsByOrganization = await ensureScopedOrganizationStats(db, decoded.uid, userData);
      const activeStats = statsByOrganization.get(orgId) || emptyOrganizationStats();
      await db.collection("users").doc(decoded.uid).set(
        activeOrganizationStatsPatch(activeStats),
        { merge: true }
      );
      const orgData = orgSnap.data() || {};
      const orgRole = userData.orgRole || "employee";
      const membersCount = Math.max(orgData.membersCount || 0, backfill.memberships || 0, backfill.legacyUsers || 0);
      return response.status(200).json({
        ok: true,
        orgRole,
        allowedProjects: Array.isArray(userData.allowedProjects) ? userData.allowedProjects : [],
        organization: organizationPayload(orgId, orgData, orgRole, membersCount),
      });
    } catch (error) {
      console.error("org current failed", error);
      return response.status(500).json({ error: "Не удалось загрузить организацию" });
    }
  }

  // ── Switch the caller's ACTIVE organization. Existing Firestore rules and
  // client screens still use users/{uid}.organizationId/orgRole as the active
  // org scope, while organizationMemberships is the durable multi-org registry.
  if (action === "switch") {
    const orgId = String(body.organizationId || "").trim();
    if (!orgId) return response.status(400).json({ error: "organizationId required" });
    try {
      const [userData, memberSnap, orgSnap] = await Promise.all([
        loadCaller(db, decoded.uid),
        membershipRef(db, orgId, decoded.uid).get(),
        db.collection("organizations").doc(orgId).get(),
      ]);
      if (!userData) return response.status(403).json({ error: "Профиль не найден" });
      if (!memberSnap.exists || !orgSnap.exists) {
        return response.status(403).json({ error: "Нет доступа к этой организации" });
      }
      const backfill = await backfillLegacyMembershipsForOrg(db, orgId);
      const statsByOrganization = await ensureScopedOrganizationStats(db, decoded.uid, userData);
      const membership = memberSnap.data() || {};
      const orgRole = membership.orgRole || "employee";
      const allowedProjects = Array.isArray(membership.allowedProjects) ? membership.allowedProjects : undefined;
      const activeStats = statsByOrganization.get(orgId) || emptyOrganizationStats();
      const batch = db.batch();
      batch.set(
        db.collection("users").doc(decoded.uid),
        activeUserPatch(orgId, orgRole, allowedProjects, activeStats),
        { merge: true }
      );
      batch.set(
        membershipRef(db, orgId, decoded.uid),
        membershipPatch({
          organizationId: orgId,
          userId: decoded.uid,
          orgRole,
          allowedProjects,
          userData,
        }),
        { merge: true }
      );
      await batch.commit();
      const orgData = orgSnap.data() || {};
      const membersCount = Math.max(orgData.membersCount || 0, backfill.memberships || 0, backfill.legacyUsers || 0);
      return response.status(200).json({
        ok: true,
        orgRole,
        allowedProjects: allowedProjects || [],
        organization: organizationPayload(orgId, orgData, orgRole, membersCount),
      });
    } catch (error) {
      console.error("org switch failed", error);
      return response.status(500).json({ error: "Не удалось войти в организацию" });
    }
  }

  // ── Preview an org by invite code (for the "you're about to join X" card).
  // Returns only name + member count for a VALID code; without the code nothing
  // is revealed, and codes are unguessable (6 chars over 32-symbol alphabet).
  if (action === "preview") {
    const code = String(body.inviteCode || "").toUpperCase().trim();
    if (code.length < 4 || code.length > 24) return response.status(400).json({ error: "Некорректный код" });
    try {
      const snap = await db.collection("organizations").where("inviteCode", "==", code).limit(1).get();
      if (snap.empty) return response.status(404).json({ ok: false, error: "Организация не найдена" });
      const doc = snap.docs[0];
      const data = doc.data() || {};
      let membersCount = data.membersCount || 0;
      try {
        const members = await db.collection("users").where("organizationId", "==", doc.id).get();
        membersCount = members.size || membersCount;
      } catch { /* fall back to the stored count */ }
      return response.status(200).json({ ok: true, organization: { id: doc.id, name: data.name || "", membersCount } });
    } catch (error) {
      console.error("org preview failed", error);
      return response.status(500).json({ error: "Не удалось найти организацию" });
    }
  }

  // ── Create an organization (caller becomes owner).
  if (action === "create") {
    const name = String(body.name || "").trim();
    if (!name || name.length > MAX_ORG_NAME) return response.status(400).json({ error: "Некорректное название организации" });

    let userData;
    try {
      const userSnap = await db.collection("users").doc(decoded.uid).get();
      if (!userSnap.exists) return response.status(403).json({ error: "Профиль не найден" });
      userData = userSnap.data();
    } catch (error) {
      console.error("org create: load caller failed", error);
      return response.status(500).json({ error: "Не удалось проверить пользователя" });
    }
    try {
      const existing = await db.collection("organizations").where("name", "==", name).limit(1).get();
      if (!existing.empty) return response.status(409).json({ error: "Организация с таким названием уже существует" });
    } catch (error) {
      console.error("org create: name check failed", error);
      return response.status(500).json({ error: "Не удалось создать организацию" });
    }

    try {
      const inviteCode = await generateUniqueCode(db);
      const orgData = {
        name,
        inviteCode,
        ownerId: decoded.uid,
        createdAt: FieldValue.serverTimestamp(),
        membersCount: 1,
        plan: "free",
        settings: { maxUsers: 100, allowInvites: true },
      };
      const orgRef = db.collection("organizations").doc();
      const batch = db.batch();
      batch.set(orgRef, orgData);
      batch.set(
        membershipRef(db, orgRef.id, decoded.uid),
        {
          ...membershipPatch({
            organizationId: orgRef.id,
            userId: decoded.uid,
            orgRole: "owner",
            userData,
            includeJoinedAt: true,
          }),
          ...organizationStatsPatch(emptyOrganizationStats()),
        },
        { merge: true }
      );
      batch.set(
        db.collection("users").doc(decoded.uid),
        activeUserPatch(orgRef.id, "owner", undefined, emptyOrganizationStats()),
        { merge: true }
      );
      await batch.commit();
      await writeAuditLog(db, {
        action: "org.create",
        actorUid: decoded.uid,
        organizationId: orgRef.id,
        metadata: { name },
      });
      return response.status(200).json({
        ok: true,
        organization: { id: orgRef.id, name, inviteCode, ownerId: decoded.uid, membersCount: 1, settings: orgData.settings },
      });
    } catch (error) {
      console.error("org create: write failed", error);
      return response.status(500).json({ error: "Не удалось создать организацию" });
    }
  }

  // ── Rotate the invite code (owner/admin of their own org only).
  if (action === "regenerateCode") {
    let userData;
    try {
      const userSnap = await db.collection("users").doc(decoded.uid).get();
      userData = userSnap.exists ? userSnap.data() : null;
    } catch (error) {
      console.error("org regen: load caller failed", error);
      return response.status(500).json({ error: "Не удалось проверить пользователя" });
    }
    const orgId = userData && userData.organizationId;
    if (!orgId || !["owner", "admin"].includes(userData.orgRole)) {
      return response.status(403).json({ error: "Недостаточно прав" });
    }
    try {
      const inviteCode = await generateUniqueCode(db);
      await db.collection("organizations").doc(orgId).update({ inviteCode });
      await writeAuditLog(db, {
        action: "org.regenerateInviteCode",
        actorUid: decoded.uid,
        organizationId: orgId,
      });
      return response.status(200).json({ ok: true, inviteCode });
    } catch (error) {
      console.error("org regen: write failed", error);
      return response.status(500).json({ error: "Не удалось обновить код" });
    }
  }

  // ── Leave the org (self). Server-side so it's atomic and doesn't hit the
  // client ordering trap (clearing membership before decrementing membersCount
  // used to fail the rule). Also clears allowedProjects so a stale per-project
  // restriction never follows the user into a future org.
  if (action === "leave") {
    let userData;
    try {
      const snap = await db.collection("users").doc(decoded.uid).get();
      userData = snap.exists ? snap.data() : null;
    } catch (error) {
      console.error("org leave: load caller failed", error);
      return response.status(500).json({ error: "Не удалось проверить пользователя" });
    }
    const orgId = userData && userData.organizationId;
    if (!orgId) return response.status(200).json({ ok: true }); // already not in an active org
    const memberSnap = await membershipRef(db, orgId, decoded.uid).get();
    const membership = memberSnap.exists ? (memberSnap.data() || {}) : {};
    if ((membership.orgRole || userData.orgRole) === "owner") {
      return response.status(403).json({ error: "Владелец не может покинуть организацию" });
    }
    try {
      // Atomic: clear membership + membersCount-- in one batch so a partial
      // failure can't desync the counter from actual membership.
      const batch = db.batch();
      if (memberSnap.exists) batch.delete(membershipRef(db, orgId, decoded.uid));
      batch.set(
        db.collection("users").doc(decoded.uid),
        { organizationId: null, orgRole: null, allowedProjects: FieldValue.delete() },
        { merge: true }
      );
      batch.update(db.collection("organizations").doc(orgId), { membersCount: FieldValue.increment(-1) });
      await batch.commit();
      await writeAuditLog(db, {
        action: "org.leave",
        actorUid: decoded.uid,
        organizationId: orgId,
        targetUid: decoded.uid,
      });
      return response.status(200).json({ ok: true });
    } catch (error) {
      console.error("org leave: write failed", error);
      return response.status(500).json({ error: "Не удалось покинуть организацию" });
    }
  }

  // ── Remove a member (owner/admin removes someone else). Server-side so
  // membersCount can only ever be changed here (no client rule needed).
  if (action === "removeMember") {
    const targetUid = String(body.userId || "").trim();
    if (!targetUid) return response.status(400).json({ error: "userId required" });
    if (targetUid === decoded.uid) return response.status(400).json({ error: "Используйте выход из организации" });

    let callerData, targetData, targetMemberSnap;
    try {
      const [callerSnap, targetSnap] = await Promise.all([
        db.collection("users").doc(decoded.uid).get(),
        db.collection("users").doc(targetUid).get(),
      ]);
      callerData = callerSnap.exists ? callerSnap.data() : null;
      targetData = targetSnap.exists ? targetSnap.data() : null;
    } catch (error) {
      console.error("org removeMember: load failed", error);
      return response.status(500).json({ error: "Не удалось проверить пользователей" });
    }
    const orgId = callerData && callerData.organizationId;
    if (!orgId || !["owner", "admin"].includes(callerData.orgRole)) {
      return response.status(403).json({ error: "Недостаточно прав" });
    }
    try {
      targetMemberSnap = await membershipRef(db, orgId, targetUid).get();
    } catch (error) {
      console.error("org removeMember: load membership failed", error);
      return response.status(500).json({ error: "Не удалось проверить участника" });
    }
    if (!targetData || !targetMemberSnap.exists) {
      return response.status(404).json({ error: "Участник не найден в вашей организации" });
    }
    const targetMembership = targetMemberSnap.data() || {};
    const targetRole = targetMembership.orgRole || targetData.orgRole || "employee";
    if (targetRole === "owner") {
      return response.status(403).json({ error: "Нельзя удалить владельца" });
    }
    if (callerData.orgRole === "admin" && targetRole === "admin") {
      return response.status(403).json({ error: "Администратор не может удалить другого администратора" });
    }
    try {
      // Atomic: clear the target's membership + membersCount-- in one batch.
      const batch = db.batch();
      batch.delete(membershipRef(db, orgId, targetUid));
      if (targetData.organizationId === orgId) {
        batch.set(
          db.collection("users").doc(targetUid),
          { organizationId: null, orgRole: null, allowedProjects: FieldValue.delete() },
          { merge: true }
        );
      }
      batch.update(db.collection("organizations").doc(orgId), { membersCount: FieldValue.increment(-1) });
      await batch.commit();
      await writeAuditLog(db, {
        action: "org.removeMember",
        actorUid: decoded.uid,
        organizationId: orgId,
        targetUid,
        metadata: { targetRole },
      });
      return response.status(200).json({ ok: true });
    } catch (error) {
      console.error("org removeMember: write failed", error);
      return response.status(500).json({ error: "Не удалось удалить участника" });
    }
  }

  if (action === "updateMemberRole") {
    const targetUid = String(body.userId || "").trim();
    const newRole = String(body.orgRole || "").trim();
    if (!targetUid || !VALID_ORG_ROLES.has(newRole)) {
      return response.status(400).json({ error: "Некорректная роль" });
    }
    if (newRole === "owner") {
      return response.status(403).json({ error: "Роль владельца нельзя назначить вручную" });
    }

    let callerData, targetData, memberSnap;
    try {
      const [callerSnap, targetSnap] = await Promise.all([
        db.collection("users").doc(decoded.uid).get(),
        db.collection("users").doc(targetUid).get(),
      ]);
      callerData = callerSnap.exists ? callerSnap.data() : null;
      targetData = targetSnap.exists ? targetSnap.data() : null;
    } catch (error) {
      console.error("org updateMemberRole: load failed", error);
      return response.status(500).json({ error: "Не удалось проверить пользователей" });
    }
    const orgId = callerData && callerData.organizationId;
    if (!orgId || !["owner", "admin"].includes(callerData.orgRole)) {
      return response.status(403).json({ error: "Недостаточно прав" });
    }
    try {
      memberSnap = await membershipRef(db, orgId, targetUid).get();
    } catch (error) {
      console.error("org updateMemberRole: membership load failed", error);
      return response.status(500).json({ error: "Не удалось проверить участника" });
    }
    if (!targetData || !memberSnap.exists) {
      return response.status(404).json({ error: "Участник не найден в вашей организации" });
    }
    const currentRole = (memberSnap.data() || {}).orgRole || targetData.orgRole || "employee";
    if (currentRole === "owner") return response.status(403).json({ error: "Нельзя менять роль владельца" });
    if (callerData.orgRole === "admin" && (currentRole === "admin" || newRole === "admin")) {
      return response.status(403).json({ error: "Администратор не может управлять администраторами" });
    }

    try {
      const batch = db.batch();
      batch.set(membershipRef(db, orgId, targetUid), {
        orgRole: newRole,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      if (targetData.organizationId === orgId) {
        batch.set(db.collection("users").doc(targetUid), { orgRole: newRole }, { merge: true });
      }
      await batch.commit();
      await writeAuditLog(db, {
        action: "org.updateMemberRole",
        actorUid: decoded.uid,
        organizationId: orgId,
        targetUid,
        metadata: { oldRole: currentRole, newRole },
      });
      return response.status(200).json({ ok: true });
    } catch (error) {
      console.error("org updateMemberRole: write failed", error);
      return response.status(500).json({ error: "Не удалось изменить роль" });
    }
  }

  if (action === "updateMemberAccess") {
    const targetUid = String(body.userId || "").trim();
    const allowedProjects = Array.isArray(body.allowedProjects)
      ? body.allowedProjects.map((id) => String(id || "").trim()).filter(Boolean).slice(0, 500)
      : [];
    if (!targetUid) return response.status(400).json({ error: "userId required" });

    let callerData, targetData, memberSnap;
    try {
      const [callerSnap, targetSnap] = await Promise.all([
        db.collection("users").doc(decoded.uid).get(),
        db.collection("users").doc(targetUid).get(),
      ]);
      callerData = callerSnap.exists ? callerSnap.data() : null;
      targetData = targetSnap.exists ? targetSnap.data() : null;
    } catch (error) {
      console.error("org updateMemberAccess: load failed", error);
      return response.status(500).json({ error: "Не удалось проверить пользователей" });
    }
    const orgId = callerData && callerData.organizationId;
    if (!orgId || !["owner", "admin"].includes(callerData.orgRole)) {
      return response.status(403).json({ error: "Недостаточно прав" });
    }
    try {
      memberSnap = await membershipRef(db, orgId, targetUid).get();
    } catch (error) {
      console.error("org updateMemberAccess: membership load failed", error);
      return response.status(500).json({ error: "Не удалось проверить участника" });
    }
    if (!targetData || !memberSnap.exists) {
      return response.status(404).json({ error: "Участник не найден в вашей организации" });
    }

    try {
      const projectIds = allowedProjects.filter((id) => id !== "__no_access__");
      if (projectIds.length > 0) {
        const projectSnaps = await Promise.all(projectIds.map((id) => db.collection("projects").doc(id).get()));
        const invalid = projectSnaps.some((snap) => !snap.exists || (snap.data() || {}).organizationId !== orgId);
        if (invalid) return response.status(400).json({ error: "В списке есть проект не из этой организации" });
      }

      const batch = db.batch();
      batch.set(membershipRef(db, orgId, targetUid), {
        allowedProjects,
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      if (targetData.organizationId === orgId) {
        batch.set(db.collection("users").doc(targetUid), { allowedProjects }, { merge: true });
      }
      await batch.commit();
      await writeAuditLog(db, {
        action: "org.updateMemberAccess",
        actorUid: decoded.uid,
        organizationId: orgId,
        targetUid,
        metadata: { allowedProjectsCount: allowedProjects.length },
      });
      return response.status(200).json({ ok: true });
    } catch (error) {
      console.error("org updateMemberAccess: write failed", error);
      return response.status(500).json({ error: "Не удалось изменить доступ" });
    }
  }

  if (action === "deleteOrg") {
    // Owner-only cascade delete. Was client-side (deleteOrganization in
    // script.js) and only cleared users + deleted the org doc, orphaning every
    // project/task/file. Do the full cascade server-side (Admin SDK).
    let userData;
    try {
      const userSnap = await db.collection("users").doc(decoded.uid).get();
      userData = userSnap.exists ? userSnap.data() : null;
    } catch (error) {
      console.error("org deleteOrg: load caller failed", error);
      return response.status(500).json({ error: "Не удалось проверить пользователя" });
    }
    const orgId = userData && userData.organizationId;
    if (!orgId) return response.status(400).json({ error: "Вы не состоите в организации" });
    if (userData.orgRole !== "owner") {
      return response.status(403).json({ error: "Только владелец может удалить организацию" });
    }

    try {
      const projectsSnap = await db.collection("projects").where("organizationId", "==", orgId).get();

      // Collect every doc to delete: each project's files subcollection, its
      // tasks (top-level collection keyed by projectId), and the project doc.
      const deleteRefs = [];
      for (const projDoc of projectsSnap.docs) {
        const filesSnap = await projDoc.ref.collection("files").get();
        filesSnap.docs.forEach((d) => deleteRefs.push(d.ref));
        const tasksSnap = await db.collection("tasks").where("projectId", "==", projDoc.id).get();
        tasksSnap.docs.forEach((d) => deleteRefs.push(d.ref));
        deleteRefs.push(projDoc.ref);
      }
      deleteRefs.push(db.collection("organizations").doc(orgId));

      const [membersSnap, activeUsersSnap] = await Promise.all([
        db.collection(MEMBERSHIP_COLLECTION).where("organizationId", "==", orgId).get(),
        db.collection("users").where("organizationId", "==", orgId).get(),
      ]);

      // Commit in chunks well under Firestore's 500-ops/batch limit. Delete the
      // data + org doc FIRST, then clear members LAST — so a partial failure
      // leaves the owner still an owner able to retry, rather than orphaned.
      const CHUNK = 450;
      let batch = db.batch();
      let ops = 0;
      const flush = async () => {
        if (ops > 0) { await batch.commit(); batch = db.batch(); ops = 0; }
      };
      for (const ref of deleteRefs) {
        batch.delete(ref);
        if (++ops >= CHUNK) await flush();
      }
      for (const memberDoc of membersSnap.docs) {
        batch.delete(memberDoc.ref);
        if (++ops >= CHUNK) await flush();
      }
      for (const memberDoc of activeUsersSnap.docs) {
        batch.set(
          memberDoc.ref,
          { organizationId: null, orgRole: null, allowedProjects: FieldValue.delete() },
          { merge: true }
        );
        if (++ops >= CHUNK) await flush();
      }
      await flush();

      await writeAuditLog(db, {
        action: "org.delete",
        actorUid: decoded.uid,
        organizationId: orgId,
        metadata: { deletedProjects: projectsSnap.size, clearedMembers: membersSnap.size },
      });

      return response.status(200).json({ ok: true, deletedProjects: projectsSnap.size, clearedMembers: membersSnap.size });
    } catch (error) {
      console.error("org deleteOrg: cascade failed", error);
      return response.status(500).json({ error: "Не удалось удалить организацию" });
    }
  }

  return response.status(400).json({ error: "Unknown action" });
}
