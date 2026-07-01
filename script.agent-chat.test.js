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
// reach innerHTML). Most send/receive wiring and button-disable-during-request
// behavior is UI/async-flow logic that's exercised far more meaningfully via
// live manual testing after deploy (real Firebase Auth session, real network
// timing) than via a jsdom unit test — see the task report for the manual
// verification checklist.
//
// The generation-counter staleness guard itself (see agentChatState.generation
// in script.js) IS exercised below, though: the specific race it protects
// against — closing the agent-chat modal while a send is in flight, then a
// stale response resolving afterwards — is fully deterministic once the
// fetch() promise is manually controlled (see "generation-counter guard"
// describe block), so there's no reason to leave it to manual-only
// verification.
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

  it("keeps the bubble's className exactly correct even when the message content contains quote/attribute-breakout characters", () => {
    // Makes explicit the "no attribute-context interpolation" safety
    // property: `role` is always an internal literal
    // ('user'|'assistant'|'pending'|'error'), never LLM output, but this
    // asserts the belt-and-suspenders case anyway — even if `text` contained
    // characters that would break out of an HTML attribute if this were ever
    // built via a template string assigned to innerHTML (e.g. `"><script>`),
    // renderAgentChatText's textContent-only approach means it can never
    // reach the className/HTML attribute context at all, and the bubble's
    // className stays exactly what appendAgentChatMessage set it to.
    setBody();
    vm.runInContext(
      `elements.agentChatMessages = document.getElementById('agent-chat-messages');`,
      ctx
    );
    const appendAgentChatMessage = getFn("appendAgentChatMessage");
    const breakoutPayload = `"><script>alert(1)</script>" onmouseover="alert(2)`;
    const bubble = appendAgentChatMessage("assistant", breakoutPayload);

    expect(bubble.className).toBe("agent-chat-message agent-chat-message-assistant");
    expect(bubble.getAttribute("onmouseover")).toBeNull();
    expect(bubble.textContent).toBe(breakoutPayload);
    expect(bubble.querySelectorAll("script").length).toBe(0);
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

describe("generation-counter guard (close-modal race)", () => {
  // Exercises the real trigger the guard now protects, per the adversarial
  // review of Task 15: closeModalElement() (script.js) bumps
  // agentChatState.generation specifically when the agent-chat modal is
  // closed. Previously this counter was only ever incremented by
  // handleAgentChatSubmit itself, which can't happen twice concurrently (the
  // synchronous `elements.agentChatInput.disabled` re-entrancy check fully
  // serializes sends) — so the guard was dead code. This test builds the full
  // DOM the agent-chat handlers touch, drives handleAgentChatSubmit with a
  // manually-controlled fetch() so the response resolves strictly after the
  // modal is closed, and asserts the stale response never reaches the DOM.
  function setAgentChatDom() {
    ctx.document.body.textContent = "";

    const modal = ctx.document.createElement("div");
    modal.id = "agent-chat-modal";
    modal.className = "modal active"; // starts open, like a real send-in-progress

    const messages = ctx.document.createElement("div");
    messages.id = "agent-chat-messages";

    const form = ctx.document.createElement("form");
    form.id = "agent-chat-form";

    const input = ctx.document.createElement("textarea");
    input.id = "agent-chat-input";

    const sendBtn = ctx.document.createElement("button");
    sendBtn.id = "agent-chat-send-btn";

    ctx.document.body.append(modal, messages, form, input, sendBtn);

    // elements.* is captured once at script-load time against the initial
    // (empty) DOM, so re-point every id-based entry the handlers use at the
    // freshly created elements — same pattern the other describe blocks in
    // this file use for elements.agentChatMessages.
    vm.runInContext(
      `
      elements.agentChatModal = document.getElementById('agent-chat-modal');
      elements.agentChatMessages = document.getElementById('agent-chat-messages');
      elements.agentChatForm = document.getElementById('agent-chat-form');
      elements.agentChatInput = document.getElementById('agent-chat-input');
      elements.agentChatSendBtn = document.getElementById('agent-chat-send-btn');
      `,
      ctx
    );

    return { modal, messages, form, input, sendBtn };
  }

  // Minimal fake Event with the one method handleAgentChatSubmit calls.
  function fakeSubmitEvent() {
    return { preventDefault: () => {} };
  }

  it("drops a response that resolves after the modal was closed mid-flight, rendering nothing", async () => {
    const dom = setAgentChatDom();
    dom.input.value = "Какие задачи просрочены?";

    // Controllable fetch: resolves only when the test calls resolveFetch(),
    // simulating a real in-flight network request.
    let resolveFetch;
    ctx.fetch = () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      });
    ctx.firebase.auth = () => ({
      currentUser: { getIdToken: async () => "fake-id-token" },
    });

    const handleAgentChatSubmit = getFn("handleAgentChatSubmit");
    const closeModalElement = getFn("closeModalElement");

    const submitPromise = handleAgentChatSubmit(fakeSubmitEvent());
    // Let the microtask queue advance far enough for sendAgentMessage's
    // getIdToken() + fetch() calls to actually happen and capture
    // resolveFetch (a handful of microtask hops: getIdToken's own await,
    // then the fetch() call itself).
    for (let i = 0; i < 10 && typeof resolveFetch !== "function"; i++) {
      await Promise.resolve();
    }
    expect(typeof resolveFetch).toBe("function");

    // The user's own turn and the "typing…" placeholder should already be
    // rendered at this point — this part of the flow is unaffected by the
    // guard, only the *response* is.
    expect(dom.messages.querySelector(".agent-chat-message-user")).not.toBeNull();
    expect(dom.messages.querySelectorAll(".agent-chat-message").length).toBe(2); // user + pending

    // User closes the modal while the request is still in flight. This is
    // the real trigger: closeModalElement() bumps agentChatState.generation
    // because the modal being closed is elements.agentChatModal.
    closeModalElement(dom.modal);
    expect(dom.modal.classList.contains("active")).toBe(false);

    // Now the stale request finally resolves with what would otherwise be a
    // perfectly good successful answer.
    resolveFetch({
      status: 200,
      json: async () => ({ ok: true, answer: "Просроченных задач нет.", model: "test-model" }),
    });
    await submitPromise;

    // The stale response must not have rendered an assistant bubble, must
    // not have removed the "pending" bubble (nothing owns that anymore), and
    // must not have pushed onto history — it's a pure no-op.
    expect(dom.messages.querySelector(".agent-chat-message-assistant")).toBeNull();
    expect(dom.messages.querySelectorAll(".agent-chat-message").length).toBe(2); // unchanged: user + pending still there
  });

  it("still renders normally when the modal is NOT closed before the response arrives", async () => {
    const dom = setAgentChatDom();
    dom.input.value = "Какой статус у проекта X?";

    let resolveFetch;
    ctx.fetch = () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      });
    ctx.firebase.auth = () => ({
      currentUser: { getIdToken: async () => "fake-id-token" },
    });

    const handleAgentChatSubmit = getFn("handleAgentChatSubmit");
    const submitPromise = handleAgentChatSubmit(fakeSubmitEvent());
    for (let i = 0; i < 10 && typeof resolveFetch !== "function"; i++) {
      await Promise.resolve();
    }
    expect(typeof resolveFetch).toBe("function");

    resolveFetch({
      status: 200,
      json: async () => ({ ok: true, answer: "Проект X в графике.", model: "test-model" }),
    });
    await submitPromise;

    const bubble = dom.messages.querySelector(".agent-chat-message-assistant");
    expect(bubble).not.toBeNull();
    expect(bubble.textContent).toBe("Проект X в графике.");
  });

  it("closeModalElement only bumps the generation counter for the agent-chat modal, not other modals", () => {
    setAgentChatDom();
    const otherModal = ctx.document.createElement("div");
    otherModal.className = "modal active";
    ctx.document.body.appendChild(otherModal);

    const closeModalElement = getFn("closeModalElement");
    const generationBefore = vm.runInContext("agentChatState.generation", ctx);

    closeModalElement(otherModal);
    expect(otherModal.classList.contains("active")).toBe(false);
    expect(vm.runInContext("agentChatState.generation", ctx)).toBe(generationBefore);

    const agentModal = vm.runInContext("elements.agentChatModal", ctx);
    closeModalElement(agentModal);
    expect(vm.runInContext("agentChatState.generation", ctx)).toBe(generationBefore + 1);
  });
});

