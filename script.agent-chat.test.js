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
import { describe, it, expect, beforeAll, afterEach } from "vitest";
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

afterEach(() => {
  if (!ctx) return;
  ctx.firebase.auth = () => ({ currentUser: null });
  ctx.fetch = () => Promise.reject(new Error("network disabled in test"));
  ctx.confirm = () => false;
  ctx.alert = () => {};
  // Clear any 429 lockout a test started: the live interval would otherwise
  // keep firing against stale DOM, and the lockout would suppress input
  // re-enabling in later tests (setAgentChatInputDisabled consults it).
  vm.runInContext(
    `
    if (agentChatState.rateLimitTimer) {
      clearInterval(agentChatState.rateLimitTimer);
      agentChatState.rateLimitTimer = null;
    }
    agentChatState.rateLimitedUntil = 0;
    `,
    ctx
  );
});

function getFn(name) {
  return vm.runInContext(`(${name})`, ctx);
}

// Lets a fire-and-forget async handler (button click → confirm*()) run to
// completion: each awaited step inside it is one microtask hop.
async function flushMicrotasks(turns = 30) {
  for (let i = 0; i < turns; i++) await Promise.resolve();
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

describe("appendAgentTaskProposal", () => {
  it("renders the grounded description as inert text inside the real confirmation card", () => {
    ctx.document.body.textContent = "";
    const messages = ctx.document.createElement("div");
    messages.id = "agent-chat-messages";
    ctx.document.body.appendChild(messages);
    vm.runInContext(`elements.agentChatMessages = document.getElementById('agent-chat-messages');`, ctx);

    const appendAgentTaskProposal = getFn("appendAgentTaskProposal");
    appendAgentTaskProposal({
      source: "text",
      projectId: "p1",
      projectName: "Дом",
      canCreate: true,
      tasks: [{
        title: "Проверить бассейн",
        description: "Проверить оборудование и зафиксировать состояние. <img src=x onerror=alert(1)>",
        deadline: null,
        assigneeDisplay: "Иван Петров",
        assigneeUid: "u1",
        ok: true,
      }],
    });

    const card = messages.querySelector(".agent-task-proposal");
    expect(card).not.toBeNull();
    expect(card.querySelector(".agent-task-proposal-description")?.textContent).toContain("Проверить оборудование");
    expect(card.querySelectorAll("img")).toHaveLength(0);
    expect(card.querySelector(".agent-task-proposal-create")?.textContent).toContain("Создать 1");
  });
});

describe("appendAgentDeleteProposal / confirmAgentDeleteProposal", () => {
  function setBody() {
    ctx.document.body.textContent = "";
    const messages = ctx.document.createElement("div");
    messages.id = "agent-chat-messages";
    ctx.document.body.appendChild(messages);
    vm.runInContext(
      `
      elements.agentChatMessages = document.getElementById('agent-chat-messages');
      agentChatState.history = [];
      `,
      ctx
    );
    return messages;
  }

  it("renders deletion proposal data as inert text and shows a confirmation button", () => {
    const messages = setBody();
    const appendAgentDeleteProposal = getFn("appendAgentDeleteProposal");
    appendAgentDeleteProposal({
      projectId: "p1",
      projectName: "Елисеевский парк",
      filterLabel: "назначенные",
      canDelete: true,
      tasks: [
        {
          id: "t1",
          title: '<img src=x onerror=alert(1)>',
          deadline: null,
          assigneeDisplay: "Эльдар Исаев",
          statusDisplay: "назначена",
        },
      ],
    });

    expect(messages.querySelectorAll("img").length).toBe(0);
    expect(messages.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(messages.querySelector(".agent-task-proposal-delete")).not.toBeNull();
  });

  it("confirms deletion only when the server returns an integer deleted count, then shows the done state", async () => {
    const messages = setBody();
    const appendAgentDeleteProposal = getFn("appendAgentDeleteProposal");
    const proposal = {
      projectId: "p1",
      projectName: "Елисеевский парк",
      filterLabel: "назначенные",
      canDelete: true,
      tasks: [{ id: "t1", title: "Task", deadline: null, assigneeDisplay: "Эльдар Исаев", statusDisplay: "назначена" }],
    };
    appendAgentDeleteProposal(proposal);
    const card = messages.querySelector(".agent-task-proposal");
    const btn = card.querySelector(".agent-task-proposal-delete");
    const actions = card.querySelector(".agent-task-proposal-actions");

    ctx.firebase.auth = () => ({
      currentUser: { getIdToken: async () => "fake-id-token" },
    });
    const fetchCalls = [];
    ctx.fetch = async (url, options) => {
      fetchCalls.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, deleted: 1 }),
      };
    };

    const confirmAgentDeleteProposal = getFn("confirmAgentDeleteProposal");
    await confirmAgentDeleteProposal(proposal, proposal.tasks, btn, actions);

    expect(fetchCalls).toHaveLength(1);
    expect(JSON.parse(fetchCalls[0].options.body)).toEqual({
      action: "delete_tasks",
      proposalId: "",
      projectId: "p1",
      taskIds: ["t1"],
    });
    // Button row is replaced by the «✓ Задачи удалены» status line
    expect(btn.isConnected).toBe(false);
    expect(actions.querySelectorAll("button").length).toBe(0);
    const status = actions.querySelector(".agent-task-proposal-status");
    expect(status?.textContent).toBe("✓ Задачи удалены");
    expect(status?.className).toContain("agent-task-proposal-status-done");
    // …and the detailed assistant summary still lands as a chat bubble
    // (cards also carry .agent-chat-message-assistant, so exclude them)
    expect(messages.querySelector(".agent-chat-message-assistant:not(.agent-task-proposal)")?.textContent).toContain("Удалено задач: 1");
  });

  it("shows the server error inline in the card on a soft ok:true response without deleted", async () => {
    const messages = setBody();
    const appendAgentDeleteProposal = getFn("appendAgentDeleteProposal");
    const proposal = {
      projectId: "p1",
      projectName: "Елисеевский парк",
      filterLabel: "назначенные",
      canDelete: true,
      tasks: [{ id: "t1", title: "Task", deadline: null, assigneeDisplay: "Эльдар Исаев", statusDisplay: "назначена" }],
    };
    appendAgentDeleteProposal(proposal);
    const card = messages.querySelector(".agent-task-proposal");
    const btn = card.querySelector(".agent-task-proposal-delete");
    const actions = card.querySelector(".agent-task-proposal-actions");

    ctx.firebase.auth = () => ({
      currentUser: { getIdToken: async () => "fake-id-token" },
    });
    ctx.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, answer: "Мягкая ошибка" }),
    });

    const confirmAgentDeleteProposal = getFn("confirmAgentDeleteProposal");
    await confirmAgentDeleteProposal(proposal, proposal.tasks, btn, actions);

    // Card stays live (retry possible), error is inline — not a chat bubble
    expect(btn.isConnected).toBe(true);
    expect(btn.disabled).toBe(false);
    expect(actions.querySelector(".agent-task-proposal-cancel")?.disabled).toBe(false);
    expect(actions.querySelector(".agent-task-proposal-error")?.textContent).toContain("Не удалось удалить задачи");
    expect(messages.querySelector(".agent-chat-message-error")).toBeNull();
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

    // The stale response must not render an assistant bubble or push onto
    // history — BUT its own "Агент печатает…" pending bubble must be cleared
    // (in finally), otherwise it's orphaned and shows forever on reopen.
    expect(dom.messages.querySelector(".agent-chat-message-assistant")).toBeNull();
    expect(dom.messages.querySelector(".agent-chat-message-pending")).toBeNull();
    expect(dom.messages.querySelectorAll(".agent-chat-message").length).toBe(1); // only the user turn remains
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

