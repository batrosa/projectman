// Server-side organization join. The invite code is validated here with the
// Admin SDK — previously joining was a direct client write gated only by a
// Firestore rule that did NOT check the invite code, so any authenticated user
// could add themselves to ANY organization by writing organizationId directly.
// The client no longer self-assigns organizationId (that rule branch is
// removed); it calls this endpoint, which is the only path that grants
// membership.
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../lib/firebase-admin.js";

const MEMBERSHIP_COLLECTION = "organizationMemberships";

async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function membershipDocId(orgId, userId) {
  return `${orgId}_${userId}`;
}

function membershipRef(db, orgId, userId) {
  return db.collection(MEMBERSHIP_COLLECTION).doc(membershipDocId(orgId, userId));
}

function publicUserFields(userData = {}) {
  return {
    firstName: userData.firstName || "",
    lastName: userData.lastName || "",
    displayName: userData.displayName || "",
    email: userData.email || "",
    telegramChatId: userData.telegramChatId || null,
    telegramUsername: userData.telegramUsername || null,
    profilePhotoUrl: userData.profilePhotoUrl || null,
    totalXP: userData.totalXP || 0,
    level: userData.level || 1,
    completedTasksCount: userData.completedTasksCount || 0,
    onTimeTasksCount: userData.onTimeTasksCount || 0,
    noRevisionTasksCount: userData.noRevisionTasksCount || 0,
  };
}

function canSeeInviteCode(orgRole) {
  return orgRole === "owner" || orgRole === "admin";
}

function organizationPayload(orgId, orgData = {}, orgRole, membersCount) {
  const organization = {
    id: orgId,
    name: orgData.name || "",
    membersCount,
    ownerId: orgData.ownerId || null,
    settings: orgData.settings || null,
  };
  if (canSeeInviteCode(orgRole)) {
    organization.inviteCode = orgData.inviteCode || null;
  }
  return organization;
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

  const code = String(body.inviteCode || "").toUpperCase().trim();
  if (code.length < 4 || code.length > 24) {
    return response.status(400).json({ error: "Некорректный код приглашения" });
  }

  const db = adminDb();

  let userData;
  try {
    const userSnap = await db.collection("users").doc(decoded.uid).get();
    if (!userSnap.exists) return response.status(403).json({ error: "Профиль не найден" });
    userData = userSnap.data();
  } catch (error) {
    console.error("join-org: failed to load caller", error);
    return response.status(500).json({ error: "Не удалось проверить пользователя" });
  }

  // Validate the invite code against real organizations (server-side, Admin SDK).
  let orgDoc;
  try {
    const orgSnap = await db.collection("organizations").where("inviteCode", "==", code).limit(1).get();
    if (orgSnap.empty) return response.status(404).json({ error: "Организация не найдена" });
    orgDoc = orgSnap.docs[0];
  } catch (error) {
    console.error("join-org: failed to look up organization", error);
    return response.status(500).json({ error: "Не удалось найти организацию" });
  }

  const orgData = orgDoc.data() || {};

  try {
    const existingMember = await membershipRef(db, orgDoc.id, decoded.uid).get();
    if (existingMember.exists) {
      const membership = existingMember.data() || {};
      const orgRole = membership.orgRole || "employee";
      const allowedProjects = Array.isArray(membership.allowedProjects) ? membership.allowedProjects : undefined;
      const patch = { organizationId: orgDoc.id, orgRole };
      if (allowedProjects) patch.allowedProjects = allowedProjects;
      else patch.allowedProjects = FieldValue.delete();
      await db.collection("users").doc(decoded.uid).set(patch, { merge: true });
      return response.status(200).json({
        ok: true,
        orgRole,
        allowedProjects: allowedProjects || [],
        organization: organizationPayload(orgDoc.id, orgData, orgRole, orgData.membersCount || 0),
      });
    }

    // Atomic: membership + membersCount++ in one WriteBatch, so a partial
    // failure can't leave the user in the org without the count (or vice versa).
    const batch = db.batch();
    batch.set(
      db.collection("users").doc(decoded.uid),
      // Clear any stale per-project restriction from a previous org so it can't
      // follow the user in and hide/scramble access in the new org.
      { organizationId: orgDoc.id, orgRole: "employee", allowedProjects: FieldValue.delete() },
      { merge: true }
    );
    batch.set(
      membershipRef(db, orgDoc.id, decoded.uid),
      {
        organizationId: orgDoc.id,
        userId: decoded.uid,
        orgRole: "employee",
        ...publicUserFields(userData),
        joinedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
    batch.update(db.collection("organizations").doc(orgDoc.id), {
      membersCount: FieldValue.increment(1),
    });
    await batch.commit();
  } catch (error) {
    console.error("join-org: failed to write membership", error);
    return response.status(500).json({ error: "Не удалось вступить в организацию" });
  }

  return response.status(200).json({
    ok: true,
    orgRole: "employee",
    allowedProjects: [],
    organization: organizationPayload(orgDoc.id, orgData, "employee", (orgData.membersCount || 0) + 1),
  });
}
