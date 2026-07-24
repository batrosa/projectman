// Tests for the project-access model (admin panel "Доступ к проектам",
// organized by project). script.js is a monolithic browser script, so — like
// script.xss.test.js — we load it into jsdom via vm and pull out the real
// top-level functions, then drive them against a stubbed Firestore + state.
//
// The subtle invariant under test: users.allowedProjects uses [] / absent to
// mean "ALL projects". So "remove a member's last project" must NOT write an
// empty array (that would flip them to full access) — it writes a sentinel id
// that matches no real project. These tests lock that behavior.
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_SOURCE = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");

let ctx;
let writes; // captured server writes: { id, allowedProjects }
let removals;
let promptResponse;

beforeAll(() => {
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
    firebase: { initializeApp: () => {}, auth: () => ({}), firestore: () => ({}) },
    console,
    setTimeout, clearTimeout, setInterval, clearInterval,
    fetch: () => Promise.reject(new Error("network disabled in test")),
    alert: () => {},
    confirm: () => false,
    prompt: () => promptResponse,
    URLSearchParams: window.URLSearchParams,
  };
  context.globalThis = context;
  context.self = context;

  vm.createContext(context);
  vm.runInContext(SCRIPT_SOURCE, context, { filename: "script.js" });

  // Stub the server org API so grant/revoke capture what they'd persist.
  writes = [];
  removals = [];
  context.__callOrgApi = async (action, payload) => {
    if (action === "updateMemberAccess") {
      writes.push({ id: payload.userId, allowedProjects: payload.allowedProjects });
      return { ok: true };
    }
    if (action === "removeMember") {
      removals.push(payload.userId);
      return { ok: true };
    }
    throw new Error(`unexpected action ${action}`);
  };
  vm.runInContext("callOrgApi = __callOrgApi; playClickSound = () => {}", context);

  ctx = context;
});

const getFn = (name) => vm.runInContext(`(${name})`, ctx);
const SENTINEL = () => vm.runInContext("NO_ACCESS_SENTINEL", ctx);

// Point the script's shared state at a fixed 3-project org.
function setState(users) {
  const state = vm.runInContext("state", ctx);
  state.projects = [
    { id: "p1", name: "Проект A" },
    { id: "p2", name: "Проект B" },
    { id: "p3", name: "Проект C" },
  ];
  state.users = users;
  return state;
}

beforeEach(() => {
  writes.length = 0;
  removals.length = 0;
  promptResponse = null;
});

describe("removeUserFromOrganization", () => {
  function setOwnerState() {
    const state = vm.runInContext("state", ctx);
    state.currentUser = { uid: "owner" };
    state.orgRole = "owner";
  }

  it("does not remove a member after a cancelled or mistyped confirmation", async () => {
    const remove = getFn("removeUserFromOrganization");
    setOwnerState();

    promptResponse = "да";
    await remove("admin-1", "Вячеслав Гурьев", "admin");

    expect(removals).toEqual([]);
  });

  it("requires the explicit control word before calling the removal API", async () => {
    const remove = getFn("removeUserFromOrganization");
    setOwnerState();

    promptResponse = "ИСКЛЮЧИТЬ";
    await remove("admin-1", "Вячеслав Гурьев", "admin");

    expect(removals).toEqual(["admin-1"]);
  });
});

describe("userHasProjectAccess", () => {
  it("treats absent allowedProjects as access to ALL projects", () => {
    const fn = getFn("userHasProjectAccess");
    const u = { id: "u1", orgRole: "employee" };
    setState([u]);
    expect(fn(u, "p1")).toBe(true);
    expect(fn(u, "p3")).toBe(true);
  });

  it("treats an empty array as access to ALL projects", () => {
    const fn = getFn("userHasProjectAccess");
    const u = { id: "u1", orgRole: "employee", allowedProjects: [] };
    setState([u]);
    expect(fn(u, "p2")).toBe(true);
  });

  it("restricts to the listed projects when set explicitly", () => {
    const fn = getFn("userHasProjectAccess");
    const u = { id: "u1", orgRole: "employee", allowedProjects: ["p1"] };
    setState([u]);
    expect(fn(u, "p1")).toBe(true);
    expect(fn(u, "p2")).toBe(false);
  });

  it("grants NOTHING when only the sentinel is present", () => {
    const fn = getFn("userHasProjectAccess");
    const u = { id: "u1", orgRole: "employee", allowedProjects: [SENTINEL()] };
    setState([u]);
    expect(fn(u, "p1")).toBe(false);
    expect(fn(u, "p2")).toBe(false);
    expect(fn(u, "p3")).toBe(false);
  });

  it("always grants owner/admin regardless of allowedProjects", () => {
    const fn = getFn("userHasProjectAccess");
    const owner = { id: "o", orgRole: "owner", allowedProjects: [SENTINEL()] };
    const admin = { id: "a", orgRole: "admin", allowedProjects: ["p1"] };
    setState([owner, admin]);
    expect(fn(owner, "p2")).toBe(true);
    expect(fn(admin, "p3")).toBe(true);
  });
});

