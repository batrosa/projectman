import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_SOURCE = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");

function loadScriptEnv() {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", {
    url: "http://localhost/",
  });
  const { window } = dom;

  const context = {
    window,
    document: window.document,
    navigator: window.navigator,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    firebase: { initializeApp: () => {}, auth: () => ({ currentUser: null }), firestore: () => ({}) },
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    fetch: () => Promise.reject(new Error("network disabled in test")),
    alert: () => {},
    confirm: () => false,
    URLSearchParams: window.URLSearchParams,
  };
  context.globalThis = context;
  context.self = context;

  vm.createContext(context);
  vm.runInContext(SCRIPT_SOURCE, context, { filename: "script.js" });

  return context;
}

let ctx;

beforeAll(() => {
  ctx = loadScriptEnv();
});

beforeEach(() => {
  vm.runInContext(`
    state.currentUser = { uid: 'u1', organizationId: 'org-1', orgRole: 'employee', allowedProjects: [] };
    state.role = 'reader';
    state.orgRole = 'employee';
    state.organization = { id: 'org-1', name: 'Org' };
    state.users = [{ id: 'u1', allowedProjects: [] }];
    state.projects = [
      { id: 'p1', name: 'Project 1', organizationId: 'org-1' },
      { id: 'p2', name: 'Project 2', organizationId: 'org-1' }
    ];
  `, ctx);
});

function getFn(name) {
  return vm.runInContext(`(${name})`, ctx);
}

describe("project visibility helpers", () => {
  it("falls back to currentUser.organizationId when state.organization is not populated yet", () => {
    vm.runInContext("state.organization = null; state.currentUser.organizationId = 'org-1';", ctx);
    expect(getFn("getCurrentOrganizationId")()).toBe("org-1");
  });

  it("lets an org owner with legacy role=reader see all org projects despite stale allowedProjects", () => {
    vm.runInContext(`
      state.orgRole = 'owner';
      state.currentUser.orgRole = 'owner';
      state.users = [{ id: 'u1', allowedProjects: ['p1'] }];
    `, ctx);

    const projects = getFn("getFilteredProjects")();
    expect(projects.map((project) => project.id)).toEqual(["p1", "p2"]);
  });

  it("keeps allowedProjects filtering for ordinary employees", () => {
    vm.runInContext("state.users = [{ id: 'u1', allowedProjects: ['p1'] }];", ctx);

    const projects = getFn("getFilteredProjects")();
    expect(projects.map((project) => project.id)).toEqual(["p1"]);
  });
});
