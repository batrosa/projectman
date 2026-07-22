import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import vm from "node:vm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT_SOURCE = fs.readFileSync(path.join(__dirname, "script.js"), "utf8");
const STYLE_SOURCE = fs.readFileSync(path.join(__dirname, "style.css"), "utf8");

let ctx;
let window;

beforeAll(() => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>
    <div id="calendar-view-container" class="active">
      <button id="cal-prev-month"></button>
      <h2 id="cal-current-month"></h2>
      <button id="cal-next-month"></button>
      <button id="cal-today-btn"></button>
      <div id="calendar-grid"></div>
    </div>
    <div id="day-tasks-modal">
      <button class="close-modal"></button>
      <h2 id="day-tasks-title"></h2>
      <div id="day-tasks-body"></div>
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
});

beforeEach(() => {
  vm.runInContext(`
    state.activeProjectId = 'p1';
    state.tasks = [];
    calendarState.currentDate = new Date(2026, 6, 1);
    calendarState.openDayDate = null;
  `, ctx);
  window.document.getElementById("calendar-grid").textContent = "";
});

describe("Calendar month grid", () => {
  it("renders only current-month dates and keeps weekday alignment with empty cells", () => {
    vm.runInContext(`
      state.tasks = [
        { id: 'july', projectId: 'p1', title: 'Очень длинное название задачи, которое не должно расширять колонку', deadline: '2026-07-22', status: 'in-progress', subStatus: 'in_work' },
        { id: 'june', projectId: 'p1', title: 'Июнь', deadline: '2026-06-30', status: 'in-progress', subStatus: 'in_work' },
        { id: 'august', projectId: 'p1', title: 'Август', deadline: '2026-08-01', status: 'in-progress', subStatus: 'in_work' }
      ];
      renderCalendar();
    `, ctx);

    const grid = window.document.getElementById("calendar-grid");
    const days = Array.from(grid.querySelectorAll(".calendar-day:not(.calendar-day-empty)"));
    const empty = Array.from(grid.querySelectorAll(".calendar-day-empty"));
    const pills = Array.from(grid.querySelectorAll(".calendar-task-pill"));

    expect(grid.children).toHaveLength(35);
    expect(grid.style.getPropertyValue("--calendar-week-count")).toBe("5");
    expect(days).toHaveLength(31);
    expect(empty).toHaveLength(4);
    expect(empty.every(cell => cell.textContent === "" && cell.getAttribute("aria-hidden") === "true")).toBe(true);
    expect(grid.querySelector(".other-month")).toBeNull();
    expect(pills).toHaveLength(1);
    expect(pills[0].querySelector(".calendar-task-title")?.textContent).toContain("Очень длинное");
  });

  it("uses only as many week rows as the selected month needs", () => {
    const rows = vm.runInContext(`(() => {
      calendarState.currentDate = new Date(2027, 1, 1);
      renderCalendar();
      const february = [calElements.grid.children.length, calElements.grid.style.getPropertyValue('--calendar-week-count')];
      calendarState.currentDate = new Date(2026, 7, 1);
      renderCalendar();
      const august = [calElements.grid.children.length, calElements.grid.style.getPropertyValue('--calendar-week-count')];
      return { february, august };
    })()`, ctx);

    expect(Array.from(rows.february)).toEqual([28, "4"]);
    expect(Array.from(rows.august)).toEqual([42, "6"]);
  });

  it("locks all seven tracks and task text against content-driven expansion", () => {
    expect(STYLE_SOURCE).toMatch(/grid-template-columns:\s*repeat\(7,\s*minmax\(0,\s*1fr\)\)/);
    expect(STYLE_SOURCE).toMatch(/\.calendar-day\s*\{[\s\S]*?min-width:\s*0;[\s\S]*?overflow:\s*hidden;/);
    expect(STYLE_SOURCE).toMatch(/\.calendar-task-title\s*\{[\s\S]*?text-overflow:\s*ellipsis;[\s\S]*?white-space:\s*nowrap;/);
  });

  it("draws grid borders only around dates and keeps empty slots borderless", () => {
    expect(STYLE_SOURCE).toMatch(/\.calendar-grid\s*\{[\s\S]*?gap:\s*0;[\s\S]*?background:\s*transparent;[\s\S]*?border:\s*0;/);
    expect(STYLE_SOURCE).toMatch(/\.calendar-day:not\(\.calendar-day-empty\)\s*\{[\s\S]*?box-shadow:\s*inset 0 0 0 1px var\(--border\);/);
    expect(STYLE_SOURCE).toMatch(/\.calendar-day\.calendar-day-empty\s*\{[\s\S]*?background:\s*rgba\(15, 23, 42, 0\.035\);[\s\S]*?box-shadow:\s*none;/);
    expect(STYLE_SOURCE).toMatch(/body:not\(\.light-mode\) \.calendar-day\.calendar-day-empty\s*\{[\s\S]*?background:\s*#202c3f;[\s\S]*?box-shadow:\s*none;/);
  });
});