describe("generation-counter guard (sign-out)", () => {
  // onAuthStateChanged()'s signed-out branch is the single choke point both
  // logout() (via auth.signOut()) and the 401-handler's forced auth.signOut()
  // go through — bumping the counter there, rather than duplicating the bump
  // in both call sites, guarantees a stale agent-chat response can never
  // render once the user is no longer signed in, regardless of which path
  // triggered the sign-out.
  function setAuthScreenDom() {
    ctx.document.body.textContent = "";
    const loadingScreen = ctx.document.createElement("div");
    loadingScreen.id = "loading-screen";
    const authOverlay = ctx.document.createElement("div");
    authOverlay.id = "auth-overlay";
    const authScreen = ctx.document.createElement("div");
    authScreen.id = "auth-screen";
    ctx.document.body.append(loadingScreen, authOverlay, authScreen);
    vm.runInContext(
      `
      elements.authOverlay = document.getElementById('auth-overlay');
      elements.authScreen = document.getElementById('auth-screen');
      `,
      ctx
    );
  }

  it("bumps agentChatState.generation when onAuthStateChanged fires with no user (sign-out)", () => {
    setAuthScreenDom();
    const onAuthStateChanged = getFn("onAuthStateChanged");
    const generationBefore = vm.runInContext("agentChatState.generation", ctx);

    onAuthStateChanged(null);

    expect(vm.runInContext("agentChatState.generation", ctx)).toBe(generationBefore + 1);
    // Sanity: the real signed-out behavior (routing back to the auth screen)
    // still happens too — the guard is additive, not a replacement.
    expect(vm.runInContext("elements.authOverlay.style.display", ctx)).toBe("flex");
  });

});
