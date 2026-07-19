// Pure helpers for the "create tasks from a document" agent flow
// (api/agent-chat, two-phase protocol). No Firestore, no LLM — unit-testable.
//
// Phase 1: the LLM is instructed to answer a "сформируй задачи из документа X"
// request with a single ```json {action:'propose_tasks', ...}``` block.
// extractProposal() pulls that block out of the raw answer, validateProposal()
// enforces the shape limits, matchAssignee() maps the human name from the
// document onto a real org member — EXACTLY one match or an explicit error
// (we never guess between two people).

// A structured spreadsheet import may legitimately contain a full roadmap.
// 100 rows stay well below Firestore's 500-write batch limit even when every
// assigned task also creates a notification. LLM prompts remain capped at 30
// because generating huge JSON is unreliable; larger imports use the
// deterministic table parser.
const MAX_TASKS = 100;
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 2000;
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
      tasks.push({ title: "", description: "", deadline: null, assigneeName: "", rowError: "no_title" });
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
    // Ответственный ОПЦИОНАЛЕН: пользователь вправе просить «без
    // ответственных» — такая задача создаётся как «Не назначен» (как и при
    // ручном создании без исполнителя).
    const assigneeName = typeof raw.assigneeName === "string" ? raw.assigneeName.trim() : "";
    // Deterministic spreadsheet imports mark names taken from the source.
    // Callers may safely downgrade an unknown source person to «Не назначен»,
    // while an explicit assignee typed by the user must still be an error.
    const assigneeFromSource = raw.assigneeFromSource === true;
    const rawDescription = typeof raw.description === "string" ? raw.description.trim() : "";
    // New agent proposals always ask the model for a grounded description.
    // Keep compatibility with older/fallback model responses, but never show
    // or create a proposal row with an empty description: the grounded title
    // is the safest non-fabricated fallback when the source has no details.
    const descriptionSource = rawDescription || title;
    const description = descriptionSource.length > MAX_DESCRIPTION_CHARS
      ? `${descriptionSource.slice(0, MAX_DESCRIPTION_CHARS - 1)}…`
      : descriptionSource;
    // Доп. постановщики (co-постановщики) — опциональный массив имён; они
    // получают уведомления постановщика и право принять/вернуть задачу.
    const coCreatorNames = Array.isArray(raw.coCreatorNames)
      ? raw.coCreatorNames
        .filter((name) => typeof name === "string" && name.trim())
        .map((name) => name.trim().slice(0, 120))
        .slice(0, 10)
      : [];
    tasks.push({ title, description, deadline, assigneeName, assigneeFromSource, coCreatorNames, ...(rowError ? { rowError } : {}) });
  }

  if (tasks.every((t) => t.rowError)) {
    return { ok: false, error: "ни одна строка из документа не распознана как задача (нужно хотя бы название)" };
  }
  return { ok: true, file, tasks, trimmed };
}

