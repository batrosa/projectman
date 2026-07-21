import { randomUUID } from "node:crypto";
import { v2 as cloudinary } from "cloudinary";

export const CLOUDINARY_UPLOAD_PRESET = "projectman_private";
export const CLOUDINARY_DELIVERY_TYPE = "authenticated";
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const DOWNLOAD_TTL_SECONDS = 5 * 60;

export const TASK_FILE_EXTENSIONS = [
  "pdf", "doc", "docx", "xls", "xlsx", "xlsm", "md",
  "jpg", "jpeg", "png", "gif", "webp", "heic",
  "zip", "rar", "7z",
];
export const PROJECT_FILE_EXTENSIONS = ["md", "xlsx", "xlsm", "pdf", "docx"];
export const FILE_PURPOSES = ["task_attachment", "completion_proof", "project_file"];

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic"]);

export function extensionOf(filename) {
  const clean = String(filename || "").trim().toLowerCase();
  const index = clean.lastIndexOf(".");
  if (index < 0 || index === clean.length - 1) return "";
  return clean.slice(index + 1);
}

export function safePathSegment(value) {
  const cleaned = String(value || "")
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 120);
  if (!cleaned) throw new Error("Invalid storage path segment");
  return cleaned;
}

export function allowedExtensionsForPurpose(purpose) {
  return purpose === "project_file" ? PROJECT_FILE_EXTENSIONS : TASK_FILE_EXTENSIONS;
}

export function validateFileRequest({ purpose, projectId, filename, sizeBytes }) {
  if (!FILE_PURPOSES.includes(purpose)) {
    return { ok: false, status: 400, error: "Unsupported file purpose" };
  }
  if (!projectId || !filename) {
    return { ok: false, status: 400, error: "projectId and filename are required" };
  }
  const size = Number(sizeBytes);
  if (!Number.isFinite(size) || size <= 0 || size > MAX_FILE_BYTES) {
    return { ok: false, status: 400, error: "Invalid or oversized file size" };
  }
  const extension = extensionOf(filename);
  if (!allowedExtensionsForPurpose(purpose).includes(extension)) {
    return { ok: false, status: 400, error: `Unsupported file type: .${extension || "?"}` };
  }
  return {
    ok: true,
    extension,
    size,
    resourceType: IMAGE_EXTENSIONS.has(extension) ? "image" : "raw",
  };
}

export function buildPublicId({ organizationId, projectId, resourceType, extension }) {
  const base = `projectman/${safePathSegment(organizationId)}/${safePathSegment(projectId)}/${randomUUID()}`;
  // Cloudinary raw public IDs include the extension; image public IDs do not.
  return resourceType === "raw" ? `${base}.${extension}` : base;
}

export function expectedPublicIdPrefix(organizationId, projectId) {
  return `projectman/${safePathSegment(organizationId)}/${safePathSegment(projectId)}/`;
}

export function isProjectPublicId(publicId, organizationId, projectId) {
  return typeof publicId === "string"
    && publicId.startsWith(expectedPublicIdPrefix(organizationId, projectId))
    && publicId.length > expectedPublicIdPrefix(organizationId, projectId).length;
}

export function cloudinaryClient() {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  if (!cloudName || !apiKey || !apiSecret) {
    throw new Error("Cloudinary server credentials are not configured");
  }
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
    signature_algorithm: "sha256",
  });
  return cloudinary;
}

export function createSignedUpload({ publicId, resourceType, timestamp = Math.floor(Date.now() / 1000) }) {
  const client = cloudinaryClient();
  const params = {
    timestamp,
    upload_preset: CLOUDINARY_UPLOAD_PRESET,
    public_id: publicId,
    type: CLOUDINARY_DELIVERY_TYPE,
  };
  return {
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
    apiKey: process.env.CLOUDINARY_API_KEY,
    uploadUrl: `https://api.cloudinary.com/v1_1/${encodeURIComponent(process.env.CLOUDINARY_CLOUD_NAME)}/${resourceType}/upload`,
    fields: {
      ...params,
      signature: client.utils.api_sign_request(params, process.env.CLOUDINARY_API_SECRET, "sha256"),
    },
  };
}

export async function verifyUploadedAsset({ publicId, resourceType }) {
  return cloudinaryClient().api.resource(publicId, {
    resource_type: resourceType,
    type: CLOUDINARY_DELIVERY_TYPE,
  });
}

export function createPrivateDownloadUrl({ publicId, resourceType, format, filename, expiresAt }) {
  const options = {
    resource_type: resourceType,
    type: CLOUDINARY_DELIVERY_TYPE,
    expires_at: expiresAt || Math.floor(Date.now() / 1000) + DOWNLOAD_TTL_SECONDS,
    attachment: filename || true,
  };
  return cloudinaryClient().utils.private_download_url(publicId, format || undefined, options);
}

export async function destroyAsset({ publicId, resourceType }) {
  return cloudinaryClient().uploader.destroy(publicId, {
    resource_type: resourceType,
    type: CLOUDINARY_DELIVERY_TYPE,
    invalidate: true,
  });
}

export function legacyCloudinaryRef(value) {
  if (!value || typeof value.url !== "string") return null;
  let url;
  try { url = new URL(value.url); }
  catch { return null; }
  if (url.protocol !== "https:" || url.hostname !== "res.cloudinary.com") return null;
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (!cloudName || parts[0] !== cloudName) return null;
  const resourceType = parts[1];
  const deliveryType = parts[2];
  if (!["image", "raw", "video"].includes(resourceType) || deliveryType !== "upload") return null;
  const versionIndex = parts.findIndex((part, index) => index >= 3 && /^v\d+$/.test(part));
  if (versionIndex < 0 || versionIndex === parts.length - 1) return null;
  let publicId = parts.slice(versionIndex + 1).join("/");
  if (resourceType !== "raw") publicId = publicId.replace(/\.[a-zA-Z0-9]+$/, "");
  if (!publicId) return null;
  return { publicId, resourceType, deliveryType: "upload" };
}

export async function destroyLegacyAsset(reference) {
  const parsed = legacyCloudinaryRef(reference);
  if (!parsed) return { result: "skipped" };
  return cloudinaryClient().uploader.destroy(parsed.publicId, {
    resource_type: parsed.resourceType,
    type: parsed.deliveryType,
    invalidate: true,
  });
}

export function secureStorageRef({ asset, intent }) {
  return {
    name: intent.filename,
    type: intent.fileType,
    size: Number(asset.bytes),
    storageProvider: "cloudinary",
    assetId: asset.asset_id,
    publicId: intent.publicId,
    resourceType: intent.resourceType,
    deliveryType: CLOUDINARY_DELIVERY_TYPE,
    format: asset.format || intent.extension,
    projectId: intent.projectId,
    uploadIntentId: intent.id,
    uploadedAt: new Date().toISOString(),
  };
}

export function isSecureStorageRef(value) {
  return Boolean(value
    && value.storageProvider === "cloudinary"
    && typeof value.publicId === "string"
    && ["image", "raw"].includes(value.resourceType)
    && value.deliveryType === CLOUDINARY_DELIVERY_TYPE
    && typeof value.projectId === "string");
}