describe("organization-switch chat reset", () => {
  it("drops history/cards and invalidates in-flight replies before changing organization", () => {
    ctx.document.body.innerHTML = `
      <div id="agent-chat-messages"><div>old card</div></div>
      <textarea id="agent-chat-input">old question</textarea>
      <button id="agent-chat-send-btn"></button>
      <button id="agent-chat-attach-btn"></button>
      <input id="agent-chat-file-input" />
      <div id="agent-chat-file-chip"></div>
    `;
    vm.runInContext(`
      elements.agentChatMessages = document.getElementById('agent-chat-messages');
      elements.agentChatInput = document.getElementById('agent-chat-input');
      elements.agentChatSendBtn = document.getElementById('agent-chat-send-btn');
      elements.agentChatAttachBtn = document.getElementById('agent-chat-attach-btn');
      elements.agentChatFileInput = document.getElementById('agent-chat-file-input');
      elements.agentChatFileChip = document.getElementById('agent-chat-file-chip');
      agentChatState.history = [{ role: 'user', content: 'old' }];
      agentChatState.pendingFile = { name: 'old.pdf' };
    `, ctx);
    const before = vm.runInContext("agentChatState.generation", ctx);

    getFn("resetAgentChatForOrganizationChange")();

    expect(vm.runInContext("agentChatState.generation", ctx)).toBe(before + 1);
    expect(vm.runInContext("agentChatState.history.length", ctx)).toBe(0);
    expect(vm.runInContext("agentChatState.pendingFile", ctx)).toBeNull();
    expect(ctx.document.getElementById("agent-chat-input").value).toBe("");
    expect(ctx.document.getElementById("agent-chat-messages").textContent).toContain("текущей организации");
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

// Full agent-chat DOM (modal + messages + form + input + send + rate hint)
// shared by the 429/retry suites below — same re-pointing pattern as the
// generation-counter block, plus a cleared history so length assertions are
// relative to empty.
function setFullAgentChatDom() {
  ctx.document.body.textContent = "";

  const modal = ctx.document.createElement("div");
  modal.id = "agent-chat-modal";
  modal.className = "modal active";

  const messages = ctx.document.createElement("div");
  messages.id = "agent-chat-messages";

  const form = ctx.document.createElement("form");
  form.id = "agent-chat-form";

  const input = ctx.document.createElement("textarea");
  input.id = "agent-chat-input";

  const sendBtn = ctx.document.createElement("button");
  sendBtn.id = "agent-chat-send-btn";

  const rateHint = ctx.document.createElement("div");
  rateHint.id = "agent-chat-rate-hint";
  rateHint.hidden = true;

  ctx.document.body.append(modal, messages, form, input, sendBtn, rateHint);

  vm.runInContext(
    `
    elements.agentChatModal = document.getElementById('agent-chat-modal');
    elements.agentChatMessages = document.getElementById('agent-chat-messages');
    elements.agentChatForm = document.getElementById('agent-chat-form');
    elements.agentChatInput = document.getElementById('agent-chat-input');
    elements.agentChatSendBtn = document.getElementById('agent-chat-send-btn');
    elements.agentChatRateHint = document.getElementById('agent-chat-rate-hint');
    agentChatState.history = [];
    `,
    ctx
  );

  return { modal, messages, form, input, sendBtn, rateHint };
}

describe("429 rate-limit handling", () => {
  function fakeSubmitEvent() {
    return { preventDefault: () => {} };
  }

  it("shows the server's own error text, locks the input and starts the countdown hint", async () => {
    const dom = setFullAgentChatDom();
    dom.input.value = "Удали все готовые задачи";
    ctx.firebase.auth = () => ({
      currentUser: { getIdToken: async () => "fake-id-token" },
    });
    ctx.fetch = async () => ({
      status: 429,
      json: async () => ({ error: "Слишком много запросов подряд. Подождите минуту и попробуйте снова." }),
    });

    const handleAgentChatSubmit = getFn("handleAgentChatSubmit");
    await handleAgentChatSubmit(fakeSubmitEvent());

    // Server message is shown verbatim, not swallowed by the generic error
    const errorBubble = dom.messages.querySelector(".agent-chat-message-error");
    expect(errorBubble).not.toBeNull();
    expect(errorBubble.textContent).toContain("Слишком много запросов подряд. Подождите минуту и попробуйте снова.");
    expect(errorBubble.textContent).not.toContain("Не удалось получить ответ от агента");

    // The input stays disabled even after the submit's finally-block ran
    // (the lockout owns the disabled state for the whole window)…
    expect(dom.input.disabled).toBe(true);
    expect(dom.sendBtn.disabled).toBe(true);
    // …with a visible countdown hint showing roughly the full minute
    expect(dom.rateHint.hidden).toBe(false);
    expect(dom.rateHint.textContent).toContain("60");

    // The 429'd turn was never processed server-side → dropped from history
    expect(vm.runInContext("agentChatState.history.length", ctx)).toBe(0);
    expect(vm.runInContext("agentChatState.rateLimitedUntil", ctx)).toBeGreaterThan(Date.now());
  });

  it("keeps the error bubble's «Повторить» button inert while the lockout owns the input", async () => {
    const dom = setFullAgentChatDom();
    dom.input.value = "Что просрочено?";
    ctx.firebase.auth = () => ({
      currentUser: { getIdToken: async () => "fake-id-token" },
    });
    let fetchCalls = 0;
    ctx.fetch = async () => {
      fetchCalls += 1;
      return { status: 429, json: async () => ({ error: "Слишком много запросов подряд." }) };
    };

    const handleAgentChatSubmit = getFn("handleAgentChatSubmit");
    await handleAgentChatSubmit(fakeSubmitEvent());

    const retryBtn = dom.messages.querySelector(".agent-chat-retry-btn");
    expect(retryBtn).not.toBeNull();
    retryBtn.click();
    await flushMicrotasks();

    // Lockout blocked the retry: no second request went out
    expect(fetchCalls).toBe(1);
    expect(dom.messages.querySelectorAll(".agent-chat-message-user").length).toBe(1);
  });

  it("re-enables the input and hides the hint once the countdown expires", async () => {
    const dom = setFullAgentChatDom();

    const startAgentChatRateLimitCountdown = getFn("startAgentChatRateLimitCountdown");
    startAgentChatRateLimitCountdown(60);
    expect(dom.input.disabled).toBe(true);
    expect(dom.rateHint.hidden).toBe(false);

    // Force-expire the lockout, then wait for the real 1s interval to tick.
    vm.runInContext("agentChatState.rateLimitedUntil = Date.now() - 1;", ctx);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(dom.input.disabled).toBe(false);
    expect(dom.rateHint.hidden).toBe(true);
    expect(vm.runInContext("agentChatState.rateLimitTimer", ctx)).toBeNull();
  });
});

describe("proposal-card cancel button", () => {
  function setBody() {
    ctx.document.body.textContent = "";
    const messages = ctx.document.createElement("div");
    messages.id = "agent-chat-messages";
    ctx.document.body.appendChild(messages);
    vm.runInContext(
      `
      elements.agentChatMessages = document.getElementById('agent-chat-messages');
      agentChatState.history = [];
      `,
      ctx
    );
    return messages;
  }

  it("create card: «Отмена» marks the card cancelled without any server call", () => {
    const messages = setBody();
    let fetchCalled = false;
    ctx.fetch = async () => {
      fetchCalled = true;
      return { status: 200, json: async () => ({}) };
    };

    const appendAgentTaskProposal = getFn("appendAgentTaskProposal");
    appendAgentTaskProposal({
      source: "text",
      projectId: "p1",
      projectName: "Дом",
      canCreate: true,
      tasks: [{ title: "Проверить бассейн", deadline: null, assigneeDisplay: "Иван", assigneeUid: "u1", ok: true }],
    });

    const card = messages.querySelector(".agent-task-proposal");
    const cancelBtn = card.querySelector(".agent-task-proposal-cancel");
    expect(cancelBtn).not.toBeNull();
    expect(cancelBtn.textContent).toBe("Отмена");

    cancelBtn.click();

    // Purely client-side: unconfirmed proposals are server no-ops
    expect(fetchCalled).toBe(false);
    expect(card.classList.contains("agent-task-proposal-cancelled")).toBe(true);
    expect(card.querySelector(".agent-task-proposal-status")?.textContent).toBe("Действие отменено");
    // The whole button row is gone — nothing left to interact with
    expect(card.querySelectorAll("button").length).toBe(0);
  });

  it("delete and action cards get the same «Отмена» treatment", () => {
    const messages = setBody();

    const appendAgentDeleteProposal = getFn("appendAgentDeleteProposal");
    appendAgentDeleteProposal({
      projectId: "p1",
      projectName: "Парк",
      filterLabel: "готовые",
      canDelete: true,
      tasks: [{ id: "t1", title: "Старое", deadline: null, assigneeDisplay: "—", statusDisplay: "готово" }],
    });
    const appendAgentActionProposal = getFn("appendAgentActionProposal");
    appendAgentActionProposal({
      action: "rename_task",
      title: "Переименовать задачу",
      summary: "«А» → «Б»",
      confirmLabel: "Переименовать",
    });

    const cards = messages.querySelectorAll(".agent-task-proposal");
    expect(cards.length).toBe(2);
    cards.forEach((card) => {
      const cancelBtn = card.querySelector(".agent-task-proposal-cancel");
      expect(cancelBtn).not.toBeNull();
      cancelBtn.click();
      expect(card.classList.contains("agent-task-proposal-cancelled")).toBe(true);
      expect(card.querySelector(".agent-task-proposal-status")?.textContent).toBe("Действие отменено");
    });
  });

  it("confirming also disables «Отмена» while the request is in flight", async () => {
    const messages = setBody();
    const appendAgentTaskProposal = getFn("appendAgentTaskProposal");
    appendAgentTaskProposal({
      source: "text",
      projectId: "p1",
      projectName: "Дом",
      canCreate: true,
      tasks: [{ title: "Задача", deadline: null, assigneeDisplay: "Иван", ok: true }],
    });
    const card = messages.querySelector(".agent-task-proposal");
    const confirmBtn = card.querySelector(".agent-task-proposal-create");
    const cancelBtn = card.querySelector(".agent-task-proposal-cancel");

    ctx.firebase.auth = () => ({
      currentUser: { getIdToken: async () => "fake-id-token" },
    });
    let resolveFetch;
    ctx.fetch = () =>
      new Promise((resolve) => {
        resolveFetch = resolve;
      });

    confirmBtn.click();
    // Cancelling mid-flight would mislabel tasks the server is already
    // creating, so the whole row locks for the duration of the request.
    expect(confirmBtn.disabled).toBe(true);
    expect(cancelBtn.disabled).toBe(true);

    // fetch() fires a few microtask hops after the click (getIdToken await),
    // then settle the request so nothing dangles into later tests.
    await flushMicrotasks();
    expect(typeof resolveFetch).toBe("function");
    resolveFetch({ ok: true, status: 200, json: async () => ({ ok: true, created: 1 }) });
    await flushMicrotasks();
    expect(card.querySelector(".agent-task-proposal-status")?.textContent).toBe("✓ Задачи созданы");
  });
});

describe("proposal-card done state / inline errors", () => {
  function setBody() {
    ctx.document.body.textContent = "";
    const messages = ctx.document.createElement("div");
    messages.id = "agent-chat-messages";
    ctx.document.body.appendChild(messages);
    vm.runInContext(
      `
      elements.agentChatMessages = document.getElementById('agent-chat-messages');
      agentChatState.history = [];
      `,
      ctx
    );
    return messages;
  }

  it("create card: successful confirm replaces the button row with «✓ Задачи созданы»", async () => {
    const messages = setBody();
    const appendAgentTaskProposal = getFn("appendAgentTaskProposal");
    const proposal = {
      source: "text",
      projectId: "p1",
      projectName: "Дом",
      canCreate: true,
      tasks: [{ title: "Проверить бассейн", deadline: null, assigneeDisplay: "Иван", assigneeUid: "u1", ok: true }],
    };
    appendAgentTaskProposal(proposal);
    const card = messages.querySelector(".agent-task-proposal");
    const btn = card.querySelector(".agent-task-proposal-create");
    const actions = card.querySelector(".agent-task-proposal-actions");

    ctx.firebase.auth = () => ({
      currentUser: { getIdToken: async () => "fake-id-token" },
    });
    ctx.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, created: 1 }),
    });

    const confirmAgentTaskProposal = getFn("confirmAgentTaskProposal");
    await confirmAgentTaskProposal(proposal, proposal.tasks, btn, actions);

    expect(btn.isConnected).toBe(false);
    expect(actions.querySelectorAll("button").length).toBe(0);
    const status = actions.querySelector(".agent-task-proposal-status");
    expect(status?.textContent).toBe("✓ Задачи созданы");
    expect(status?.className).toContain("agent-task-proposal-status-done");
    // Detailed summary still appended as a normal assistant bubble
    // (cards also carry .agent-chat-message-assistant, so exclude them)
    expect(messages.querySelector(".agent-chat-message-assistant:not(.agent-task-proposal)")?.textContent).toContain("Создано задач: 1");
  });

  it("action card: successful confirm replaces the row with «✓ Действие выполнено»", async () => {
    const messages = setBody();
    const appendAgentActionProposal = getFn("appendAgentActionProposal");
    const proposal = {
      action: "rename_task",
      title: "Переименовать задачу",
      summary: "«А» → «Б»",
      confirmLabel: "Переименовать",
      proposalId: "x1",
    };
    appendAgentActionProposal(proposal);
    const card = messages.querySelector(".agent-task-proposal");
    const btn = card.querySelector(".agent-task-proposal-create");
    const actions = card.querySelector(".agent-task-proposal-actions");

    ctx.firebase.auth = () => ({
      currentUser: { getIdToken: async () => "fake-id-token" },
    });
    ctx.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: "Задача переименована." }),
    });

    const confirmAgentActionProposal = getFn("confirmAgentActionProposal");
    await confirmAgentActionProposal(proposal, btn, actions);

    expect(btn.isConnected).toBe(false);
    expect(actions.querySelector(".agent-task-proposal-status")?.textContent).toBe("✓ Действие выполнено");
    expect(messages.querySelector(".agent-chat-message-assistant:not(.agent-task-proposal)")?.textContent).toContain("Задача переименована");
  });

  it("action card: a 409-style failure is shown inline and the card stays live", async () => {
    const messages = setBody();
    const appendAgentActionProposal = getFn("appendAgentActionProposal");
    const proposal = {
      action: "rename_task",
      title: "Переименовать задачу",
      summary: "«А» → «Б»",
      confirmLabel: "Переименовать",
      proposalId: "x1",
    };
    appendAgentActionProposal(proposal);
    const card = messages.querySelector(".agent-task-proposal");
    const btn = card.querySelector(".agent-task-proposal-create");
    const actions = card.querySelector(".agent-task-proposal-actions");

    ctx.firebase.auth = () => ({
      currentUser: { getIdToken: async () => "fake-id-token" },
    });
    ctx.fetch = async () => ({
      ok: false,
      status: 409,
      json: async () => ({ ok: false, error: "Предложение устарело или уже выполнено." }),
    });

    const confirmAgentActionProposal = getFn("confirmAgentActionProposal");
    await confirmAgentActionProposal(proposal, btn, actions);

    // Buttons stay live, server message lands INSIDE the card…
    expect(btn.isConnected).toBe(true);
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe("Переименовать");
    expect(actions.querySelector(".agent-task-proposal-error")?.textContent).toContain("Предложение устарело или уже выполнено.");
    // …and NOT as a detached chat-level error bubble
    expect(messages.querySelector(".agent-chat-message-error")).toBeNull();
  });
});

