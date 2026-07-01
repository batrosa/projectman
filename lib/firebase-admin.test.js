import { describe, it, expect, afterEach } from "vitest";
import { loadServiceAccount } from "./firebase-admin.js";

describe("loadServiceAccount", () => {
  const ORIGINAL_ENV = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    else process.env.FIREBASE_SERVICE_ACCOUNT_JSON = ORIGINAL_ENV;
  });

  it("throws when the env var is unset", () => {
    delete process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    expect(() => loadServiceAccount()).toThrow("FIREBASE_SERVICE_ACCOUNT_JSON is not configured");
  });

  it("parses valid JSON from the env var", () => {
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = JSON.stringify({
      project_id: "demo-project",
      client_email: "sa@demo-project.iam.gserviceaccount.com",
      private_key: "fake-key",
    });
    expect(loadServiceAccount()).toEqual({
      project_id: "demo-project",
      client_email: "sa@demo-project.iam.gserviceaccount.com",
      private_key: "fake-key",
    });
  });

  it("throws a JSON parse error when the env var is malformed", () => {
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON = "{not valid json";
    expect(() => loadServiceAccount()).toThrow();
  });
});
