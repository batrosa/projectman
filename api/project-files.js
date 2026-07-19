// Project-level file upload metadata endpoint.
// The client uploads the raw file to Cloudinary directly (resource_type: "raw")
// and then calls this endpoint with the resulting URL + metadata. This endpoint
// creates the Firestore doc under projects/{projectId}/files/{fileId} (the
// Firestore rules only allow the Admin SDK to write there, see firestore.rules)
// and kicks off text extraction in the background via lib/material-parser.js,
// so a later AI agent task can read the extracted text.
import { waitUntil } from "@vercel/functions";
import { adminDb, adminAuth } from "../lib/firebase-admin.js";
import { extractMaterialText } from "../lib/material-parser.js";
import { buildProjectKnowledgeIndex, PROJECT_KNOWLEDGE_VERSION } from "../lib/project-knowledge.js";

export const ALLOWED_EXTENSIONS = ["md", "xlsx", "xlsm", "pdf", "docx"];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

// The app's own Cloudinary cloud — the only origin server-side code is
// allowed to fetch() from. Without this check, `url` was an attacker-
// controlled SSRF vector: a caller could pass e.g.
// http://169.254.169.254/latest/meta-data/... (cloud metadata endpoints) or
// any internal/private address and have this server fetch it on their
// behalf. Exported as a pure function so it's unit-testable without mocking
// Firestore/network.
const ALLOWED_FILE_URL_PREFIX = "https://res.cloudinary.com/dwoa1lqz1/";

export function isAllowedFileUrl(url) {
  return typeof url === "string" && url.startsWith(ALLOWED_FILE_URL_PREFIX);
}

// Pure validation logic, extracted so it can be unit tested without touching
// Firestore/network. Returns { ok: true } or { ok: false, status, error }.
export function validateUpload({ projectId, filename, url, sizeBytes }) {
  if (!projectId || !filename || !url) {
    return { ok: false, status: 400, error: "projectId, filename and url are required" };
  }

  const ext = extensionOf(filename);
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return { ok: false, status: 400, error: `Unsupported file type: .${ext || "?"}` };
  }

  if (sizeBytes !== undefined && sizeBytes !== null && sizeBytes !== "") {
    const size = Number(sizeBytes);
    if (!Number.isFinite(size) || size < 0 || size > MAX_FILE_BYTES) {
      return { ok: false, status: 400, error: "Invalid or oversized file size" };
    }
  }

  return { ok: true, ext };
}

// Case-insensitive, robust against filenames with multiple dots or no
// extension at all (returns "" in that case, which never matches
// ALLOWED_EXTENSIONS).
export function extensionOf(filename) {
  const clean = String(filename || "").trim().toLowerCase();
  const idx = clean.lastIndexOf(".");
  if (idx < 0 || idx === clean.length - 1) return "";
  return clean.slice(idx + 1);
}

// Whether the caller may write a project's knowledge-base files. Mirrors task
// management rights: owner/admin may manage any project in their org; a
// moderator may manage only projects in allowedProjects (empty/absent = all).
// Employees/readers may read project files via Firestore rules, but cannot
// upload/delete knowledge-base entries.
export function callerCanManageProjectFiles(orgRole, allowedProjects, projectId) {
  if (orgRole === "owner" || orgRole === "admin") return true;
  if (orgRole !== "moderator") return false;
  if (!Array.isArray(allowedProjects) || allowedProjects.length === 0) return true;
  return allowedProjects.includes(projectId);
}

