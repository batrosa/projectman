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

// { found:false } — no propose_tasks payload, treat the answer as normal chat.
// { found:true, proposal } — parsed OK.
// { found:true, error } — it IS our payload but the JSON is broken.
//
// The LLM is ASKED to wrap the payload in a ```json fence, but real models
// vary (prod case: a fence WITHOUT the json tag rendered as a raw code bubble
// in the chat). Accept three shapes — ```json fence, bare ``` fence, and
// fence-less bare JSON — the strict `action` check is the real gate.
export function extractProposal(answerText) {
  if (!answerText || typeof answerText !== "string") return { found: false };
  if (!answerText.includes("propose_tasks")) return { found: false };

  const candidates = [];
  const fence = answerText.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1].trim()) candidates.push(fence[1]);
  const start = answerText.indexOf("{");
  const end = answerText.lastIndexOf("}");
  if (start >= 0 && end > start) candidates.push(answerText.slice(start, end + 1));

  if (candidates.length === 0) {
    // Mentions propose_tasks but there is no JSON object shape at all — the
    // payload was cut before any '}' arrived.
    return { found: true, error: "invalid JSON in propose_tasks block" };
  }

  let sawBroken = false;
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && parsed.action === "propose_tasks") {
        return { found: true, proposal: parsed };
      }
      // Parsed fine but a different action — keep trying the other shape.
    } catch {
      sawBroken = true;
    }
  }
  if (sawBroken) {
    for (const candidate of candidates) {
      const salvaged = salvageTruncatedProposal(candidate);
      if (salvaged) return { found: true, proposal: salvaged, truncated: true };
    }
    return { found: true, error: "invalid JSON in propose_tasks block" };
  }
  return { found: false };
}

// max_tokens can cut the model off MID-JSON on a big document (prod case: a
// long roadmap xlsx). Recover the COMPLETE task objects from the truncated
// payload: walk back over '}' positions and try to close the tasks array and
// the root object; the partial trailing task is dropped, nothing is invented.
function salvageTruncatedProposal(candidate) {
  if (typeof candidate !== "string" || !candidate.includes('"tasks"')) return null;
  let idx = candidate.length;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    idx = candidate.lastIndexOf("}", idx - 1);
    if (idx <= 0) return null;
    const base = candidate.slice(0, idx + 1);
    for (const tail of ["]}", "}]}"]) {
      try {
        const parsed = JSON.parse(base + tail);
        if (parsed && parsed.action === "propose_tasks"
            && Array.isArray(parsed.tasks) && parsed.tasks.length > 0) {
          return parsed;
        }
      } catch {
        // keep walking back to the previous '}'
      }
    }
  }
  return null;
}

function isRealDate(str) {
  if (!DATE_RE.test(str)) return false;
  const [y, m, d] = str.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

// { ok:true, file, tasks, trimmed } | { ok:false, error }
//
// PER-ROW leniency: real documents are messy — one row with a missing title or
// a garbled date must NOT kill the whole proposal (prod case: «пустое или
// слишком длинное название» rejected everything). Structural problems (no
// file, no tasks at all, every row broken) still fail the proposal; row-level
// problems become task.rowError so the preview shows WHY that row won't be
// created while the good rows stay creatable. Over-long titles are clamped
// (visible in the preview), an over-long list is trimmed to MAX_TASKS.
export function validateProposal(proposal) {
  if (!proposal || typeof proposal !== "object") return { ok: false, error: "нет данных" };

  const file = typeof proposal.file === "string" ? proposal.file.trim() : "";
  if (!file) return { ok: false, error: "не указан файл" };

  if (!Array.isArray(proposal.tasks) || proposal.tasks.length === 0) {
    return { ok: false, error: "список задач пуст" };
  }

  const trimmed = proposal.tasks.length > MAX_TASKS;
  const source = proposal.tasks.slice(0, MAX_TASKS);

  const tasks = [];
  for (const raw of source) {
    if (!raw || typeof raw !== "object") {
      tasks.push({ title: "", deadline: null, assigneeName: "", rowError: "no_title" });
      continue;
    }
    let rowError = null;
    let title = typeof raw.title === "string" ? raw.title.trim() : "";
    if (!title) {
      rowError = "no_title";
    } else if (title.length > MAX_TITLE_CHARS) {
      title = `${title.slice(0, MAX_TITLE_CHARS - 1)}…`;
    }
    let deadline = null;
    if (raw.deadline !== null && raw.deadline !== undefined && raw.deadline !== "") {
      if (typeof raw.deadline === "string" && isRealDate(raw.deadline.trim())) {
        deadline = raw.deadline.trim();
      } else if (!rowError) {
        rowError = "bad_deadline";
      }
    }
    const assigneeName = typeof raw.assigneeName === "string" ? raw.assigneeName.trim() : "";
    if (!assigneeName && !rowError) rowError = "no_assignee";
    tasks.push({ title, deadline, assigneeName, ...(rowError ? { rowError } : {}) });
  }

  if (tasks.every((t) => t.rowError)) {
    return { ok: false, error: "ни одна строка из документа не распознана как задача (нужны название, ответственный и срок)" };
  }
  return { ok: true, file, tasks, trimmed };
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

// Filenames from the LLM are re-typed from the prompt, not copied — prod case:
// «Елисеевский_парк_…» came back as «Елисеевский парк_…» (underscore → space).
// Normalize underscores/whitespace/NBSP to single spaces before comparing.
function normalizeFilename(value) {
  return String(value || "").toLowerCase().replace(/[\s _]+/g, " ").trim();
}

// files: [{filename, ...}] → { file } | { error: 'not_found' | 'ambiguous' }.
// Match order: normalized exact → normalized substring (both directions) →
// single-document fallback (the model garbled the name, but there is only one
// document in scope, so there is nothing to confuse it with).
export function matchProposalFile(files, wantedName) {
  const list = Array.isArray(files) ? files.filter((f) => f && f.filename) : [];
  const wanted = normalizeFilename(wantedName);
  if (!wanted || list.length === 0) return { error: "not_found" };

  let hits = list.filter((f) => normalizeFilename(f.filename) === wanted);
  if (hits.length === 0) {
    hits = list.filter((f) => {
      const name = normalizeFilename(f.filename);
      return name.includes(wanted) || wanted.includes(name);
    });
  }
  if (hits.length === 1) return { file: hits[0] };
  if (hits.length > 1) return { error: "ambiguous" };
  if (list.length === 1) return { file: list[0] };
  return { error: "not_found" };
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
