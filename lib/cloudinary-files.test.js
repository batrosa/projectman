import { afterEach, describe, expect, it } from "vitest";
import {
  buildPublicId,
  createPrivateDownloadUrl,
  createSignedUpload,
  isProjectPublicId,
  isSecureStorageRef,
  MAX_FILE_BYTES,
  validateFileRequest,
} from "./cloudinary-files.js";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("Cloudinary file validation", () => {
  it("uses images for image extensions and raw for documents", () => {
    expect(validateFileRequest({ purpose: "task_attachment", projectId: "p1", filename: "x.JPG", sizeBytes: 10 }))
      .toMatchObject({ ok: true, resourceType: "image", extension: "jpg" });
    expect(validateFileRequest({ purpose: "project_file", projectId: "p1", filename: "x.pdf", sizeBytes: 10 }))
      .toMatchObject({ ok: true, resourceType: "raw", extension: "pdf" });
  });

  it("applies the stricter project-file allow-list", () => {
    expect(validateFileRequest({ purpose: "project_file", projectId: "p1", filename: "x.zip", sizeBytes: 10 }))
      .toMatchObject({ ok: false, status: 400 });
  });

  it("rejects empty, invalid and oversized payloads", () => {
    expect(validateFileRequest({ purpose: "task_attachment", projectId: "p1", filename: "x.pdf", sizeBytes: 0 }).ok).toBe(false);
    expect(validateFileRequest({ purpose: "task_attachment", projectId: "p1", filename: "x.pdf", sizeBytes: MAX_FILE_BYTES + 1 }).ok).toBe(false);
    expect(validateFileRequest({ purpose: "unknown", projectId: "p1", filename: "x.pdf", sizeBytes: 10 }).ok).toBe(false);
  });

  it("creates tenant/project-scoped unguessable public IDs", () => {
    const raw = buildPublicId({ organizationId: "org 1", projectId: "project/1", resourceType: "raw", extension: "pdf" });
    expect(raw).toMatch(/^projectman\/org_1\/project_1\/[0-9a-f-]+\.pdf$/);
    expect(isProjectPublicId(raw, "org 1", "project/1")).toBe(true);
    expect(isProjectPublicId(raw, "org 2", "project/1")).toBe(false);
  });

  it("recognizes only complete authenticated storage references", () => {
    expect(isSecureStorageRef({ storageProvider: "cloudinary", publicId: "x", resourceType: "raw", deliveryType: "authenticated", projectId: "p1" })).toBe(true);
    expect(isSecureStorageRef({ storageProvider: "cloudinary", publicId: "x", resourceType: "raw", deliveryType: "upload", projectId: "p1" })).toBe(false);
  });
});

describe("Cloudinary signing", () => {
  it("signs uploads server-side and creates expiring authenticated downloads", () => {
    process.env.CLOUDINARY_CLOUD_NAME = "demo";
    process.env.CLOUDINARY_API_KEY = "key";
    process.env.CLOUDINARY_API_SECRET = "secret";
    const upload = createSignedUpload({ publicId: "projectman/org/p/id.pdf", resourceType: "raw", timestamp: 123 });
    expect(upload.apiKey).toBe("key");
    expect(upload.fields).toMatchObject({ timestamp: 123, type: "authenticated", upload_preset: "projectman_private" });
    expect(upload.fields.signature).toMatch(/^[a-f0-9]{64}$/);
    const download = createPrivateDownloadUrl({ publicId: "projectman/org/p/id.pdf", resourceType: "raw", format: "pdf", expiresAt: 9999999999 });
    expect(download).toContain("/raw/download?");
    expect(download).toContain("type=authenticated");
    expect(download).toContain("expires_at=9999999999");
    expect(download).not.toContain("secret");
  });
});
