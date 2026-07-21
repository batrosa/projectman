import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_SOURCE = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");

function loadScriptEnv() {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: "https://projectman.online/",
  });

  class GoogleAuthProvider {
    constructor() {
      this.scopes = [];
      this.customParameters = null;
    }

    addScope(scope) {
      this.scopes.push(scope);
    }

    setCustomParameters(parameters) {
      this.customParameters = parameters;
    }
  }

  class OAuthProvider {
    constructor(providerId) {
      this.providerId = providerId;
      this.scopes = [];
      this.customParameters = null;
    }

    addScope(scope) {
      this.scopes.push(scope);
    }

    setCustomParameters(parameters) {
      this.customParameters = parameters;
    }
  }

  const authFactory = () => ({ currentUser: null });
  authFactory.GoogleAuthProvider = GoogleAuthProvider;
  authFactory.OAuthProvider = OAuthProvider;
  authFactory.Auth = { Persistence: { LOCAL: "local" } };

  const context = {
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    localStorage: dom.window.localStorage,
    sessionStorage: dom.window.sessionStorage,
    firebase: {
      initializeApp: () => {},
      auth: authFactory,
      firestore: () => ({}),
    },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: () => Promise.reject(new Error("network disabled in test")),
    alert: () => {},
    confirm: () => false,
    URLSearchParams: dom.window.URLSearchParams,
  };
  context.globalThis = context;
  context.self = context;

  vm.createContext(context);
  vm.runInContext(SCRIPT_SOURCE, context, { filename: "script.js" });

  return context;
}

describe("federatedProvider", () => {
  it("keeps the required Apple scopes and locale", () => {
    const context = loadScriptEnv();
    const provider = vm.runInContext("(federatedProvider)", context)("apple.com");

    expect(provider.providerId).toBe("apple.com");
    expect(provider.scopes).toEqual(["email", "name"]);
    expect(provider.customParameters).toEqual({ locale: "ru" });
  });
});

describe("Google Identity Services message validation", () => {
  it("accepts an ID token only from the exact Firebase helper window and origin", () => {
    const context = loadScriptEnv();
    const parse = vm.runInContext("(parseGoogleIdentityMessage)", context);
    const popup = {};
    const result = parse({
      origin: "https://projectman-96d3c.firebaseapp.com",
      source: popup,
      data: {
        type: "projectman-google-auth-success",
        credential: "header.payload.signature",
      },
    }, popup);

    expect(result.type).toBe("success");
    expect(result.credential).toBe("header.payload.signature");
  });

  it("ignores messages from another origin or another window", () => {
    const context = loadScriptEnv();
    const parse = vm.runInContext("(parseGoogleIdentityMessage)", context);
    const popup = {};
    const payload = {
      type: "projectman-google-auth-success",
      credential: "header.payload.signature",
    };

    expect(parse({ origin: "https://evil.example", source: popup, data: payload }, popup)).toBeNull();
    expect(parse({
      origin: "https://projectman-96d3c.firebaseapp.com",
      source: {},
      data: payload,
    }, popup)).toBeNull();
  });

  it("rejects an empty or malformed credential", () => {
    const context = loadScriptEnv();
    const parse = vm.runInContext("(parseGoogleIdentityMessage)", context);
    const popup = {};
    const result = parse({
      origin: "https://projectman-96d3c.firebaseapp.com",
      source: popup,
      data: { type: "projectman-google-auth-success", credential: "bad" },
    }, popup);

    expect(result.type).toBe("error");
    expect(result.message).toContain("некорректный токен");
  });
});
