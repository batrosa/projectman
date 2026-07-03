# Agent Tasks + Notifications + Monitor — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Агент создаёт задачи из документов проекта (предпросмотр → подтверждение), в приложении появляется лента уведомлений агента (колокольчик), серверный монитор ежедневно+ежечасно проверяет сроки и шлёт уведомления в ленту и Telegram исполнителю и постановщику.

**Architecture:** Три независимых этапа поверх существующего стека (vanilla JS SPA + Firebase Firestore/Auth + Vercel serverless). Новая коллекция `agentNotifications` (пишет только сервер), новая функция `api/agent-monitor` (11-я из 12, вход по `CRON_SECRET`, будят Vercel Cron раз в сутки и GitHub Actions раз в час), создание задач — расширение существующего `api/agent-chat` двухфазным протоколом (LLM-предложение → серверная валидация → подтверждение кнопкой → батч-создание Admin SDK). Клиентские напоминания (`checkReminders`) отключаются — сервер единственный источник.

**Tech Stack:** Firebase Admin SDK (ESM), Firestore rules v2, Vercel Hobby (cron daily-only), GitHub Actions schedule, OpenRouter (только для извлечения задач из документа; монитор без LLM), vitest (+ rules-unit-testing на эмуляторе).

**Дизайн:** `docs/plans/2026-07-03-agent-tasks-notifications-design.md` (утверждён). Решения пользователя: предпросмотр; GH Actions ежечасно; просрочка — раз в день пока не закрыта.

**Правила проекта (обязательны):**
- Деплой каждого этапа: тесты → `git push` (Vercel) → дождаться нового cache-buster на проде → `npx firebase deploy --only firestore:rules[,firestore:indexes] --project projectman-96d3c`. НИКОГДА не деплоить правила раньше клиента.
- Тесты: JS — `npx vitest run --exclude 'firestore-tests/**'`; правила — `PATH=/opt/homebrew/opt/openjdk/bin:$PATH npm run test:rules`.
- Cache-buster `script.js?v=NN` в index.html:577 бампать при КАЖДОМ изменении script.js (текущее значение проверять перед правкой; на момент плана v=64, коммит ac141a7 мог поднять — проверить).
- Хук блокирует `innerHTML` с нестатичным содержимым — клиентский DOM строить через `createElement`/`textContent`.
- Секреты НЕ трогать: значения `CRON_SECRET` задаёт пользователь (Vercel env + GitHub Secrets). Без секрета монитор отвечает 401 всем — fail closed.
- Лимит Vercel Hobby 12 функций; сейчас 10 (`ls api/*.js | grep -v test | wc -l`), станет 11. `.vercelignore` уже исключает `*.test.js`.

---

## Этап 1 — Лента уведомлений (колокольчик)

### Task 1: `lib/telegram-send.js` + рефактор `api/notify-telegram.js`

**Files:**
- Create: `lib/telegram-send.js`
- Create: `lib/telegram-send.test.js`
- Modify: `api/notify-telegram.js` (блок fetch к api.telegram.org, ~строки 88-101)

**Step 1: failing test** — `lib/telegram-send.test.js`:

```js
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { sendTelegramMessage } from "./telegram-send.js";

describe("sendTelegramMessage", () => {
  const realFetch = global.fetch;
  beforeEach(() => { process.env.TELEGRAM_BOT_TOKEN = "TOKEN123"; });
  afterEach(() => { global.fetch = realFetch; delete process.env.TELEGRAM_BOT_TOKEN; });

  it("POSTs chat_id/text to the bot sendMessage endpoint and returns ok", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    const res = await sendTelegramMessage("42", "привет");
    expect(res.ok).toBe(true);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/botTOKEN123/sendMessage");
    expect(JSON.parse(opts.body)).toEqual({ chat_id: "42", text: "привет" });
  });

  it("adds parse_mode only when given", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true }) }));
    await sendTelegramMessage("42", "<b>x</b>", { parseMode: "HTML" });
    expect(JSON.parse(global.fetch.mock.calls[0][1].body).parse_mode).toBe("HTML");
  });

  it("returns ok:false (does not throw) when token missing or fetch fails", async () => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    expect((await sendTelegramMessage("42", "x")).ok).toBe(false);
    process.env.TELEGRAM_BOT_TOKEN = "T";
    global.fetch = vi.fn(async () => { throw new Error("net"); });
    expect((await sendTelegramMessage("42", "x")).ok).toBe(false);
  });
});
```

