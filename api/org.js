// Server-side organization lifecycle: preview-by-code, create, and
// regenerate-invite-code — all via the Admin SDK. This lets the `organizations`
// collection stop being client-readable/listable, which closes the invite-code
// ENUMERATION hole: previously `allow read: if request.auth != null` let any
// authenticated user list every organization and harvest its inviteCode, then
// join an arbitrary org. Joining itself lives in api/join-org.
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../lib/firebase-admin.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing 0/O, 1/I
const MAX_ORG_NAME = 80;

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

// Server-side uniqueness check (the client can no longer query organizations).
async function generateUniqueCode(db) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const code = randomCode();
    const snap = await db.collection("organizations").where("inviteCode", "==", code).limit(1).get();
    if (snap.empty) return code;
  }
  return randomCode() + randomCode(); // astronomically unlikely fallback
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
    if (userData.organizationId) return response.status(409).json({ error: "Вы уже состоите в организации" });

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
      const orgRef = await db.collection("organizations").add(orgData);
      await db.collection("users").doc(decoded.uid).set(
        { organizationId: orgRef.id, orgRole: "owner" },
        { merge: true }
      );
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
    if (!orgId) return response.status(200).json({ ok: true }); // already not in an org
    if (userData.orgRole === "owner") {
      return response.status(403).json({ error: "Владелец не может покинуть организацию" });
    }
    try {
      // Atomic: clear membership + membersCount-- in one batch so a partial
      // failure can't desync the counter from actual membership.
      const batch = db.batch();
      batch.set(
        db.collection("users").doc(decoded.uid),
        { organizationId: null, orgRole: null, allowedProjects: FieldValue.delete() },
        { merge: true }
      );
      batch.update(db.collection("organizations").doc(orgId), { membersCount: FieldValue.increment(-1) });
      await batch.commit();
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

    let callerData, targetData;
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
    if (!targetData || targetData.organizationId !== orgId) {
      return response.status(404).json({ error: "Участник не найден в вашей организации" });
    }
    if (targetData.orgRole === "owner") {
      return response.status(403).json({ error: "Нельзя удалить владельца" });
    }
    if (callerData.orgRole === "admin" && targetData.orgRole === "admin") {
      return response.status(403).json({ error: "Администратор не может удалить другого администратора" });
    }
    try {
      // Atomic: clear the target's membership + membersCount-- in one batch.
      const batch = db.batch();
      batch.set(
        db.collection("users").doc(targetUid),
        { organizationId: null, orgRole: null, allowedProjects: FieldValue.delete() },
        { merge: true }
      );
      batch.update(db.collection("organizations").doc(orgId), { membersCount: FieldValue.increment(-1) });
      await batch.commit();
      return response.status(200).json({ ok: true });
    } catch (error) {
      console.error("org removeMember: write failed", error);
      return response.status(500).json({ error: "Не удалось удалить участника" });
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

      const membersSnap = await db.collection("users").where("organizationId", "==", orgId).get();

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
        batch.set(
          memberDoc.ref,
          { organizationId: null, orgRole: null, allowedProjects: FieldValue.delete() },
          { merge: true }
        );
        if (++ops >= CHUNK) await flush();
      }
      await flush();

      return response.status(200).json({ ok: true, deletedProjects: projectsSnap.size, clearedMembers: membersSnap.size });
    } catch (error) {
      console.error("org deleteOrg: cascade failed", error);
      return response.status(500).json({ error: "Не удалось удалить организацию" });
    }
  }

  return response.status(400).json({ error: "Unknown action" });
}
