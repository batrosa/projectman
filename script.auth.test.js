import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_SOURCE = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");

function loadFederatedProvider() {
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

  return vm.runInContext("(federatedProvider)", context);
}

describe("federatedProvider", () => {
  it("uses Firebase's default Google scopes and parameters", () => {
    const provider = loadFederatedProvider()("google.com");

    expect(provider.scopes).toEqual([]);
    expect(provider.customParameters).toBeNull();
  });

  it("keeps the required Apple scopes and locale", () => {
    const provider = loadFederatedProvider()("apple.com");

    expect(provider.providerId).toBe("apple.com");
    expect(provider.scopes).toEqual(["email", "name"]);
    expect(provider.customParameters).toEqual({ locale: "ru" });
  });
});
