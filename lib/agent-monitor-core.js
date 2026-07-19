// Pure date/classification logic for the agent monitor (api/agent-monitor).
// No Firestore, no LLM — unit-testable and deterministic. All today/tomorrow
// math is done in Europe/Moscow explicitly: the org is Russian and the server
// runs in UTC, so server-local dates would shift day boundaries by 3 hours.
const MSK = "Europe/Moscow";
const HOUR_MS = 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
import { formatIsoDayRu } from "./date-display.js";

// en-CA locale formats dates as YYYY-MM-DD.
export function mskDateString(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: MSK }).format(date);
}

function mskHour(date) {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: MSK,
    hour: "2-digit",
    hour12: false,
  }).format(date);
  return Number(hour);
}

function isDeadlineNotificationWindow(date) {
  const hour = mskHour(date);
  return Number.isFinite(hour) && hour >= 9 && hour < 21;
}

function isEveningDeadlineWindow(date) {
  const hour = mskHour(date);
  return Number.isFinite(hour) && hour >= 18 && hour < 21;
}

function isMorningDeadlineWindow(date) {
  const hour = mskHour(date);
  return Number.isFinite(hour) && hour >= 9 && hour < 12;
}

function toMillis(value) {
  if (!value) return null;
  if (typeof value.toMillis === "function") return value.toMillis();
  if (typeof value.toDate === "function") return value.toDate().getTime();
  if (typeof value === "object" && typeof value.seconds === "number") return value.seconds * 1000;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

// Task → list of due notification events for this monitor run.
// De-dup contract (flags live on the task, written only by the server):
//   overdue           — repeats DAILY while overdue (notifiedOverdueOn = MSK
//                       date of the last send; a new day re-fires it);
//   deadline_today    — repeats DAILY in the 9:00–12:00 MSK morning window
//                       while deadline == today (notifiedDeadlineTodayOn);
//                       also catches tasks whose «tomorrow» deadline was set
//                       after the evening window closed;
//   deadline_tomorrow — once (notifiedDeadlineSoonAt);
//   not_taken_1h      — once (notifiedNotTakenAt), only while 'assigned'.
// Tasks submitted for review (subStatus 'completed') are NOT nagged about
// deadlines — the assignee already did their part; done/archived tasks are
// skipped entirely.
export function classifyTask(task, now) {
  const events = [];
  if (!task || task.status !== "in-progress") return events;

  const today = mskDateString(now);
  const tomorrow = mskDateString(new Date(now.getTime() + 24 * HOUR_MS));
  const deadline = typeof task.deadline === "string" && DATE_RE.test(task.deadline) ? task.deadline : null;
  const subStatus = task.subStatus || "assigned";
  const active = subStatus === "assigned" || subStatus === "in_work";
  const assigned = hasAssignee(task);
  const deadlineWindow = isDeadlineNotificationWindow(now);
  const morningDeadlineWindow = isMorningDeadlineWindow(now);
  const eveningDeadlineWindow = isEveningDeadlineWindow(now);

  if (deadlineWindow && deadline && active && deadline < today && task.notifiedOverdueOn !== today) {
    events.push({ type: "overdue" });
  }
  if (morningDeadlineWindow && deadline && active && deadline === today && task.notifiedDeadlineTodayOn !== today) {
    events.push({ type: "deadline_today" });
  }
  if (eveningDeadlineWindow && assigned && deadline && active && deadline === tomorrow && !task.notifiedDeadlineSoonAt) {
    events.push({ type: "deadline_tomorrow" });
  }
  const assignedMs = toMillis(task.assignedAt) ?? toMillis(task.createdAt);
  if (
    deadlineWindow
    && subStatus === "assigned"
    && !assigned
    && !task.notifiedUnassignedAt
    && assignedMs !== null
    && now.getTime() - assignedMs > HOUR_MS
  ) {
    events.push({ type: "unassigned_1h" });
  }
  if (
    deadlineWindow
    && subStatus === "assigned"
    && assigned
    && !task.notifiedNotTakenAt
    && assignedMs !== null
    && now.getTime() - assignedMs > HOUR_MS
  ) {
    events.push({ type: "not_taken_1h" });
  }
  return events;
}

function hasAssignee(task) {
  if (Array.isArray(task.assigneeIds) && task.assigneeIds.filter(Boolean).length > 0) return true;
  if (String(task.assigneeEmail || "").trim()) return true;
  const assignee = String(task.assignee || "").trim().toLowerCase();
  return Boolean(assignee && assignee !== "не назначен");
}

// Russian plural: pluralRu(1..) → "день", (2..4) → "дня", (5..) → "дней".
export function pluralRu(n, one, few, many) {
  const mod100 = Math.abs(n) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

// Whole days between two YYYY-MM-DD dates; null when either is malformed.
function daysBetween(fromIso, toIso) {
  if (!DATE_RE.test(fromIso || "") || !DATE_RE.test(toIso || "")) return null;
  const [fy, fm, fd] = fromIso.split("-").map(Number);
  const [ty, tm, td] = toIso.split("-").map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / (24 * HOUR_MS));
}

// Human text for one event, in Russian — goes verbatim into the in-app feed
// and the Telegram message.
export function buildEventText(type, { title, projectName, deadline, assigneeNames, today }) {
  const proj = projectName ? ` (проект «${projectName}»)` : "";
  const assignees = formatAssignees(assigneeNames);
  const agent = "🤖 ИИ-агент: ";
  if (type === "overdue") {
    const age = daysBetween(deadline, today);
    const ageText = age !== null && age > 0 ? ` Просрочена на ${age} ${pluralRu(age, "день", "дня", "дней")}.` : "";
    return `${agent}⚠️ Задача просрочена: «${title}»${proj}.${assignees} Срок был ${formatIsoDayRu(deadline)}.${ageText}`;
  }
  if (type === "deadline_today") {
    return `${agent}⏰ Срок сегодня: задача «${title}»${proj}.${assignees} Срок — ${formatIsoDayRu(deadline)}.`;
  }
  if (type === "deadline_tomorrow") {
    return `${agent}⏰ До срока задачи «${title}»${proj} остался 1 день.${assignees} Срок — ${formatIsoDayRu(deadline)}.`;
  }
  if (type === "not_taken_1h") {
    return `${agent}❗️ Задача больше часа не взята в работу: «${title}»${proj}.${assignees}`;
  }
  if (type === "unassigned_1h") {
    return `${agent}👤 У задачи «${title}»${proj} больше часа нет ответственного.`;
  }
  return `${agent}🔔 «${title}»${proj}.${assignees}`.trim();
}

// One digest line replacing a burst of same-type Telegram/push messages for a
// single recipient (the in-app feed stays one entry per task for deep-links).
const DIGEST_TYPE_LABELS = {
  overdue: (n) => pluralRu(n, "просрочена", "просрочены", "просрочены"),
  deadline_today: () => "с дедлайном сегодня",
  deadline_tomorrow: () => "с дедлайном завтра",
  not_taken_1h: (n) => pluralRu(n, "не взята в работу", "не взяты в работу", "не взяты в работу"),
  unassigned_1h: () => "без ответственного",
};

export function buildDigestText(type, { count, titles }) {
  const n = Number(count) || 0;
  const noun = pluralRu(n, "задача", "задачи", "задач");
  const label = (DIGEST_TYPE_LABELS[type] || (() => "требуют внимания"))(n);
  const shown = (Array.isArray(titles) ? titles : [])
    .map((t) => String(t || "").trim())
    .filter(Boolean)
    .slice(0, 3);
  if (shown.length === 0) return `📋 ИИ-агент: ${n} ${noun} ${label}.`;
  const rest = n - shown.length > 0 ? ` и ещё ${n - shown.length}` : "";
  return `📋 ИИ-агент: ${n} ${noun} ${label}: ${shown.map((t) => `«${t}»`).join(", ")}${rest}.`;
}

function formatAssignees(assigneeNames) {
  const names = (Array.isArray(assigneeNames) ? assigneeNames : [assigneeNames])
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  if (names.length === 0) return "";
  return ` ${names.length > 1 ? "Ответственные" : "Ответственный"}: ${names.join(", ")}.`;
}