export default async function handler(request, response) {
  if (request.method !== "POST" && request.method !== "DELETE") {
    response.setHeader("Allow", "POST, DELETE");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const idToken = (request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!idToken) return response.status(401).json({ error: "Unauthorized" });

  let decoded;
  try {
    decoded = await adminAuth().verifyIdToken(idToken);
  } catch (error) {
    // Covers both an invalid/expired token and adminAuth() throwing because
    // FIREBASE_SERVICE_ACCOUNT_JSON isn't configured — either way the caller
    // is not authenticated, so 401 is the right response. (A misconfigured
    // env would also fail every other authenticated endpoint in the app the
    // same way, so this isn't a silent new failure mode.)
    return response.status(401).json({ error: "Unauthorized" });
  }

  let callerOrgId;
  let callerOrgRole = null;
  let callerAllowedProjects = null;
  try {
    const userDoc = await adminDb().collection("users").doc(decoded.uid).get();
    const cd = userDoc.exists ? userDoc.data() : null;
    callerOrgId = cd ? cd.organizationId : null;
    callerOrgRole = cd ? cd.orgRole : null;
    callerAllowedProjects = cd ? cd.allowedProjects : null;
  } catch (error) {
    console.error("project-files: failed to load caller user doc", error);
    return response.status(500).json({ error: "Failed to verify caller" });
  }
  if (!callerOrgId) return response.status(403).json({ error: "No organization" });

  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return response.status(400).json({ error: "Invalid JSON body" });
  }

  // DELETE removes a project file's Firestore doc (which is what the AI agent
  // reads and what the UI lists). We intentionally do not delete the underlying
  // Cloudinary raw asset: unsigned uploads give us no api_secret to sign a
  // destroy call, and the orphaned blob is unreferenced/harmless once its
  // Firestore doc is gone. Same org-scope + manage-rights bar as upload —
  // owner/admin (or a moderator with access to this project) may remove a
  // file; employees/readers cannot (see callerCanManageProjectFiles below).
  if (request.method === "DELETE") {
    // Prefer the query string (mobile Safari / some proxies drop the body of a
    // fetch DELETE, which broke deletion on phones); fall back to the JSON body.
    const query = request.query || {};
    const projectId = query.projectId || body.projectId;
    const fileId = query.fileId || body.fileId;
    if (!projectId || !fileId) {
      return response.status(400).json({ error: "projectId and fileId are required" });
    }

    let db;
    let projectDoc;
    try {
      db = adminDb();
      projectDoc = await db.collection("projects").doc(projectId).get();
    } catch (error) {
      console.error("project-files: failed to load project doc (delete)", error);
      return response.status(500).json({ error: "Failed to verify project" });
    }
    if (!projectDoc.exists || projectDoc.data().organizationId !== callerOrgId) {
      return response.status(403).json({ error: "Forbidden" });
    }
    if (!callerCanManageProjectFiles(callerOrgRole, callerAllowedProjects, projectId)) {
      return response.status(403).json({ error: "Forbidden — no access to this project" });
    }

    try {
      await db.collection("projects").doc(projectId).collection("files").doc(fileId).delete();
    } catch (error) {
      console.error("project-files: failed to delete file doc", error);
      return response.status(500).json({ error: "Failed to delete file" });
    }

    return response.status(200).json({ ok: true });
  }

  // Retry a stuck/failed extraction for an EXISTING file doc: re-download
  // from the stored URL and re-run the parser (a transient network error used
  // to leave extractionStatus:"error" forever). Same org + manage-rights bar
  // as upload/delete.
  if (body && body.retry === true) {
    return handleRetry({ response, callerOrgId, callerOrgRole, callerAllowedProjects, body });
  }

  const { projectId, filename, url, mimeType, sizeBytes } = body;

  const validation = validateUpload({ projectId, filename, url, sizeBytes });
  if (!validation.ok) {
    return response.status(validation.status).json({ error: validation.error });
  }

  if (!isAllowedFileUrl(url)) {
    return response.status(400).json({ error: "Invalid file URL" });
  }

  let db;
  let projectDoc;
  try {
    db = adminDb();
    projectDoc = await db.collection("projects").doc(projectId).get();
  } catch (error) {
    console.error("project-files: failed to load project doc", error);
    return response.status(500).json({ error: "Failed to verify project" });
  }
  if (!projectDoc.exists || projectDoc.data().organizationId !== callerOrgId) {
    return response.status(403).json({ error: "Forbidden" });
  }
  if (!callerCanManageProjectFiles(callerOrgRole, callerAllowedProjects, projectId)) {
    return response.status(403).json({ error: "Forbidden — no access to this project" });
  }

  // Dedup: re-uploading the same file (same project + filename + size) returns
  // the existing doc instead of creating a twin that would double the
  // knowledge chunks the agent reads. Best-effort: a failed lookup must not
  // block the upload.
  try {
    const dupSnap = await db.collection("projects").doc(projectId).collection("files")
      .where("filename", "==", filename)
      .where("sizeBytes", "==", sizeBytes || null)
      .limit(1)
      .get();
    if (!dupSnap.empty) {
      const existing = dupSnap.docs[0];
      return response.status(200).json({
        ok: true,
        fileId: existing.id,
        duplicate: true,
        file: { id: existing.id, ...existing.data() },
      });
    }
  } catch (error) {
    console.error("project-files: dedup lookup failed, continuing with upload", error);
  }

  let fileRef;
  try {
    fileRef = db.collection("projects").doc(projectId).collection("files").doc();
    await fileRef.set({
      filename,
      url,
      mimeType: mimeType || null,
      sizeBytes: sizeBytes || null,
      uploadedBy: decoded.uid, // from the verified token, never client-supplied (was spoofable)
      uploadedAt: new Date().toISOString(),
      extractionStatus: "pending",
      extractedText: null,
      extractionWarnings: [],
      knowledgeVersion: PROJECT_KNOWLEDGE_VERSION,
      knowledgeStatus: "indexing",
      knowledgeCharCount: 0,
      knowledgeChunks: [],
      knowledgeUpdatedAt: null,
    });
  } catch (error) {
    console.error("project-files: failed to create Firestore doc", error);
    return response.status(500).json({ error: "Failed to save file metadata" });
  }

  // Fire-and-forget background extraction. Vercel's Node runtime does not
  // guarantee a fire-and-forget promise survives after the response is sent
  // once the invocation is considered "done" — waitUntil() (from
  // @vercel/functions) explicitly tells the platform to keep the function
  // instance alive until this promise settles. This mirrors the pattern used
  // in the reference project (~/Desktop/12/api/materials.js). We could not
  // verify actual serverless behavior in this sandbox (no live Vercel
  // deploy), so we add waitUntil proactively rather than shipping a known,
  // plan-acknowledged reliability gap.
  const extraction = extractInBackground(fileRef, { filename, url, mimeType }).catch((error) => {
    console.error("background extraction failed", error);
  });
  try {
    waitUntil(extraction);
  } catch (error) {
    // waitUntil() no-ops safely outside a real Vercel invocation (getContext()
    // returns {} and it calls context.waitUntil?.(promise) via optional
    // chaining) — it does not throw. This try/catch only guards against
    // waitUntil()'s own defensive TypeError if the argument weren't a Promise,
    // which can't happen here. The promise above is already running
    // regardless, so nothing further to do here either way.
  }

  return response.status(200).json({ ok: true, fileId: fileRef.id });
}

