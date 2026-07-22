import { createRequire } from "node:module";

await import("firebase-admin/app");
await import("firebase-admin/auth");
await import("firebase-admin/firestore");

// A previous firebase-admin 14.x upgrade passed mocked tests but crashed on
// Vercel because jwks-rsa required an ESM-only jose build from CommonJS.
// Exercise that exact unmocked dependency edge as part of every deploy build.
createRequire(import.meta.url)("jwks-rsa/src/utils.js");

console.log("Firebase Admin runtime imports verified.");
