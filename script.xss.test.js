// Regression tests for Task 13b: stored XSS in attachment/file-list rendering.
//
// script.js is a monolithic browser script (no module exports), so these tests
// load it into a real DOM (via jsdom) using Node's vm module and exercise the
// actual rendering functions end-to-end, rather than re-implementing escaping
// logic separately. This proves the fix at the same code path a real browser
// would execute, not just in an isolated helper.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_SOURCE = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");

// A classic stored-XSS payload disguised as an uploaded filename.
const XSS_PAYLOAD_NAME = "<img src=x onerror=alert(1)>.pdf";
const XSS_PAYLOAD_URL = "javascript:alert(document.cookie)";
const NORMAL_NAME = "Отчёт за март 2026.pdf";
const NORMAL_URL = "https://res.cloudinary.com/dwoa1lqz1/raw/upload/v1/report.pdf";

/**
 * Loads script.js into a fresh jsdom window via vm.runInContext and returns
 * the sandbox context, from which any top-level function/let declared in
 * script.js can be pulled out with vm.runInContext('(fnName)', context).
 *
 * DOMContentLoaded fires during load and script.js's own init() path throws
 * (no real Firebase backend, no matching DOM elements for every widget) -
 * those errors are expected/harmless for this test's purposes and are
 * swallowed, since we only care about the pure rendering functions below,
 * all of which are declared (hoisted) independently of init() succeeding.
 */
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
    firebase: { initializeApp: () => {}, auth: () => ({}), firestore: () => ({}) },
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

function getFn(name) {
  return vm.runInContext(`(${name})`, ctx);
}

// Test-scaffolding helper: builds the minimal DOM elements a given render
// function expects to find via getElementById, using safe DOM APIs (never
// innerHTML) since these ids/classes are static, not attacker-controlled.
function setBody(...specs) {
  ctx.document.body.textContent = "";
  for (const { id, tag = "div" } of specs) {
    const el = ctx.document.createElement(tag);
    el.id = id;
    ctx.document.body.appendChild(el);
  }
}

describe("escapeHtml", () => {
  it("neutralizes HTML metacharacters in a malicious filename", () => {
    const escapeHtml = getFn("escapeHtml");
    const escaped = escapeHtml(XSS_PAYLOAD_NAME);
    expect(escaped).not.toContain("<img");
    expect(escaped).toContain("&lt;img");
    expect(escaped).toContain("&gt;");
  });

  it("leaves a normal filename effectively unchanged", () => {
    const escapeHtml = getFn("escapeHtml");
    expect(escapeHtml(NORMAL_NAME)).toBe(NORMAL_NAME);
  });
});

describe("sanitizeAttachmentUrl", () => {
  it("neutralizes javascript: URLs to a harmless anchor", () => {
    const sanitizeAttachmentUrl = getFn("sanitizeAttachmentUrl");
    expect(sanitizeAttachmentUrl(XSS_PAYLOAD_URL)).toBe("#");
  });

  it("passes through a normal https URL unchanged", () => {
    const sanitizeAttachmentUrl = getFn("sanitizeAttachmentUrl");
    expect(sanitizeAttachmentUrl(NORMAL_URL)).toBe(NORMAL_URL);
  });
});

describe("showNoPreview (Task 13b location #1)", () => {
  it("renders a malicious attachment name/url as inert text, not markup", () => {
    const showNoPreview = getFn("showNoPreview");
    const container = ctx.document.createElement("div");
    showNoPreview(container, { name: XSS_PAYLOAD_NAME, url: XSS_PAYLOAD_URL, type: "other" });

    // No <img> (or any unexpected) element was actually parsed into the DOM.
    expect(container.querySelectorAll("img").length).toBe(0);
    // Exactly the structural elements we expect: no-preview div, icon <i>, <p>, <a>, download <i>.
    expect(container.querySelectorAll("*").length).toBe(5);

    const link = container.querySelector("a");
    expect(link.getAttribute("href")).toBe("#"); // javascript: neutralized
    expect(link.getAttribute("download")).toBe(XSS_PAYLOAD_NAME); // literal text, not executed
  });

  it("renders a normal attachment identically to before", () => {
    const showNoPreview = getFn("showNoPreview");
    const container = ctx.document.createElement("div");
    showNoPreview(container, { name: NORMAL_NAME, url: NORMAL_URL, type: "pdf" });

    const link = container.querySelector("a");
    expect(link.getAttribute("href")).toBe(NORMAL_URL);
    expect(link.getAttribute("download")).toBe(NORMAL_NAME);
    expect(container.querySelector("p").textContent).toContain("Предпросмотр недоступен");
  });
});