// POST { projectId, fileId, retry: true } — re-run extraction for an existing
// file doc using its stored Cloudinary URL. Used when a transient failure
// (network, parser crash) left the doc on extractionStatus:"error"/"pending".
async function handleRetry({ response, callerOrgId, callerOrgRole, callerAllowedProjects, body }) {
  const projectId = typeof body.projectId === "string" ? body.projectId : "";
  const fileId = typeof body.fileId === "string" ? body.fileId : "";
  if (!projectId || !fileId) {
    return response.status(400).json({ error: "projectId and fileId are required" });
  }

  let db;
  let projectDoc;
  try {
    db = adminDb();
    projectDoc = await db.collection("projects").doc(projectId).get();
  } catch (error) {
    console.error("project-files: failed to load project doc (retry)", error);
    return response.status(500).json({ error: "Failed to verify project" });
  }
  if (!projectDoc.exists || projectDoc.data().organizationId !== callerOrgId) {
    return response.status(403).json({ error: "Forbidden" });
  }
  if (!callerCanManageProjectFiles(callerOrgRole, callerAllowedProjects, projectId)) {
    return response.status(403).json({ error: "Forbidden — no access to this project" });
  }

  const fileRef = db.collection("projects").doc(projectId).collection("files").doc(fileId);
  let fileData;
  try {
    const fileDoc = await fileRef.get();
    if (!fileDoc.exists) return response.status(404).json({ error: "File not found" });
    fileData = fileDoc.data();
  } catch (error) {
    console.error("project-files: failed to load file doc (retry)", error);
    return response.status(500).json({ error: "Failed to load file" });
  }

  try {
    await fileRef.update({
      extractionStatus: "pending",
      extractionWarnings: [],
      knowledgeStatus: "indexing",
      knowledgeUpdatedAt: null,
    });
  } catch (error) {
    console.error("project-files: failed to reset file doc (retry)", error);
    return response.status(500).json({ error: "Failed to retry extraction" });
  }

  // extractInBackground re-checks isAllowedFileUrl() itself, so even an old
  // doc with a bad stored URL fails safe instead of fetching it.
  const extraction = extractInBackground(fileRef, {
    filename: fileData.filename,
    url: fileData.url,
    mimeType: fileData.mimeType,
  }).catch((error) => {
    console.error("background extraction failed (retry)", error);
  });
  try {
    waitUntil(extraction);
  } catch (error) {
    // waitUntil() no-ops safely outside a real Vercel invocation — see the
    // upload path above for the full reasoning.
  }

  return response.status(200).json({ ok: true, fileId });
}