describe("empty-state example chips", () => {
  it("fill the input on click without submitting anything", () => {
    ctx.document.body.textContent = "";
    const messages = ctx.document.createElement("div");
    messages.id = "agent-chat-messages";
    const input = ctx.document.createElement("textarea");
    input.id = "agent-chat-input";
    ctx.document.body.append(messages, input);
    vm.runInContext(
      `
      elements.agentChatMessages = document.getElementById('agent-chat-messages');
      elements.agentChatInput = document.getElementById('agent-chat-input');
      `,
      ctx
    );
    let fetchCalled = false;
    ctx.fetch = async () => {
      fetchCalled = true;
      return { status: 200, json: async () => ({ ok: true }) };
    };

    const renderAgentChatEmptyState = getFn("renderAgentChatEmptyState");
    renderAgentChatEmptyState();

    const chips = messages.querySelectorAll(".agent-chat-chip");
    expect(chips.length).toBe(4);
    expect(chips[0].textContent).toBe("Что просрочено?");
    // The original one-line hint is still there above the chips
    expect(messages.querySelector(".agent-chat-empty")?.textContent).toContain("текущей организации");

    chips[0].click();

    // Text lands in the input, but NOTHING is sent and no bubble renders
    expect(input.value).toBe("Что просрочено?");
    expect(fetchCalled).toBe(false);
    expect(messages.querySelector(".agent-chat-message-user")).toBeNull();
    expect(messages.querySelector(".agent-chat-empty")).not.toBeNull();
  });
});