describe("effectiveAllowedIds", () => {
  it("expands the 'all' default into every current project id", () => {
    const fn = getFn("effectiveAllowedIds");
    const u = { id: "u1", orgRole: "employee" };
    setState([u]);
    expect(fn(u).sort()).toEqual(["p1", "p2", "p3"]);
  });

  it("drops the sentinel and stale (deleted) project ids", () => {
    const fn = getFn("effectiveAllowedIds");
    const u = { id: "u1", orgRole: "employee", allowedProjects: ["p1", "pX", SENTINEL()] };
    setState([u]);
    expect(fn(u)).toEqual(["p1"]);
  });
});

describe("mergeOrganizationRosterUsers", () => {
  it("keeps legacy org users visible and overlays multi-org membership fields", () => {
    const merge = getFn("mergeOrganizationRosterUsers");
    const users = merge(
      [
        { id: "u1", firstName: "Эльдар", lastName: "Исаев", orgRole: "employee", allowedProjects: ["p1"] },
        { id: "u2", firstName: "Амирхан", lastName: "Абигасанов", orgRole: "employee" },
      ],
      [
        { id: "u1", userId: "u1", organizationId: "org1", orgRole: "moderator", allowedProjects: ["p2"] },
      ],
    );

    expect(users).toHaveLength(2);
    expect(users.find(u => u.id === "u1")).toMatchObject({
      firstName: "Эльдар",
      lastName: "Исаев",
      orgRole: "moderator",
      allowedProjects: ["p2"],
    });
    expect(users.find(u => u.id === "u2")).toMatchObject({
      firstName: "Амирхан",
      lastName: "Абигасанов",
      orgRole: "employee",
    });
  });
});

describe("grantProjectAccess", () => {
  it("adds the project to an explicit list", async () => {
    const grant = getFn("grantProjectAccess");
    setState([{ id: "u1", orgRole: "employee", allowedProjects: ["p1"] }]);
    await grant("u1", "p2");
    expect(writes).toEqual([{ id: "u1", allowedProjects: ["p1", "p2"] }]);
  });

  it("replaces the sentinel when re-granting access", async () => {
    const grant = getFn("grantProjectAccess");
    setState([{ id: "u1", orgRole: "employee", allowedProjects: [SENTINEL()] }]);
    await grant("u1", "p2");
    expect(writes).toEqual([{ id: "u1", allowedProjects: ["p2"] }]);
  });
});

describe("revokeProjectAccess", () => {
  it("converts 'all' into an explicit list minus the revoked project", async () => {
    const revoke = getFn("revokeProjectAccess");
    setState([{ id: "u1", orgRole: "employee" }]); // absent = all
    await revoke("u1", "p2");
    expect(writes).toHaveLength(1);
    expect(writes[0].id).toBe("u1");
    expect(writes[0].allowedProjects.sort()).toEqual(["p1", "p3"]);
  });

  it("writes the sentinel (NOT an empty array) when removing the last project", async () => {
    const revoke = getFn("revokeProjectAccess");
    setState([{ id: "u1", orgRole: "employee", allowedProjects: ["p1"] }]);
    await revoke("u1", "p1");
    // The critical regression: [] would mean "all"; must be the sentinel.
    expect(writes).toEqual([{ id: "u1", allowedProjects: [SENTINEL()] }]);
    expect(writes[0].allowedProjects).not.toEqual([]);
  });
});

describe("handleAssigneeSearch (assignee dropdown respects project access)", () => {
  function setupPicker(users, activeProjectId) {
    ctx.document.body.textContent = "";
    const input = ctx.document.createElement("input");
    input.id = "assignee-search";
    const dropdown = ctx.document.createElement("div");
    dropdown.id = "assignee-dropdown";
    ctx.document.body.appendChild(input);
    ctx.document.body.appendChild(dropdown);
    const state = setState(users);
    state.activeProjectId = activeProjectId;
    vm.runInContext("selectedAssignees = []", ctx);
    return dropdown;
  }

  it("lists only members with access to the active project", () => {
    const search = getFn("handleAssigneeSearch");
    const dropdown = setupPicker(
      [
        { id: "owner", orgRole: "owner", firstName: "Оля", lastName: "В" },
        { id: "emp1", orgRole: "employee", firstName: "Иван", lastName: "И", allowedProjects: ["p1"] },
        { id: "emp2", orgRole: "employee", firstName: "Пётр", lastName: "П", allowedProjects: ["p2"] },
        { id: "emp3", orgRole: "employee", firstName: "Сноб", lastName: "С", allowedProjects: [SENTINEL()] },
      ],
      "p1",
    );

    search(); // empty query -> show every assignable member

    const names = [...dropdown.querySelectorAll(".assignee-dropdown-name")].map((n) => n.textContent);
    expect(names).toContain("Оля В"); // owner: full access by role
    expect(names).toContain("Иван И"); // employee with p1
    expect(names).not.toContain("Пётр П"); // only p2 -> hidden for p1
    expect(names).not.toContain("Сноб С"); // sentinel -> no access anywhere
  });

  it("shows 'not found' when nobody has access to the active project", () => {
    const search = getFn("handleAssigneeSearch");
    const dropdown = setupPicker(
      [{ id: "emp", orgRole: "employee", firstName: "Ева", lastName: "Е", allowedProjects: ["p2"] }],
      "p1",
    );
    search();
    expect(dropdown.querySelector(".assignee-dropdown-empty")).not.toBeNull();
    expect(dropdown.querySelectorAll(".assignee-dropdown-name").length).toBe(0);
  });
});