async function extractInBackground(fileRef, { filename, url, mimeType }) {
  try {
    // Defense in depth: extractInBackground is only ever invoked right after
    // the request-time isAllowedFileUrl() check below, but re-checking here
    // means this function is safe to fetch() from even if a future caller
    // wires it up without going through the handler's guard.
    if (!isAllowedFileUrl(url)) {
      throw new Error("Blocked non-Cloudinary file URL");
    }
    // Enforce the REAL file size server-side. validateUpload() only sees the
    // client-declared sizeBytes; the actual Cloudinary asset could be larger.
    // downloadCapped streams with a hard cap and aborts once exceeded, so an
    // oversized asset can't exhaust the function's memory.
    const buffer = await downloadCapped(url, MAX_FILE_BYTES);
    const base64 = buffer.toString("base64");

    const result = await extractMaterialText({ filename, contentType: mimeType || "", base64 });
    const knowledge = buildProjectKnowledgeIndex(result.text || "");
    await fileRef.update({
      extractionStatus: result.text ? "done" : "error",
      extractedText: result.text || null,
      extractionWarnings: result.warnings || [],
      ...knowledge,
      knowledgeUpdatedAt: new Date().toISOString(),
    });
  } catch (error) {
    // Covers both a non-OK download response (thrown above) and fetch()
    // itself rejecting (network error, DNS failure, etc.) — either way the
    // Firestore doc must not be left stuck on "pending".
    await fileRef.update({
      extractionStatus: "error",
      extractionWarnings: [String(error.message || error)],
      knowledgeVersion: PROJECT_KNOWLEDGE_VERSION,
      knowledgeStatus: "error",
      knowledgeCharCount: 0,
      knowledgeChunks: [],
      knowledgeUpdatedAt: new Date().toISOString(),
    });
  }
}

// Download a URL into a Buffer, enforcing a hard byte cap. Rejects early on a
// too-large Content-Length, then streams and aborts the moment the accumulated
// size exceeds maxBytes — so a lying/absent Content-Length can't still load an
// unbounded body into memory.
async function downloadCapped(url, maxBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);

  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`File exceeds ${maxBytes} bytes (declared ${declared})`);
  }

  if (!res.body || typeof res.body.getReader !== "function") {
    // No streaming body available — fall back to a buffered read, still capped.
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes`);
    return buf;
  }

  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch { /* best-effort abort */ }
      throw new Error(`File exceeds ${maxBytes} bytes (streamed)`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
