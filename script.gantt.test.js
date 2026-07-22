import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_SOURCE = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");

let ctx;
let window;

beforeAll(() => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="gantt-container" class="active">
      <button id="gantt-prev-period"></button>
      <select id="gantt-period-select"></select>
      <button id="gantt-next-period"></button>
      <button id="gantt-year-mode" class="active" aria-pressed="true">Год</button>
      <button id="gantt-month-mode" aria-pressed="false">Месяц</button>
      <span id="gantt-no-deadline-note"></span>
      <div id="gantt-scroll"></div>
    </div>
  </body></html>`, { url: "http://localhost/" });
  window = dom.window;

  ctx = {
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
    getComputedStyle: window.getComputedStyle.bind(window),
  };
  ctx.globalThis = ctx;
  ctx.self = ctx;
  vm.createContext(ctx);
  vm.runInContext(SCRIPT_SOURCE, ctx, { filename: "script.js" });
  vm.runInContext("playClickSound = () => {}", ctx);
});

beforeEach(() => {
  vm.runInContext(`
    state.activeProjectId = 'p1';
    state.tasks = [];
    state.ganttYear = new Date().getFullYear();
    state.ganttMonth = null;
    ganttLastScrollKey = null;
  `, ctx);
  window.document.getElementById("gantt-scroll").textContent = "";
  vm.runInContext("renderGantt()", ctx);
});

describe("Gantt period controls", () => {
  it("opens on the current year with the year button selected", () => {
    const currentYear = new Date().getFullYear();
    expect(window.document.getElementById("gantt-period-select").value).toBe(String(currentYear));
    expect(window.document.getElementById("gantt-year-mode").getAttribute("aria-pressed")).toBe("true");
    expect(window.document.getElementById("gantt-month-mode").getAttribute("aria-pressed")).toBe("false");
  });

  it("opens the current month from the explicit Month button", () => {
    const now = new Date();
    window.document.getElementById("gantt-scroll").textContent = "";
    window.document.getElementById("gantt-month-mode").click();

    expect(vm.runInContext("state.ganttYear", ctx)).toBe(now.getFullYear());
    expect(vm.runInContext("state.ganttMonth", ctx)).toBe(now.getMonth());
    expect(window.document.getElementById("gantt-period-select").value).toBe(String(now.getMonth()));
    expect(window.document.getElementById("gantt-period-select").selectedOptions[0].textContent)
      .toContain(String(now.getFullYear()));
    expect(window.document.getElementById("gantt-month-mode").getAttribute("aria-pressed")).toBe("true");
  });

  it("moves month arrows across a year boundary", () => {
    vm.runInContext("state.ganttYear = 2026; state.ganttMonth = 0; renderGantt();", ctx);
    window.document.getElementById("gantt-prev-period").click();

    expect(vm.runInContext("state.ganttYear", ctx)).toBe(2025);
    expect(vm.runInContext("state.ganttMonth", ctx)).toBe(11);
    expect(window.document.getElementById("gantt-period-select").selectedOptions[0].textContent)
      .toBe("Декабрь 2025");
  });

  it("keeps year-mode month headers non-interactive", () => {
    const monthHeader = window.document.querySelector(".gantt-month");
    expect(monthHeader).not.toBeNull();
    expect(monthHeader.hasAttribute("data-month")).toBe(false);
    monthHeader.click();
    expect(vm.runInContext("state.ganttMonth", ctx)).toBeNull();
  });
});

describe("Gantt deadline colors", () => {
  it("maps elapsed task time to the four deadline bands", () => {
    const states = vm.runInContext(`(() => {
      const start = new Date(2026, 0, 1).getTime();
      const deadline = new Date(2026, 0, 4).getTime();
      const end = getGanttDeadlineEndMs(deadline);
      const at = fraction => start + (end - start) * fraction;
      return [
        getGanttDeadlineState(start, deadline, at(0.25)).tone,
        getGanttDeadlineState(start, deadline, at(0.26)).tone,
        getGanttDeadlineState(start, deadline, at(0.50)).tone,
        getGanttDeadlineState(start, deadline, at(0.51)).tone,
        getGanttDeadlineState(start, deadline, at(0.99)).tone,
        getGanttDeadlineState(start, deadline, at(1)).tone
      ];
    })()`, ctx);

    expect(Array.from(states)).toEqual([
      "early", "middle", "middle", "late", "late", "overdue"
    ]);
  });

  it("shows active tasks but excludes completed archive tasks", () => {
    vm.runInContext(`
      state.ganttYear = 2026;
      state.ganttMonth = null;
      state.tasks = [
        { id: 'active', projectId: 'p1', title: 'Активная', status: 'in-progress', subStatus: 'in_work', createdAt: '2026-01-01T12:00:00', deadline: '2026-01-10' },
        { id: 'done', projectId: 'p1', title: 'Завершённая', status: 'done', subStatus: 'completed', createdAt: '2026-01-01T12:00:00', deadline: '2026-01-10' }
      ];
      renderGantt();
    `, ctx);

    const rows = Array.from(window.document.querySelectorAll("[data-gantt-task]"));
    expect(rows.map(row => row.dataset.ganttTask)).toEqual(["active"]);
    const bar = window.document.querySelector("[data-gantt-task='active'] .gantt-bar");
    expect(bar).not.toBeNull();
    expect(bar.className).toMatch(/deadline-(early|middle|late|overdue)/);
    expect(bar.className).not.toMatch(/status-(assigned|in-progress|review|done)/);
  });
});