describe("error-bubble «Повторить» retry", () => {
  it("re-submits the failed message through the normal send path", async () => {
    const dom = setFullAgentChatDom();
    dom.input.value = "Что просрочено?";
    ctx.firebase.auth = () => ({
      currentUser: { getIdToken: async () => "fake-id-token" },
    });

    const sentBodies = [];
    let failOnce = true;
    ctx.fetch = async (url, options) => {
      sentBodies.push(JSON.parse(options.body));
      if (failOnce) {
        failOnce = false;
        throw new Error("offline");
      }
      return { status: 200, json: async () => ({ ok: true, answer: "Ничего не просрочено." }) };
    };

    const handleAgentChatSubmit = getFn("handleAgentChatSubmit");
    await handleAgentChatSubmit({ preventDefault: () => {} });

    const errorBubble = dom.messages.querySelector(".agent-chat-message-error");
    expect(errorBubble).not.toBeNull();
    expect(errorBubble.textContent).toContain("Ошибка сети");
    // The failed question was popped from history (server never saw it)…
    expect(vm.runInContext("agentChatState.history.length", ctx)).toBe(0);
    // …but its text survived on the bubble's retry button
    const retryBtn = errorBubble.querySelector(".agent-chat-retry-btn");
    expect(retryBtn).not.toBeNull();
    expect(retryBtn.textContent).toBe("Повторить");

    retryBtn.click();
    expect(retryBtn.disabled).toBe(true);
    await flushMicrotasks();

    // Same message went out again, and the answer rendered normally
    expect(sentBodies.length).toBe(2);
    expect(sentBodies[0].message).toBe("Что просрочено?");
    expect(sentBodies[1].message).toBe("Что просрочено?");
    expect(dom.messages.querySelector(".agent-chat-message-assistant")?.textContent).toBe("Ничего не просрочено.");
    expect(dom.messages.querySelectorAll(".agent-chat-message-user").length).toBe(2);
    expect(vm.runInContext("agentChatState.history.length", ctx)).toBe(2);
  });
});