describe("openFilesListModal (Task 13b location #2)", () => {
  it("renders a malicious attachment name/url as inert text, not markup", () => {
    setBody({ id: "files-list-modal" }, { id: "files-modal-list" });
    const openFilesListModal = getFn("openFilesListModal");
    openFilesListModal([{ name: XSS_PAYLOAD_NAME, url: XSS_PAYLOAD_URL, type: "other", size: 123 }]);
    const list = ctx.document.getElementById("files-modal-list");

    expect(list.querySelectorAll("img").length).toBe(0);
    expect(list.querySelectorAll("script").length).toBe(0);

    const nameEl = list.querySelector(".attachment-name");
    expect(nameEl.textContent).toBe(XSS_PAYLOAD_NAME);
    expect(nameEl.innerHTML).not.toContain("<img");

    const downloadLink = list.querySelector(".download-link");
    expect(downloadLink.getAttribute("href")).toBe("#");
    expect(downloadLink.getAttribute("download")).toBe(XSS_PAYLOAD_NAME);
  });

  it("renders a normal attachment identically to before", () => {
    setBody({ id: "files-list-modal" }, { id: "files-modal-list" });
    const openFilesListModal = getFn("openFilesListModal");
    openFilesListModal([{ name: NORMAL_NAME, url: NORMAL_URL, type: "pdf", size: 4096 }]);
    const list = ctx.document.getElementById("files-modal-list");

    expect(list.querySelector(".attachment-name").textContent).toBe(NORMAL_NAME);
    expect(list.querySelector(".download-link").getAttribute("href")).toBe(NORMAL_URL);
  });
});

describe("renderAttachmentsList (Task 13b location #3, pending uploads)", () => {
  it("renders a malicious pending attachment name as inert text", () => {
    setBody({ id: "attachments-list" });
    // pendingAttachments is a module-level `let` in script.js; mutate it via the sandbox.
    vm.runInContext(
      `pendingAttachments = [{ id: 't1', name: ${JSON.stringify(XSS_PAYLOAD_NAME)}, type: 'other', size: 10 }];`,
      ctx
    );
    const renderAttachmentsList = getFn("renderAttachmentsList");
    renderAttachmentsList();

    const list = ctx.document.getElementById("attachments-list");
    expect(list.querySelectorAll("img").length).toBe(0);
    expect(list.querySelector(".attachment-name").textContent).toBe(XSS_PAYLOAD_NAME);
    expect(list.innerHTML).not.toContain("<img");
  });
});

describe("renderCompletionAttachments (Task 13b location #4, completion proof queue)", () => {
  it("renders a malicious completion-proof attachment name as inert text", () => {
    setBody({ id: "completion-attachments-list" }, { id: "add-completion-file-btn", tag: "button" });
    vm.runInContext(
      `completionProofAttachments = [{ name: ${JSON.stringify(XSS_PAYLOAD_NAME)}, type: 'other', size: 10 }];`,
      ctx
    );
    const renderCompletionAttachments = getFn("renderCompletionAttachments");
    renderCompletionAttachments();

    const list = ctx.document.getElementById("completion-attachments-list");
    expect(list.querySelectorAll("img").length).toBe(0);
    expect(list.querySelector(".attachment-name").textContent).toBe(XSS_PAYLOAD_NAME);
    expect(list.innerHTML).not.toContain("<img");
  });
});
