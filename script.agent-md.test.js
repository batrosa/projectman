// Tests for renderAgentChatMarkdown — the safe Markdown renderer for the AI
// agent's chat answers. Like script.xss.test.js, script.js is loaded into jsdom
// via vm so we exercise the REAL renderer against a real DOM. The security
// invariant: model text (which can be influenced by org data) is never treated
// as markup — it only ever reaches the DOM via textContent, and only a fixed
// whitelist of structural elements is created.
import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_SOURCE = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");

let ctx;

beforeAll(() => {
  const dom = new JSDOM("<!DOCTYPE html><html><body></body></html>", { url: "http://localhost/" });
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
    URLSearchParams: window.URLSearchParams,
  };
  context.globalThis = context;
  context.self = context;
  vm.createContext(context);
  vm.runInContext(SCRIPT_SOURCE, context, { filename: "script.js" });
  ctx = context;
});

function render(md) {
  const container = ctx.document.createElement("div");
  vm.runInContext("(renderAgentChatMarkdown)", ctx)(container, md);
  return container;
}

describe("renderAgentChatMarkdown — tables", () => {
  it("renders a GFM table into a real <table> with headers and cells", () => {
    const md = [
      "| Объект | Срок | Статус |",
      "| --- | --- | --- |",
      "| Дороги | дек 2026 | в процессе |",
      "| МФЦ | май 2025 | завершён |",
    ].join("\n");
    const c = render(md);

    expect(c.querySelector("table.agent-md-table")).not.toBeNull();
    expect([...c.querySelectorAll("th")].map((t) => t.textContent)).toEqual(["Объект", "Срок", "Статус"]);
    const rows = c.querySelectorAll("tbody tr");
    expect(rows.length).toBe(2);
    expect([...rows[0].querySelectorAll("td")].map((t) => t.textContent)).toEqual(["Дороги", "дек 2026", "в процессе"]);
  });

  it("parses a header row without outer pipes", () => {
    const md = "Имя | Роль\n--- | ---\nИван | Админ";
    const c = render(md);
    expect([...c.querySelectorAll("th")].map((t) => t.textContent)).toEqual(["Имя", "Роль"]);
    expect([...c.querySelectorAll("tbody td")].map((t) => t.textContent)).toEqual(["Иван", "Админ"]);
  });

  it("keeps a malicious cell inert — no element is parsed from model text", () => {
    const md = ["| Имя | Заметка |", "| --- | --- |", "| Иван | <img src=x onerror=alert(1)> |"].join("\n");
    const c = render(md);
    expect(c.querySelectorAll("img").length).toBe(0);
    expect(c.querySelector("tbody td:last-child").textContent).toContain("<img");
  });
});

describe("renderAgentChatMarkdown — inline & blocks", () => {
  it("renders **bold** and `code` as elements", () => {
    const c = render("Это **важно** и `код`.");
    expect(c.querySelector("strong").textContent).toBe("важно");
    expect(c.querySelector("code").textContent).toBe("код");
  });

  it("renders a fenced code block preserving its text verbatim", () => {
    const c = render("```\nline1\nline2\n```");
    const code = c.querySelector("pre.agent-md-pre code");
    expect(code).not.toBeNull();
    expect(code.textContent).toBe("line1\nline2");
  });

  it("renders a bullet list", () => {
    const c = render("- один\n- два\n- три");
    const items = c.querySelectorAll("ul.agent-md-list li");
    expect(items.length).toBe(3);
    expect(items[0].textContent).toBe("один");
  });

  it("renders a numbered list as <ol>", () => {
    const c = render("1. первый\n2. второй");
    expect(c.querySelector("ol.agent-md-list")).not.toBeNull();
    expect(c.querySelectorAll("ol.agent-md-list li").length).toBe(2);
  });

  it("never creates a <script> element from a fenced XSS payload", () => {
    const c = render("```\n<script>alert(1)</script>\n```");
    expect(c.querySelectorAll("script").length).toBe(0);
    expect(c.querySelector("pre code").textContent).toContain("<script>");
  });

  it("treats a lone paragraph with < > & as inert text", () => {
    const c = render("a < b && c > d");
    expect(c.querySelectorAll("*").length === 1 || c.querySelector(".agent-md-p")).toBeTruthy();
    expect(c.textContent).toContain("a < b && c > d");
  });
});