describe("agent notifications bulk deletion", () => {
  function setNotificationDom() {
    ctx.document.body.innerHTML = `
      <button id="agent-notify-read-all" type="button">Прочитать все</button>
      <button id="agent-notify-delete-all" type="button">Удалить все</button>
      <span id="agent-notify-count"></span>
      <div id="agent-notify-list"></div>
    `;
    vm.runInContext(`
      agentNotifyDeletingAll = false;
      agentNotifications = [
        { id: 'n-1', text: 'Первое', readAt: null },
        { id: 'n-2', text: 'Второе', readAt: { seconds: 1 } }
      ];
    `, ctx);
    getFn("renderAgentNotifyBadge")();
    getFn("renderAgentNotifyList")();
    return ctx.document.getElementById("agent-notify-delete-all");
  }

  it("sends an organization-scoped delete-all action only after confirmation", async () => {
    const button = setNotificationDom();
    const requests = [];
    ctx.confirm = () => true;
    ctx.firebase.auth = () => ({
      currentUser: { getIdToken: async () => "fake-id-token" },
    });
    ctx.fetch = async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200, json: async () => ({ ok: true, deleted: 2 }) };
    };

    await getFn("deleteAllAgentNotifications")(button);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("/api/agent-chat");
    expect(JSON.parse(requests[0].options.body)).toEqual({ action: "delete_notifications", all: true });
    expect(ctx.document.getElementById("agent-notify-list").textContent).toContain("Пока нет уведомлений");
    expect(ctx.document.getElementById("agent-notify-count").style.display).toBe("none");
    expect(button.disabled).toBe(true);
  });

  it("does nothing when the destructive confirmation is cancelled", async () => {
    const button = setNotificationDom();
    let fetchCalled = false;
    ctx.confirm = () => false;
    ctx.fetch = async () => {
      fetchCalled = true;
      return { ok: true, json: async () => ({ ok: true }) };
    };

    await getFn("deleteAllAgentNotifications")(button);

    expect(fetchCalled).toBe(false);
    expect(ctx.document.querySelectorAll(".agent-notify-item")).toHaveLength(2);
  });
});
