// Pure date/classification logic for the agent monitor (api/agent-monitor).
// No Firestore, no LLM — unit-testable and deterministic. All today/tomorrow
// math is done in Europe/Moscow explicitly: the org is Russian and the server
// runs in UTC, so server-local dates would shift day boundaries by 3 hours.
const MSK = "Europe/Moscow";
const HOUR_MS = 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// en-CA locale formats dates as YYYY-MM-DD.
export function mskDateString(date) {
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

// Task → list of due notification events for this monitor run.
// De-dup contract (flags live on the task, written only by the server):
//   overdue           — repeats DAILY while overdue (notifiedOverdueOn = MSK
//                       date of the last send; a new day re-fires it);
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
  const active = task.subStatus === "assigned" || task.subStatus === "in_work";

  if (deadline && active && deadline < today && task.notifiedOverdueOn !== today) {
    events.push({ type: "overdue" });
  }
  if (deadline && active && deadline === tomorrow && !task.notifiedDeadlineSoonAt) {
    events.push({ type: "deadline_tomorrow" });
  }
  const createdMs = toMillis(task.createdAt);
  if (
    task.subStatus === "assigned"
    && !task.notifiedNotTakenAt
    && createdMs !== null
    && now.getTime() - createdMs > HOUR_MS
  ) {
    events.push({ type: "not_taken_1h" });
  }
  return events;
}

// Human text for one event, in Russian — goes verbatim into the in-app feed
// and the Telegram message.
export function buildEventText(type, { title, projectName, deadline, assigneeNames }) {
  const proj = projectName ? ` (проект «${projectName}»)` : "";
  const assignees = formatAssignees(assigneeNames);
  if (type === "overdue") {
    return `⚠️ Задача просрочена: «${title}»${proj}.${assignees} Срок был ${deadline}.`;
  }
  if (type === "deadline_tomorrow") {
    return `⏰ Остался 1 день: «${title}»${proj}.${assignees} Срок — ${deadline}.`;
  }
  if (type === "not_taken_1h") {
    return `❗️ Задача больше часа не взята в работу: «${title}»${proj}.${assignees}`;
  }
  return `🔔 «${title}»${proj}.${assignees}`.trim();
}

function formatAssignees(assigneeNames) {
  const names = (Array.isArray(assigneeNames) ? assigneeNames : [assigneeNames])
    .map((name) => String(name || "").trim())
    .filter(Boolean);
  if (names.length === 0) return "";
  return ` ${names.length > 1 ? "Ответственные" : "Ответственный"}: ${names.join(", ")}.`;
}