**Step 2:** `npx vitest run lib/telegram-send.test.js` → FAIL (module not found).

**Step 3: implementation** — `lib/telegram-send.js`:

```js
// Shared server-side Telegram sender. Token stays server-only
// (TELEGRAM_BOT_TOKEN env). Never throws — notification delivery must not
// break the calling flow (monitor sweep / task creation / notify endpoint).
export async function sendTelegramMessage(chatId, text, { parseMode } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId || !text) return { ok: false, error: "missing token/chatId/text" };
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, ...(parseMode ? { parse_mode: parseMode } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) return { ok: false, error: data.description || `HTTP ${res.status}` };
    return { ok: true };
  } catch (error) {
    console.error("sendTelegramMessage failed", error?.message || error);
    return { ok: false, error: String(error?.message || error) };
  }
}
```

**Step 4:** тест зелёный. **Step 5:** отрефакторить `api/notify-telegram.js`: заменить прямой fetch на `sendTelegramMessage(chatId, text, { parseMode })`, СОХРАНИВ существующие проверки (метод/авторизация/анти-релей same-org) и коды ответов. Прогнать `api/notify-telegram.test.js` — если он мокает `global.fetch`, поведение не изменится (lib использует тот же fetch). **Step 6:** полный JS-набор зелёный. **Step 7:** commit `refactor(telegram): extract shared lib/telegram-send`.

### Task 2: правила `agentNotifications` + rules-тесты

**Files:**
- Modify: `firestore.rules` (перед блоком `auditLogs`)
- Create: `firestore-tests/agent-notifications.rules.test.js`

**Step 1: failing tests** (шаблон файла — как `firestore-tests/users.rules.test.js`: initializeTestEnvironment, projectId `projectman-rules-agentnotes`):

- получатель читает СВОЁ уведомление (get) — succeeds;
- чужое (другой uid) — fails;
- клиентский create — fails (даже со своим uid в данных);
- update `readAt` своего — succeeds; update `text` своего — fails; update чужого `readAt` — fails;
- delete своего — fails.

Сид через `withSecurityRulesDisabled` (сервер = Admin SDK, правила обходит — в тесте это сид).

**Step 2:** тесты падают (коллекция default-deny). **Step 3: правило** — в `firestore.rules` перед `match /auditLogs`:

```
    // agentNotifications — лента уведомлений агента. Пишет ТОЛЬКО сервер
    // (api/agent-monitor, api/agent-chat через Admin SDK). Клиент: читает и
    // помечает прочитанным только СВОИ записи; подделать/удалить нельзя.
    match /agentNotifications/{noteId} {
      allow get, list: if request.auth != null && resource.data.uid == request.auth.uid;
      allow update: if request.auth != null
        && resource.data.uid == request.auth.uid
        && request.resource.data.diff(resource.data).affectedKeys().hasOnly(['readAt']);
      allow create, delete: if false;
    }
```

**Step 4:** `npm run test:rules` — все зелёные (44 старых + новые). **Step 5:** commit `feat(rules): agentNotifications collection — server-write, owner-read`.

### Task 3: композитный индекс

**Files:**
- Create: `firestore.indexes.json`
- Modify: `firebase.json` (в секцию `"firestore"` добавить `"indexes": "firestore.indexes.json"`)

`firestore.indexes.json`:

```json
{
  "indexes": [
    {
      "collectionGroup": "agentNotifications",
      "queryScope": "COLLECTION",
      "fields": [
        { "fieldPath": "uid", "order": "ASCENDING" },
        { "fieldPath": "createdAt", "order": "DESCENDING" }
      ]
    }
  ],
  "fieldOverrides": []
}
```

Тестов нет (конфиг). Commit `chore(firestore): composite index for agentNotifications feed`.

### Task 4: колокольчик (клиент)

**Files:**
- Modify: `index.html` — кнопка после `#my-tasks-btn` (строка ~855-858) + модалка после `#my-tasks-modal` (~1751); бамп cache-buster (:577)
- Modify: `style.css` — стили бейджа/списка (переиспользовать классы my-tasks где можно)
- Modify: `script.js` — состояние, листенер, рендер, mark-read

