import fs from "node:fs";
import { adminDb } from "../lib/firebase-admin.js";
import { cloudinaryClient, legacyCloudinaryRef } from "../lib/cloudinary-files.js";

const outputPath = process.argv[2];
if (!outputPath) throw new Error("Usage: node scripts/audit-cloudinary-storage.js <output.csv>");

function keyOf(publicId, resourceType, deliveryType) {
  return `${deliveryType || "upload"}:${resourceType}:${publicId}`;
}

function collectFileRefs(value, context, references, seen = new WeakSet()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);

  if (typeof value.publicId === "string" && typeof value.resourceType === "string") {
    const key = keyOf(value.publicId, value.resourceType, value.deliveryType || "authenticated");
    if (!references.has(key)) references.set(key, []);
    references.get(key).push(context);
  } else {
    const legacy = legacyCloudinaryRef(value);
    if (legacy) {
      const key = keyOf(legacy.publicId, legacy.resourceType, legacy.deliveryType);
      if (!references.has(key)) references.set(key, []);
      references.get(key).push(context);
    }
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => collectFileRefs(item, `${context}[${index}]`, references, seen));
    return;
  }
  for (const [field, child] of Object.entries(value)) {
    if (field === "extractedText" || field === "knowledgeChunks") continue;
    collectFileRefs(child, `${context}.${field}`, references, seen);
  }
}

async function firestoreReferences() {
  const db = adminDb();
  const references = new Map();
  const [tasks, projects, users] = await Promise.all([
    db.collection("tasks").get(),
    db.collection("projects").get(),
    db.collection("users").get(),
  ]);
  tasks.docs.forEach((doc) => collectFileRefs(doc.data(), `tasks/${doc.id}`, references));
  users.docs.forEach((doc) => collectFileRefs(doc.data(), `users/${doc.id}`, references));
  for (const project of projects.docs) {
    collectFileRefs(project.data(), `projects/${project.id}`, references);
    const files = await project.ref.collection("files").get();
    files.docs.forEach((doc) => collectFileRefs(doc.data(), `projects/${project.id}/files/${doc.id}`, references));
  }
  return references;
}

async function listResources(resourceType, type) {
  const client = cloudinaryClient();
  const resources = [];
  let nextCursor;
  do {
    const page = await client.api.resources({
      resource_type: resourceType,
      type,
      max_results: 500,
      next_cursor: nextCursor,
      context: true,
      tags: true,
    });
    resources.push(...(page.resources || []));
    nextCursor = page.next_cursor;
  } while (nextCursor);
  return resources;
}

function csvCell(value) {
  const string = String(value ?? "");
  return `"${string.replaceAll('"', '""')}"`;
}

const references = await firestoreReferences();
const groups = await Promise.all(
  ["upload", "authenticated"].flatMap((type) =>
    ["image", "raw", "video"].map((resourceType) => listResources(resourceType, type))),
);
const assets = groups.flat().map((asset) => {
  const key = keyOf(asset.public_id, asset.resource_type, asset.type);
  const refs = references.get(key) || [];
  return {
    referenced: refs.length > 0,
    type: asset.type,
    resourceType: asset.resource_type,
    createdAt: asset.created_at,
    bytes: Number(asset.bytes || 0),
    format: asset.format || "",
    filename: asset.display_name || asset.original_filename || "",
    publicId: asset.public_id,
    references: refs.join(" | "),
  };
}).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));

const header = ["referenced", "type", "resourceType", "createdAt", "bytes", "format", "filename", "publicId", "references"];
const csv = [header.map(csvCell).join(","), ...assets.map((asset) => header.map((field) => csvCell(asset[field])).join(","))].join("\n");
fs.writeFileSync(outputPath, csv, { mode: 0o600 });

const referenced = assets.filter((asset) => asset.referenced);
const unreferenced = assets.filter((asset) => !asset.referenced);
console.log(JSON.stringify({
  total: assets.length,
  referenced: referenced.length,
  unreferenced: unreferenced.length,
  bytesTotal: assets.reduce((sum, asset) => sum + asset.bytes, 0),
  bytesUnreferenced: unreferenced.reduce((sum, asset) => sum + asset.bytes, 0),
  outputPath,
}));
