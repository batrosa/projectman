// Server-side organization join. The invite code is validated here with the
// Admin SDK — previously joining was a direct client write gated only by a
// Firestore rule that did NOT check the invite code, so any authenticated user
// could add themselves to ANY organization by writing organizationId directly.
// The client no longer self-assigns organizationId (that rule branch is
// removed); it calls this endpoint, which is the only path that grants
// membership.
import { FieldValue } from "firebase-admin/firestore";
import { adminAuth, adminDb } from "../lib/firebase-admin.js";

async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
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

  // Caller must not already belong to an organization (one org per user).
  let userData;
  try {
    const userSnap = await db.collection("users").doc(decoded.uid).get();
    if (!userSnap.exists) return response.status(403).json({ error: "Профиль не найден" });
    userData = userSnap.data();
  } catch (error) {
    console.error("join-org: failed to load caller", error);
    return response.status(500).json({ error: "Не удалось проверить пользователя" });
  }
  if (userData.organizationId) {
    return response.status(409).json({ error: "Вы уже состоите в организации" });
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
    organization: {
      id: orgDoc.id,
      name: orgData.name || "",
      inviteCode: orgData.inviteCode || null,
      membersCount: (orgData.membersCount || 0) + 1,
      ownerId: orgData.ownerId || null,
      settings: orgData.settings || null,
    },
  });
}
