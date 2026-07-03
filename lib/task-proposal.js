// Pure helpers for the "create tasks from a document" agent flow
// (api/agent-chat, two-phase protocol). No Firestore, no LLM — unit-testable.
//
// Phase 1: the LLM is instructed to answer a "сформируй задачи из документа X"
// request with a single ```json {action:'propose_tasks', ...}``` block.
// extractProposal() pulls that block out of the raw answer, validateProposal()
// enforces the shape limits, matchAssignee() maps the human name from the
// document onto a real org member — EXACTLY one match or an explicit error
// (we never guess between two people).

const MAX_TASKS = 30;
const MAX_TITLE_CHARS = 200;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ```json ... ``` block (first one), case-insensitive fence tag.
const JSON_BLOCK_RE = /```json\s*([\s\S]*?)```/i;

// { found:false } — no propose_tasks block, treat the answer as normal chat.
// { found:true, proposal } — parsed OK.
// { found:true, error } — it IS our block but the JSON is broken.
export function extractProposal(answerText) {
  if (!answerText || typeof answerText !== "string") return { found: false };
  const match = answerText.match(JSON_BLOCK_RE);
  if (!match) return { found: false };

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch (error) {
    // Only claim the block if it LOOKS like our contract — a broken JSON blob
    // that never mentions propose_tasks is just a weird code block.
    if (/propose_tasks/.test(match[1])) {
      return { found: true, error: "invalid JSON in propose_tasks block" };
    }
    return { found: false };
  }
  if (!parsed || parsed.action !== "propose_tasks") return { found: false };
  return { found: true, proposal: parsed };
}

function isRealDate(str) {
  if (!DATE_RE.test(str)) return false;
  const [y, m, d] = str.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// { ok:true, file, tasks:[{title, deadline|null, assigneeName}] } | { ok:false, error }
export function validateProposal(proposal) {
  if (!proposal || typeof proposal !== "object") return { ok: false, error: "нет данных" };

  const file = typeof proposal.file === "string" ? proposal.file.trim() : "";
  if (!file) return { ok: false, error: "не указан файл" };

  if (!Array.isArray(proposal.tasks) || proposal.tasks.length === 0) {
    return { ok: false, error: "список задач пуст" };
  }
  if (proposal.tasks.length > MAX_TASKS) {
    return { ok: false, error: `слишком много задач (>${MAX_TASKS})` };
  }

  const tasks = [];
  for (const raw of proposal.tasks) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "битая запись задачи" };
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title || title.length > MAX_TITLE_CHARS) {
      return { ok: false, error: "пустое или слишком длинное название задачи" };
    }
    let deadline = null;
    if (raw.deadline !== null && raw.deadline !== undefined && raw.deadline !== "") {
      if (typeof raw.deadline !== "string" || !isRealDate(raw.deadline.trim())) {
        return { ok: false, error: `некорректный срок у задачи «${title}» (нужен ГГГГ-ММ-ДД)` };
      }
      deadline = raw.deadline.trim();
    }
    const assigneeName = typeof raw.assigneeName === "string" ? raw.assigneeName.trim() : "";
    if (!assigneeName) return { ok: false, error: `не указан ответственный у задачи «${title}»` };
    tasks.push({ title, deadline, assigneeName });
  }
  return { ok: true, file, tasks };
}

// Phase-2 payload from the client's "Создать N задач" button:
// { action:'create_tasks', projectId, file?, tasks:[{title, deadline, assigneeUid}] }.
// Unlike the phase-1 proposal, deadline is REQUIRED here: a task document with
// no deadline renders badly on the board and is useless to the deadline
// monitor — the preview marks such rows as not-creatable instead.
export function validateCreateTasksPayload(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "нет данных" };

  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  if (!projectId) return { ok: false, error: "не указан проект" };

  const file = typeof body.file === "string" ? body.file.trim().slice(0, 200) : "";

  if (!Array.isArray(body.tasks) || body.tasks.length === 0) {
    return { ok: false, error: "список задач пуст" };
  }
  if (body.tasks.length > MAX_TASKS) {
    return { ok: false, error: `слишком много задач (>${MAX_TASKS})` };
  }

  const tasks = [];
  for (const raw of body.tasks) {
    if (!raw || typeof raw !== "object") return { ok: false, error: "битая запись задачи" };
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title || title.length > MAX_TITLE_CHARS) {
      return { ok: false, error: "пустое или слишком длинное название задачи" };
    }
    const deadline = typeof raw.deadline === "string" ? raw.deadline.trim() : "";
    if (!isRealDate(deadline)) {
      return { ok: false, error: `у задачи «${title}» нет корректного срока (ГГГГ-ММ-ДД)` };
    }
    const assigneeUid = typeof raw.assigneeUid === "string" ? raw.assigneeUid.trim() : "";
    if (!assigneeUid) return { ok: false, error: `не указан исполнитель у задачи «${title}»` };
    tasks.push({ title, deadline, assigneeUid });
  }
  return { ok: true, projectId, file, tasks };
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// users: [{id, displayName?, firstName?, lastName?}]
// → { uid, displayName } on EXACTLY one match
// → { error: 'not_found' | 'ambiguous' } otherwise
export function matchAssignee(users, name) {
  const target = normalizeName(name);
  if (!target || !Array.isArray(users)) return { error: "not_found" };

  const hits = [];
  for (const user of users) {
    if (!user || !user.id) continue;
    const variants = new Set();
    if (user.displayName) variants.add(normalizeName(user.displayName));
    const first = normalizeName(user.firstName);
    const last = normalizeName(user.lastName);
    if (first && last) {
      variants.add(`${first} ${last}`);
      variants.add(`${last} ${first}`);
    }
    variants.delete("");
    if (variants.has(target)) hits.push(user);
  }

  if (hits.length === 0) return { error: "not_found" };
  if (hits.length > 1) return { error: "ambiguous" };
  const user = hits[0];
  const display = user.displayName
    || `${user.firstName || ""} ${user.lastName || ""}`.trim()
    || user.id;
  return { uid: user.id, displayName: display };
}
