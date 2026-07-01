// Project-level file upload metadata endpoint.
// The client uploads the raw file to Cloudinary directly (resource_type: "raw")
// and then calls this endpoint with the resulting URL + metadata. This endpoint
// creates the Firestore doc under projects/{projectId}/files/{fileId} (the
// Firestore rules only allow the Admin SDK to write there, see firestore.rules)
// and kicks off text extraction in the background via lib/material-parser.js,
// so a later AI agent task can read the extracted text.
import { waitUntil } from "@vercel/functions";
import { adminDb } from "../lib/firebase-admin.js";
import { extractMaterialText } from "../lib/material-parser.js";

export const ALLOWED_EXTENSIONS = ["md", "xlsx", "xlsm", "pdf", "docx"];
export const MAX_FILE_BYTES = 10 * 1024 * 1024;

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

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return response.status(400).json({ error: "Invalid JSON body" });
  }

  const { projectId, filename, url, mimeType, sizeBytes, uploadedBy } = body;

  const validation = validateUpload({ projectId, filename, url, sizeBytes });
  if (!validation.ok) {
    return response.status(validation.status).json({ error: validation.error });
  }

  let fileRef;
  try {
    const db = adminDb();
    fileRef = db.collection("projects").doc(projectId).collection("files").doc();
    await fileRef.set({
      filename,
      url,
      mimeType: mimeType || null,
      sizeBytes: sizeBytes || null,
      uploadedBy: uploadedBy || null,
      uploadedAt: new Date().toISOString(),
      extractionStatus: "pending",
      extractedText: null,
      extractionWarnings: [],
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

async function extractInBackground(fileRef, { filename, url, mimeType }) {
  try {
    const fileResponse = await fetch(url);
    if (!fileResponse.ok) throw new Error(`Failed to download file: ${fileResponse.status}`);
    const arrayBuffer = await fileResponse.arrayBuffer();
    const base64 = Buffer.from(arrayBuffer).toString("base64");

    const result = await extractMaterialText({ filename, contentType: mimeType || "", base64 });
    await fileRef.update({
      extractionStatus: result.text ? "done" : "error",
      extractedText: result.text || null,
      extractionWarnings: result.warnings || [],
    });
  } catch (error) {
    // Covers both a non-OK download response (thrown above) and fetch()
    // itself rejecting (network error, DNS failure, etc.) — either way the
    // Firestore doc must not be left stuck on "pending".
    await fileRef.update({
      extractionStatus: "error",
      extractionWarnings: [String(error.message || error)],
    });
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
