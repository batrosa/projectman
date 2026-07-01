// Regression/unit tests for Task 15: global AI agent chat UI (script.js).
//
// Same loading strategy as script.xss.test.js: script.js is a monolithic
// browser script with no module exports, so it's loaded into a real jsdom
// window via Node's vm module and its top-level functions are pulled out by
// name, exercising the actual code path a browser would run rather than a
// re-implementation.
//
// Scope: this file focuses on the pure, meaningfully-unit-testable pieces of
// the chat UI — history truncation and safe text-to-DOM rendering (the
// hardest-won lesson from Task 13b: LLM output is untrusted and must never
// reach innerHTML). Send/receive wiring, button-disable-during-request, and
// the generation-counter staleness guard are UI/async-flow logic that's
// exercised far more meaningfully via live manual testing after deploy (real
// Firebase Auth session, real network timing) than via a jsdom unit test —
// see the task report for the manual verification checklist.
import { describe, it, expect, beforeAll } from "vitest";
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

function getFn(name) {
  return vm.runInContext(`(${name})`, ctx);
}

describe("truncateAgentChatHistory", () => {
  it("caps history to the last 8 turns, mirroring the server-side MAX_HISTORY_TURNS", () => {
    const truncateAgentChatHistory = getFn("truncateAgentChatHistory");
    const turns = Array.from({ length: 20 }, (_, i) => ({ role: "user", content: `msg ${i}` }));
    const result = truncateAgentChatHistory(turns);
    expect(result.length).toBe(8);
    expect(result[0].content).toBe("msg 12");
    expect(result[7].content).toBe("msg 19");
  });

  it("leaves a short history untouched", () => {
    const truncateAgentChatHistory = getFn("truncateAgentChatHistory");
    const turns = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    expect(truncateAgentChatHistory(turns)).toEqual(turns);
  });

  it("returns an empty array for non-array input rather than throwing", () => {
    const truncateAgentChatHistory = getFn("truncateAgentChatHistory");
    expect(truncateAgentChatHistory(null)).toEqual([]);
    expect(truncateAgentChatHistory(undefined)).toEqual([]);
    expect(truncateAgentChatHistory("not an array")).toEqual([]);
  });
});

describe("renderAgentChatText (safe LLM-output rendering)", () => {
  // The agent's answer is LLM output that could be influenced by data inside
  // the org's own tasks/files (indirect prompt injection). This must never be
  // interpreted as markup, no matter what the model outputs.
  const HTML_INJECTION_PAYLOAD = '<img src=x onerror=alert(1)>';
  const SCRIPT_INJECTION_PAYLOAD = '<script>alert(document.cookie)</script>';

  it("renders plain text as an inert text node, not parsed markup", () => {
    const renderAgentChatText = getFn("renderAgentChatText");
    const container = ctx.document.createElement("div");
    renderAgentChatText(container, HTML_INJECTION_PAYLOAD);

    expect(container.querySelectorAll("img").length).toBe(0);
    expect(container.textContent).toBe(HTML_INJECTION_PAYLOAD);
  });

  it("never creates a <script> element from LLM output containing script tags", () => {
    const renderAgentChatText = getFn("renderAgentChatText");
    const container = ctx.document.createElement("div");
    renderAgentChatText(container, SCRIPT_INJECTION_PAYLOAD);

    expect(container.querySelectorAll("script").length).toBe(0);
    expect(container.textContent).toBe(SCRIPT_INJECTION_PAYLOAD);
  });

  it("converts newlines to <br> elements without introducing any other markup", () => {
    const renderAgentChatText = getFn("renderAgentChatText");
    const container = ctx.document.createElement("div");
    renderAgentChatText(container, "Line 1\nLine 2\nLine 3");

    const brs = container.querySelectorAll("br");
    expect(brs.length).toBe(2);
    expect(container.querySelectorAll("*").length).toBe(2); // only the two <br>s, nothing else
    expect(container.textContent).toBe("Line 1Line 2Line 3");
  });

  it("does not let a newline-adjacent HTML payload become markup", () => {
    const renderAgentChatText = getFn("renderAgentChatText");
    const container = ctx.document.createElement("div");
    renderAgentChatText(container, `Вот отчёт:\n${HTML_INJECTION_PAYLOAD}\nКонец.`);

    expect(container.querySelectorAll("img").length).toBe(0);
    expect(container.querySelectorAll("br").length).toBe(2);
    expect(container.textContent).toBe(`Вот отчёт:${HTML_INJECTION_PAYLOAD}Конец.`);
  });

  it("handles null/undefined input without throwing", () => {
    const renderAgentChatText = getFn("renderAgentChatText");
    const container = ctx.document.createElement("div");
    expect(() => renderAgentChatText(container, null)).not.toThrow();
    expect(() => renderAgentChatText(container, undefined)).not.toThrow();
  });
});

describe("appendAgentChatMessage (end-to-end bubble rendering)", () => {
  function setBody() {
    ctx.document.body.textContent = "";
    const messages = ctx.document.createElement("div");
    messages.id = "agent-chat-messages";
    ctx.document.body.appendChild(messages);
  }

  it("renders a malicious assistant answer as inert text inside a message bubble", () => {
    setBody();
    // elements.agentChatMessages is captured at script-load time (before our
    // setBody() DOM exists), so re-point it at the freshly created element —
    // mirrors how the XSS suite's setBody() works for other id-based lookups
    // that go through the `elements` cache rather than a live getElementById.
    vm.runInContext(
      `elements.agentChatMessages = document.getElementById('agent-chat-messages');`,
      ctx
    );
    const appendAgentChatMessage = getFn("appendAgentChatMessage");
    const payload = '<img src=x onerror=alert(1)>';
    appendAgentChatMessage("assistant", payload);

    const list = ctx.document.getElementById("agent-chat-messages");
    expect(list.querySelectorAll("img").length).toBe(0);
    const bubble = list.querySelector(".agent-chat-message-assistant");
    expect(bubble).not.toBeNull();
    expect(bubble.textContent).toBe(payload);
    expect(bubble.innerHTML).not.toContain("<img");
  });

  it("removes the empty-state placeholder once a message is appended", () => {
    setBody();
    vm.runInContext(
      `elements.agentChatMessages = document.getElementById('agent-chat-messages');`,
      ctx
    );
    const renderAgentChatEmptyState = getFn("renderAgentChatEmptyState");
    const appendAgentChatMessage = getFn("appendAgentChatMessage");
    renderAgentChatEmptyState();
    const list = ctx.document.getElementById("agent-chat-messages");
    expect(list.querySelector(".agent-chat-empty")).not.toBeNull();

    appendAgentChatMessage("user", "Привет");
    expect(list.querySelector(".agent-chat-empty")).toBeNull();
  });
});

describe("sendAgentMessage (auth guard)", () => {
  it("rejects with a distinguishable 'not-authenticated' error when there is no signed-in Firebase user", async () => {
    // firebase.auth().currentUser is null in the test context (see
    // loadScriptEnv), simulating "auth state flipped to signed-out while the
    // chat panel was open" without needing a real Firebase session.
    const sendAgentMessage = getFn("sendAgentMessage");
    await expect(sendAgentMessage("hello", [])).rejects.toMatchObject({ code: "not-authenticated" });
  });
});