**index.html — кнопка (сразу после закрывающего тега кнопки my-tasks-btn):**

```html
                <button id="agent-notify-btn" class="my-tasks-btn" style="width: 100%; justify-content: center;">
                    <i class="fa-solid fa-bell"></i> <span>Уведомления</span>
                    <span id="agent-notify-count" class="my-tasks-count" style="display: none;">0</span>
                </button>
```

**index.html — модалка (после закрытия #my-tasks-modal), структуру скопировать с my-tasks-modal:** заголовок `<i class="fa-solid fa-bell"></i> Уведомления агента`, кнопка `id="agent-notify-read-all"` «Прочитать все», контейнер `id="agent-notify-list"`, крестик закрытия — те же классы, что у my-tasks.

**script.js — добавить рядом с subscribeToMyTasks (искать `myTasksChunkUnsubs`):**

```js
// ===== AGENT NOTIFICATIONS FEED (колокольчик) =====
let agentNotifyUnsubscribe = null;
let agentNotifications = [];

function subscribeToAgentNotifications() {
    if (agentNotifyUnsubscribe) { agentNotifyUnsubscribe(); agentNotifyUnsubscribe = null; }
    const uid = state.currentUser?.uid;
    if (!uid || !db) return;
    agentNotifyUnsubscribe = db.collection('agentNotifications')
        .where('uid', '==', uid)
        .orderBy('createdAt', 'desc')
        .limit(50)
        .onSnapshot(snap => {
            agentNotifications = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            renderAgentNotifyBadge();
            renderAgentNotifyList();
        }, err => console.error('agentNotifications listener:', err));
}

function renderAgentNotifyBadge() {
    const badge = document.getElementById('agent-notify-count');
    if (!badge) return;
    const unread = agentNotifications.filter(n => !n.readAt).length;
    badge.textContent = String(unread);
    badge.style.display = unread > 0 ? '' : 'none';
}

const AGENT_NOTIFY_ICONS = {
    overdue: 'fa-triangle-exclamation',
    deadline_tomorrow: 'fa-clock',
    not_taken_1h: 'fa-hourglass-half',
    tasks_created: 'fa-square-plus'
};

function renderAgentNotifyList() {
    const list = document.getElementById('agent-notify-list');
    if (!list) return;
    list.textContent = '';
    if (agentNotifications.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'agent-notify-empty';
        empty.textContent = 'Пока нет уведомлений от агента';
        list.appendChild(empty);
        return;
    }
    agentNotifications.forEach(n => {
        const item = document.createElement('div');
        item.className = 'agent-notify-item' + (n.readAt ? '' : ' unread');
        const icon = document.createElement('i');
        icon.className = 'fa-solid ' + (AGENT_NOTIFY_ICONS[n.type] || 'fa-bell');
        const body = document.createElement('div');
        body.className = 'agent-notify-body';
        const text = document.createElement('div');
        text.className = 'agent-notify-text';
        text.textContent = n.text || '';
        const when = document.createElement('div');
        when.className = 'agent-notify-time';
        when.textContent = formatDateTimeRu(n.createdAt) || '';
        body.appendChild(text); body.appendChild(when);
        item.appendChild(icon); item.appendChild(body);
        item.addEventListener('click', () => {
            markAgentNotificationRead(n);
            if (n.taskId) openTaskFromNotification(n); // навигация: как клик из «Мои задачи»
        });
        list.appendChild(item);
    });
}

function markAgentNotificationRead(n) {
    if (!n || n.readAt) return;
    db.collection('agentNotifications').doc(n.id)
        .update({ readAt: firebase.firestore.FieldValue.serverTimestamp() })
        .catch(err => console.warn('mark read failed:', err?.message || err));
}

function markAllAgentNotificationsRead() {
    const unread = agentNotifications.filter(n => !n.readAt);
    if (unread.length === 0) return;
    const batch = db.batch();
    unread.forEach(n => batch.update(
        db.collection('agentNotifications').doc(n.id),
        { readAt: firebase.firestore.FieldValue.serverTimestamp() }
    ));
    batch.commit().catch(err => console.warn('mark all read failed:', err?.message || err));
}
```

`openTaskFromNotification(n)` — повторить механику открытия задачи из «Мои задачи» (найти её обработчик клика и вызвать ту же функцию открытия модалки задачи по taskId; если задача уже удалена — молча ничего).

**Подключение:** вызывать `subscribeToAgentNotifications()` там же, где `subscribeToMyTasks()` после входа; отписка при logout — рядом с `unsubscribeFromMyTasks()`. Обработчики кнопки/модалки/read-all — в `setupEventListeners()` по образцу my-tasks. Кнопку добавить в исключения read-only CSS (`style.css` ~1875, список селекторов с `#my-tasks-btn` — добавить `#agent-notify-btn`), чтобы Исполнитель её видел.

**style.css:** минимальные стили `.agent-notify-item{display:flex;gap:.6rem;padding:.6rem;border-radius:8px;cursor:pointer}`, `.agent-notify-item.unread{background:rgba(99,102,241,.08)}`, `.agent-notify-time{font-size:.75rem;opacity:.6}`, `.agent-notify-empty{opacity:.6;text-align:center;padding:1rem}`. Бамп `style.css?v=` (строки 20-21).

**Тест:** в `script.projects.test.js`-стиле не обязательно; минимум — весь JS-набор зелёный (vm-харнес ловит синтаксис). Commit `feat(client): agent notifications bell + feed`.

### Task 5: деплой этапа 1

1. Оба набора тестов зелёные.
2. Бамп cache-buster → push → дождаться на проде новой версии (`curl -s https://projectmanteko.vercel.app/index.html?nc=$RANDOM | grep -o "script.js?v=[0-9.]*"`).
3. `npx firebase deploy --only firestore:rules,firestore:indexes --project projectman-96d3c` (индекс строится минуты — дождаться в консоли/повторным deploy).
4. Смоук: колокольчик виден (в т.ч. под Исполнителем), лента пустая, консоль без ошибок листенера.

---

## Этап 2 — Серверный монитор сроков

### Task 6: чистая логика классификации — `lib/agent-monitor-core.js`

**Files:**
- Create: `lib/agent-monitor-core.js`
- Create: `lib/agent-monitor-core.test.js`

**Step 1: failing tests** — ключевые кейсы:

```js
import { describe, it, expect } from "vitest";
import { mskDateString, classifyTask, buildEventText } from "./agent-monitor-core.js";

const NOW = new Date("2026-07-03T09:00:00+03:00"); // 09:00 МСК

const base = { status: "in-progress", subStatus: "in_work", title: "T", deadline: "2026-07-01" };

describe("mskDateString", () => {
  it("формат YYYY-MM-DD в Europe/Moscow", () => {
    expect(mskDateString(new Date("2026-07-03T22:30:00Z"))).toBe("2026-07-04"); // 01:30 МСК следующего дня
    expect(mskDateString(new Date("2026-07-03T20:59:00Z"))).toBe("2026-07-03"); // 23:59 МСК
  });
});

describe("classifyTask", () => {
  it("просрочена: deadline < сегодня и сегодня ещё не слали", () => {
    expect(classifyTask({ ...base }, NOW).map(e => e.type)).toContain("overdue");
  });
  it("просрочена НЕ дублируется в тот же день (notifiedOverdueOn == today)", () => {
    expect(classifyTask({ ...base, notifiedOverdueOn: "2026-07-03" }, NOW)).toEqual([]);
  });
  it("просрочена ПОВТОРЯЕТСЯ на следующий день (флаг со вчерашней датой)", () => {
    expect(classifyTask({ ...base, notifiedOverdueOn: "2026-07-02" }, NOW).map(e => e.type)).toContain("overdue");
  });
  it("остался 1 день: deadline == завтра, один раз", () => {
    const t = { ...base, deadline: "2026-07-04" };
    expect(classifyTask(t, NOW).map(e => e.type)).toContain("deadline_tomorrow");
    expect(classifyTask({ ...t, notifiedDeadlineSoonAt: "x" }, NOW)).toEqual([]);
  });
  it("не взял в работу: assigned старше часа, один раз; моложе часа — нет", () => {
    const created = { toMillis: () => NOW.getTime() - 2 * 3600_000 };
    const t = { ...base, deadline: "2026-08-01", subStatus: "assigned", createdAt: created };
    expect(classifyTask(t, NOW).map(e => e.type)).toEqual(["not_taken_1h"]);
    expect(classifyTask({ ...t, notifiedNotTakenAt: "x" }, NOW)).toEqual([]);
    const fresh = { ...t, createdAt: { toMillis: () => NOW.getTime() - 10 * 60_000 } };
    expect(classifyTask(fresh, NOW)).toEqual([]);
  });
  it("на проверке (subStatus completed) просрочку/срок НЕ шлём; done/архив — ничего", () => {
    expect(classifyTask({ ...base, subStatus: "completed" }, NOW)).toEqual([]);
    expect(classifyTask({ ...base, status: "done" }, NOW)).toEqual([]);
  });
  it("кривой/отсутствующий deadline — только not_taken ветка, без падений", () => {
    expect(() => classifyTask({ ...base, deadline: "мусор" }, NOW)).not.toThrow();
  });
});
```

Плюс тест `buildEventText` — русские тексты трёх типов содержат название задачи/проект/срок.

**Step 3: implementation:**

```js
// Pure date/classification logic for the agent monitor. No Firestore, no LLM —
// unit-testable and deterministic. All "today/tomorrow" math is in
// Europe/Moscow explicitly: the org is Russian and the server runs in UTC, so
// using server-local dates would shift day boundaries by 3 hours.
const MSK = "Europe/Moscow";
const HOUR_MS = 60 * 60 * 1000;

export function mskDateString(date) {
  // en-CA locale formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: MSK }).format(date);
}

function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (typeof value === "object" && typeof value.seconds === "number") return value.seconds * 1000;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Task → list of due notification events for this run. The de-dup contract:
//   overdue           → repeats DAILY while overdue (notifiedOverdueOn = last sent MSK date)
//   deadline_tomorrow → once (notifiedDeadlineSoonAt)
//   not_taken_1h      → once (notifiedNotTakenAt), only while subStatus is 'assigned'
// Tasks waiting for approval (subStatus 'completed') are NOT nagged — the
// assignee already submitted; done/archived tasks are skipped entirely.
export function classifyTask(task, now) {
  const events = [];
  if (!task || task.status !== "in-progress") return events;

  const today = mskDateString(now);
  const tomorrow = mskDateString(new Date(now.getTime() + 24 * HOUR_MS));
  const deadline = typeof task.deadline === "string" && DATE_RE.test(task.deadline) ? task.deadline : null;
  const active = task.subStatus === "assigned" || task.subStatus === "in_work";

  if (deadline && active && deadline < today && task.notifiedOverdueOn !== today) {
    events.push({ type: "overdue" });
  }
  if (deadline && active && deadline === tomorrow && !task.notifiedDeadlineSoonAt) {
    events.push({ type: "deadline_tomorrow" });
  }
  const createdMs = toMillis(task.createdAt);
  if (task.subStatus === "assigned" && !task.notifiedNotTakenAt && createdMs !== null
      && now.getTime() - createdMs > HOUR_MS) {
    events.push({ type: "not_taken_1h" });
  }
  return events;
}

export function buildEventText(type, { title, projectName, deadline }) {
  const proj = projectName ? ` (проект «${projectName}»)` : "";
  if (type === "overdue") return `⚠️ Задача просрочена: «${title}»${proj}. Срок был ${deadline}.`;
  if (type === "deadline_tomorrow") return `⏰ Остался 1 день: «${title}»${proj}. Срок — ${deadline}.`;
  if (type === "not_taken_1h") return `❗️ Задача больше часа не взята в работу: «${title}»${proj}.`;
  return `🔔 «${title}»${proj}`;
}
```

**Step 4-5:** тесты зелёные, commit `feat(monitor): pure MSK date classification core`.

### Task 7: `api/agent-monitor.js`

**Files:**
- Create: `api/agent-monitor.js`
- Create: `api/agent-monitor.test.js`

Требования к хендлеру:
- Только POST (405 иначе). Авторизация: `CRON_SECRET` env ОБЯЗАТЕЛЕН и `request.headers.authorization === "Bearer " + CRON_SECRET`, иначе 401 (fail closed — Vercel Cron сам шлёт этот заголовок при заданном env; GH Actions шлёт вручную).
- Загрузка: `tasks where status=='in-progress'` (+ `.limit(2000)` — страховка), карта проектов по встреченным `projectId` (имена), карта пользователей по нужным uid (`assigneeIds`, `createdByUid`) — читать точечно `users/{uid}`, НЕ всю коллекцию.
- Для каждой задачи `classifyTask` → для каждого события: получатели = uniq(assigneeIds + createdByUid) (fallback: если `assigneeIds` пуст и есть `assigneeEmail` — как в award-xp, `where('email','==',...)`); каждому — doc в `agentNotifications` `{uid, organizationId: task.organizationId || project.organizationId || null, taskId, projectId, type, text, createdAt: FieldValue.serverTimestamp(), readAt: null}` + `sendTelegramMessage(user.telegramChatId, text)` (если привязан). Батч на задачу: notification-доки + флаги на задаче (`notifiedOverdueOn: today` / `notifiedDeadlineSoonAt: FieldValue.serverTimestamp()` / `notifiedNotTakenAt: ...`) — сначала `batch.commit()`, потом Telegram (чтобы сбой Telegram не ронял антиспам-флаги; и наоборот повтор не задвоит ленту).
- Ответ: `{ok:true, scanned:N, events:M}`; ошибки — 500 с логом, но частичный сбой одной задачи не валит остальные (try/catch на задачу).

**Тесты (`api/agent-monitor.test.js`, по образцу моков `api/agent-chat.test.js`):** 401 без/с неверным секретом и при НЕзаданном env; 405 на GET; happy-path с моком adminDb (2 задачи: одна просроченная с исполнителем+постановщиком с chatId → 2 notification-дока + 2 telegram + флаг на задаче; одна свежая → ничего). Мокать `lib/telegram-send.js` через `vi.mock`.

Commit `feat(api): agent-monitor endpoint — deadline sweep behind CRON_SECRET`.

### Task 8: расписания

**Files:**
- Modify: `vercel.json` — добавить на верхний уровень:

```json
  "crons": [
    { "path": "/api/agent-monitor", "schedule": "0 6 * * *" }
  ]
```

- Create: `.github/workflows/agent-monitor.yml`:

```yaml
name: agent-monitor-hourly
on:
  schedule:
    - cron: "5 * * * *"
  workflow_dispatch: {}

jobs:
  ping:
    runs-on: ubuntu-latest
    steps:
      - name: Call agent monitor
        run: |
          curl -sS -f -X POST "https://projectmanteko.vercel.app/api/agent-monitor" \
            -H "Authorization: Bearer ${{ secrets.CRON_SECRET }}"
```

(репозиторий ПУБЛИЧНЫЙ — секрет только в GitHub Secrets, `workflow_dispatch` даёт ручной смоук-запуск из UI GitHub.)

Commit `chore(schedule): vercel daily cron + GH Actions hourly for agent-monitor`.

### Task 9: отключить клиентские напоминания

**Files:**
- Modify: `script.js` — удалить вызов `checkReminders(tasks)` (строка ~1917) и функцию `checkReminders` (~5931, до конца её блока); проверить `grep -n "sendTelegramOverdueNotification\|sendTelegramReminderNotification\|sendTelegramNotTakenReminder"` — хелперы, которые звались ТОЛЬКО из checkReminders, удалить; на их месте краткий комментарий-указатель на api/agent-monitor.
- Бамп cache-buster.

Прогнать полный JS-набор (vm-харнес поймает битые ссылки). Commit `feat(monitor): retire client-side reminders — server monitor is the single source`.

### Task 10: деплой этапа 2 + действия пользователя

1. Тесты зелёные → push → дождаться версии на проде.
2. **ПОЛЬЗОВАТЕЛЬ (я секреты не трогаю):** сгенерировать длинную случайную строку `CRON_SECRET`; добавить в Vercel → Settings → Environment Variables (Production) под именем `CRON_SECRET`; добавить ту же строку в GitHub repo → Settings → Secrets and variables → Actions под именем `CRON_SECRET`. После добавления env в Vercel — redeploy (пустой коммит или из UI).
3. Смоук: пользователь запускает workflow вручную (GitHub → Actions → agent-monitor-hourly → Run workflow) на тестовой задаче со вчерашним дедлайном → проверить ленту (колокольчик) + Telegram у исполнителя и постановщика; повторный запуск в тот же день — дублей нет.
4. Проверить `curl -X POST .../api/agent-monitor` БЕЗ заголовка → 401.

---

## Этап 3 — Задачи из документа (двухфазный протокол)

### Task 11: чистые хелперы предложения задач — `lib/task-proposal.js`

**Files:**
- Create: `lib/task-proposal.js`
- Create: `lib/task-proposal.test.js`

Функции и контракты:

```js
// Extract a ```json {action:'propose_tasks', ...}``` block from an LLM answer.
// Returns { found: false } | { found: true, proposal } | { found: true, error }.
export function extractProposal(answerText) { /* regex по ```json ... ```, JSON.parse в try */ }

// Validate the raw LLM proposal: file is a non-empty string; tasks is a
// non-empty array (≤ 30); each task: title — non-empty string ≤ 200 chars,
// deadline — 'YYYY-MM-DD' or null, assigneeName — non-empty string.
// Returns { ok: true, tasks } | { ok: false, error }.
export function validateProposal(proposal) { ... }

// Match an assignee name against org users. Normalization: trim, lower,
// collapse spaces. Compares displayName, "firstName lastName" and
// "lastName firstName". Returns { uid, displayName } on EXACTLY one match;
// { error: 'not_found' } | { error: 'ambiguous' } otherwise.
export function matchAssignee(users, name) { ... }
```

Тесты: валидный блок парсится; текст без блока → found:false; битый JSON → error; >30 задач/пустой title/кривая дата → ok:false; матчинг: точное совпадение displayName, «Имя Фамилия» и «Фамилия Имя», регистронезависимо; два Ивана → ambiguous; нет → not_found.

Commit `feat(agent): task-proposal parsing/validation/assignee-matching helpers`.

### Task 12: фаза 1 (предпросмотр) в `api/agent-chat.js`

**Files:**
- Modify: `api/agent-chat.js`
- Modify: `api/agent-chat.test.js`

Изменения:
1. В `loadOrganizationContext` в `files.push` добавить `projectId: project.id` (нужно для привязки; НЕ включать projectId в текст промпта — id скрываем от LLM, матчим по filename).
2. В `SYSTEM_PROMPT_RULES` добавить правило: «Если пользователь просит сформировать/создать задачи из загруженного документа — верни ТОЛЬКО один блок \```json {"action":"propose_tasks","file":"<точное имя файла из данных>","tasks":[{"title":"...","deadline":"YYYY-MM-DD или null","assigneeName":"Имя Фамилия"}]}\``` без текста до и после. Название краткое и понятное; ответственного и срок бери из документа; если срока нет — null.»
3. После получения `answer` от OpenRouter: `extractProposal(answer)`. Если found:
   - `validateProposal`; файл искать в `context.files` по имени (без регистра; точное, иначе единственное вхождение подстроки) → `projectId`; не нашли → обычный ответ-текст «не нашёл такой документ…».
   - Участники: `db.collection('users').where('organizationId','==',organizationId).get()` → `matchAssignee` для каждой задачи → `tasks[i] = {title, deadline, assigneeName, assigneeUid|null, assigneeDisplay|null, ok, reason?}`.
   - Права вызывающего: посчитать `canCreate` — orgRole owner/admin, либо moderator с доступом к проекту (та же логика, что `callerCanManageProject` в `api/award-xp.js` — импортировать её оттуда: `import { callerCanManageProject } from "./award-xp.js"`).
   - Ответ: `{ ok: true, taskProposal: { file, projectId, projectName, tasks, canCreate } }` (без обычного `answer`).
4. Rate-limit и все существующие ветки не трогать.

Тесты: замокать OpenRouter-ответ с валидным propose_tasks-блоком → в ответе `taskProposal` с правильным матчингом (один найден, один not_found); ответ LLM без блока → обычное поведение (регрессия); битый JSON от LLM → обычный текстовый ответ с сообщением об ошибке разбора.

Commit `feat(agent): phase 1 — propose tasks from a project document (preview)`.

### Task 13: фаза 2 (создание) в `api/agent-chat.js`

**Files:**
- Modify: `api/agent-chat.js`
- Modify: `api/agent-chat.test.js`

В хендлере ПОСЛЕ auth и rate-limit, ДО загрузки контекста: если `body.action === 'create_tasks'`:
- Валидация body: `projectId` строка; `tasks` непустой массив ≤30; каждый `{title (непустой ≤200), deadline (YYYY-MM-DD|null), assigneeUid (строка)}`.
- Проект существует и `organizationId` совпадает с орг вызывающего; права: `callerCanManageProject(callerOrgRole, callerAllowedProjects, projectId)` — иначе 403.
- Каждый `assigneeUid` — существующий пользователь ТОЙ ЖЕ организации (точечные get); собрать display-имя как в клиенте (`firstName lastName` || email).
- Батч: `tasks.add` с полями РОВНО как в клиентском createTask: `{projectId, organizationId, title, description: 'Создано ИИ-агентом из документа «<file>»', assignee: <displayName>, assigneeEmail: user.email || '', assigneeIds: [assigneeUid], deadline, status: 'in-progress', subStatus: 'assigned', assigneeCompleted: false, attachments: [], createdAt: FieldValue.serverTimestamp(), createdBy: <имя вызывающего>, createdByEmail: <email вызывающего || ''>, createdByUid: decoded.uid}` + в тот же батч `agentNotifications` типа `tasks_created` исполнителю.
- После commit: Telegram каждому исполнителю с chatId (`🆕 Новая задача: «title». Срок: X. Проект: Y`).
- Ответ `{ ok: true, created: N }`.

Тесты: employee → 403; moderator без доступа к проекту → 403; happy-path owner → создано 2 задачи с точной формой полей (проверить snapshot полей), 2 notification-дока, telegram вызван для привязанных; кривой deadline → 400, ничего не создано.

Commit `feat(agent): phase 2 — confirmed task creation from proposal`.

### Task 14: карточка предпросмотра (клиент)

**Files:**
- Modify: `script.js` (обработка ответа agent-chat ~8138+, рендер ~8013-8130)
- Modify: `style.css` (карточка/таблица/кнопка)
- Modify: `index.html` (cache-buster)

Логика: в месте разбора успешного ответа (`data.answer` → `appendAgentChatMessage('agent', ...)`) добавить ветку `data.taskProposal` → `appendAgentTaskProposal(data.taskProposal)`:
- DOM через createElement: таблица (Название | Срок | Ответственный | Статус), строки ok → «✅ будет создана», иначе «⚠️ не будет: не найден пользователь / неоднозначно»;
- кнопка `Создать N задач` (N = ok-строки) видна только если `taskProposal.canCreate && N>0`; по клику: disable + POST `/api/agent-chat` `{action:'create_tasks', projectId, tasks: okRows.map(({title,deadline,assigneeUid})=>...)}` c Bearer-токеном (тот же паттерн fetch, что основной запрос) → по ответу `appendAgentChatMessage('agent', 'Создал N задач(и) в проекте «X». Исполнители получили уведомления.')`, кнопку скрыть;
- в `agentChatState.history` вместо карточки класть компактный текст `Предложены задачи из документа «file»: N к созданию, M пропущено` (чтобы история для LLM оставалась текстовой).

Тест: в `script.agent-chat.test.js` — рендер карточки из фикстуры proposal (правильное число строк/кнопка при canCreate=false скрыта). Бамп cache-buster. Commit `feat(client): task proposal card in agent chat`.

### Task 15: деплой этапа 3 + смоук

1. Оба набора тестов зелёные → push → версия на проде.
2. Правила/индексы не менялись — деплой Firebase не нужен.
3. Смоук (пользователь или совместно): загрузить в «Файлы проекта» документ с 2-3 задачами (ФИО существующего участника + сроки) → «сформируй задачи из документа X» → карточка → «Создать» → задачи в «Назначенные», Telegram у исполнителя, запись в колокольчике; проверить отказ под Исполнителем (кнопки нет, а прямой вызов create_tasks → 403).

---

## Definition of Done

- [ ] Все три этапа задеплоены (Vercel + rules/indexes), функций ≤ 11/12.
- [ ] JS-набор и rules-набор зелёные локально.
- [ ] Пользователь положил `CRON_SECRET` в Vercel env и GitHub Secrets; ручной запуск workflow отработал (лента + Telegram, без дублей при повторе).
- [ ] Клиентские напоминания удалены, дублей уведомлений нет.
- [ ] Смоук этапа 3 на реальном документе пройден.
- [ ] Память проекта обновлена (projectman-security-hardening-progress → добавить блок про монитор/ленту/создание задач; создать заметку о CRON_SECRET и GH workflow).