// Phase-2 payload from the client's "Создать N задач" button:
// Single-project:
// { action:'create_tasks', projectId, file?, tasks:[{title, deadline, assigneeUid}] }.
// Multi-project:
// { action:'create_tasks', projectId:'__all__', tasks:[{..., projectId}] }.
// Как и в phase-1 предложении, deadline ОПЦИОНАЛЕН: null/пусто — задача без
// дедлайна (ровно как при ручном создании); непустое значение обязано быть
// настоящей датой ГГГГ-ММ-ДД.
export function validateCreateTasksPayload(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "нет данных" };

  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  if (!projectId) return { ok: false, error: "не указан проект" };
  const multiProject = projectId === "__all__";
  if (!multiProject && !/^[A-Za-z0-9_-]{1,160}$/.test(projectId)) {
    return { ok: false, error: "некорректный проект" };
  }

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
    const rawDescription = typeof raw.description === "string" ? raw.description.trim() : "";
    if (rawDescription.length > MAX_DESCRIPTION_CHARS) {
      return { ok: false, error: `слишком длинное описание задачи «${title}»` };
    }
    // Срок ОПЦИОНАЛЕН (как при ручном создании): null/пусто — задача без
    // дедлайна; непустое значение обязано быть настоящей датой ГГГГ-ММ-ДД.
    const rawDeadline = typeof raw.deadline === "string" ? raw.deadline.trim() : "";
    let deadline = null;
    if (rawDeadline) {
      if (!isRealDate(rawDeadline)) {
        return { ok: false, error: `у задачи «${title}» некорректный срок (нужен ГГГГ-ММ-ДД или пусто)` };
      }
      deadline = rawDeadline;
    } else if (raw.deadline !== null && raw.deadline !== undefined && raw.deadline !== "") {
      return { ok: false, error: `у задачи «${title}» некорректный срок (нужен ГГГГ-ММ-ДД или пусто)` };
    }
    // Исполнитель ОПЦИОНАЛЕН: null/пусто — задача создаётся «Не назначен».
    const rawUid = typeof raw.assigneeUid === "string" ? raw.assigneeUid.trim() : "";
    if (!rawUid && raw.assigneeUid !== null && raw.assigneeUid !== undefined && raw.assigneeUid !== "") {
      return { ok: false, error: `некорректный исполнитель у задачи «${title}»` };
    }
    const taskProjectId = typeof raw.projectId === "string" ? raw.projectId.trim() : "";
    if (taskProjectId && !/^[A-Za-z0-9_-]{1,160}$/.test(taskProjectId)) {
      return { ok: false, error: `некорректный проект у задачи «${title}»` };
    }
    if (!multiProject && taskProjectId && taskProjectId !== projectId) {
      return { ok: false, error: `проект задачи «${title}» не совпадает с карточкой` };
    }
    // Доп. постановщики: опциональный массив uid участников организации.
    // Сервер (handleCreateTasks) проверит принадлежность к организации.
    let coCreatorUids = [];
    if (raw.coCreatorUids !== null && raw.coCreatorUids !== undefined) {
      if (!Array.isArray(raw.coCreatorUids) || raw.coCreatorUids.length > 10) {
        return { ok: false, error: `некорректные доп. постановщики у задачи «${title}»` };
      }
      for (const uid of raw.coCreatorUids) {
        if (typeof uid !== "string" || !/^[A-Za-z0-9_-]{1,160}$/.test(uid.trim())) {
          return { ok: false, error: `некорректные доп. постановщики у задачи «${title}»` };
        }
        coCreatorUids.push(uid.trim());
      }
      coCreatorUids = [...new Set(coCreatorUids)];
    }
    tasks.push({
      title,
      description: rawDescription,
      deadline,
      assigneeUid: rawUid || null,
      coCreatorUids,
      ...(multiProject ? { projectId: taskProjectId || null } : {}),
    });
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

function stripRussianCaseEnding(word) {
  const text = String(word || "");
  if (text.length <= 3) return text;
  for (const suffix of ["ому", "ему", "ого", "его", "ыми", "ими", "ым", "им", "ом", "ем", "ой", "ей", "ою", "ею", "у", "ю"]) {
    if (text.endsWith(suffix) && text.length - suffix.length >= 3) {
      return text.slice(0, -suffix.length);
    }
  }
  return text;
}

function looseNameKeys(value) {
  const normalized = normalizeName(value);
  if (!normalized) return new Set();
  const stripped = normalized.split(" ").map(stripRussianCaseEnding).join(" ");
  return new Set([
    normalized,
    stripped,
    normalized.replace(/\s+/g, ""),
    stripped.replace(/\s+/g, ""),
  ].filter(Boolean));
}

function editDistanceWithinOne(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  if (left === right) return true;
  if (left.length < 6 || right.length < 6) return false;
  if (Math.abs(left.length - right.length) > 1) return false;

  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i += 1;
      j += 1;
      continue;
    }
    edits += 1;
    if (edits > 1) return false;
    if (left.length > right.length) i += 1;
    else if (right.length > left.length) j += 1;
    else {
      i += 1;
      j += 1;
    }
  }
  if (i < left.length || j < right.length) edits += 1;
  return edits <= 1;
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

  if (hits.length === 0) {
    const targetLoose = looseNameKeys(name);
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
      const matched = [...variants].some((variant) => {
        const keys = looseNameKeys(variant);
        return [...keys].some((key) => targetLoose.has(key));
      });
      if (matched) hits.push(user);
    }
  }

  if (hits.length === 0) {
    const targetLoose = [...looseNameKeys(name)].filter((key) => key && !key.includes(" "));
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
      const candidateLoose = [...variants]
        .flatMap((variant) => [...looseNameKeys(variant)])
        .filter((key) => key && !key.includes(" "));
      const matched = targetLoose.some((targetKey) =>
        candidateLoose.some((candidateKey) => editDistanceWithinOne(targetKey, candidateKey))
      );
      if (matched) hits.push(user);
    }
  }

  if (hits.length === 0) return { error: "not_found" };
  if (hits.length > 1) return { error: "ambiguous" };
  const user = hits[0];
  const display = user.displayName
    || `${user.firstName || ""} ${user.lastName || ""}`.trim()
    || user.id;
  return { uid: user.id, displayName: display };
}
