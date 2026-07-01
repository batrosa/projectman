// Global AI agent chat endpoint: an org-wide assistant that reads ALL
// projects/tasks/uploaded-file-text for the caller's organization via the
// Admin SDK, deliberately bypassing the client-side `allowedProjects`
// restriction — "everyone in the org sees everything via the agent" is an
// explicit design decision from earlier in this plan, not an oversight.
import { adminDb, adminAuth } from "../lib/firebase-admin.js";
import { buildOpenRouterModels, openRouterModelBody, fetchWithTimeout } from "../lib/openrouter-config.js";

const CONTEXT_CHAR_LIMIT = 45000;
const MAX_HISTORY_TURNS = 8;
const MAX_MESSAGE_CHARS = 4000;

const SYSTEM_PROMPT_RULES = [
  "Ты — ИИ Руководитель проекта, ассистент внутри системы управления задачами.",
  "Отвечай коротко и по делу: 1-3 тезиса по умолчанию, простым не техническим языком.",
  "Ты знаешь все задачи, сроки и статусы всей организации, а не только открытый экран — не проси открыть раздел или выбрать проект, если данные уже есть ниже.",
  "Если факта нет в данных — прямо скажи, что этого пока нет в системе. Не выдумывай.",
  "Никогда не придумывай кнопки, разделы, статусы или функции, которых нет в приложении.",
  "Не говори «в предоставленном контексте» — говори «в данных проекта» или «в системе».",
  "Ты только отвечаешь на вопросы, данные не меняешь.",
].join(" ");

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const idToken = (request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!idToken) return response.status(401).json({ error: "Unauthorized" });

  let decoded;
  try {
    // verifyIdToken() (no second "checkRevoked" argument) validates the
    // signature against Google's public certs, the issuer/audience against
    // this project's Firebase project id, and expiry — called with defaults,
    // no options are passed that would weaken that validation.
    decoded = await adminAuth().verifyIdToken(idToken);
  } catch {
    return response.status(401).json({ error: "Unauthorized" });
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return response.status(400).json({ error: "Invalid JSON body" });
  }

  const message = String(body.message || "").trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) return response.status(400).json({ error: "message is required" });
  const history = normalizeHistory(body.history);

  const db = adminDb();
  let organizationId;
  try {
    const userDoc = await db.collection("users").doc(decoded.uid).get();
    organizationId = userDoc.exists ? userDoc.data().organizationId : null;
  } catch (error) {
    console.error("agent-chat: failed to load user doc", error);
    return response.status(200).json({ ok: true, answer: "Не удалось загрузить данные организации, попробуйте ещё раз." });
  }
  if (!organizationId) {
    return response.status(200).json({ ok: true, answer: "Вы пока не состоите ни в одной организации — агенту нечего показать." });
  }

  let context;
  try {
    context = await loadOrganizationContext(db, organizationId);
  } catch (error) {
    console.error("agent-chat: failed to load organization context", error);
    return response.status(200).json({ ok: true, answer: "Не удалось загрузить данные организации, попробуйте ещё раз." });
  }
  const contextText = compactContext(context);

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) {
    return response.status(200).json({ ok: true, answer: "ИИ-агент временно недоступен (не настроен OpenRouter)." });
  }

  const models = buildOpenRouterModels();
  const messages = [
    { role: "system", content: `${SYSTEM_PROMPT_RULES}\n\nДанные организации:\n${contextText}` },
    ...history,
    { role: "user", content: message },
  ];

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    try {
      const apiResponse = await fetchWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${openRouterKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ ...openRouterModelBody([model]), temperature: 0.2, max_tokens: 900, messages }),
      });

      if (!apiResponse.ok) {
        if (i === models.length - 1) break;
        continue;
      }

      const data = await apiResponse.json();
      const answer = cleanAnswer(data?.choices?.[0]?.message?.content);
      if (!answer) {
        if (i === models.length - 1) break;
        continue;
      }

      return response.status(200).json({ ok: true, answer, model });
    } catch {
      if (i === models.length - 1) break;
    }
  }

  return response.status(200).json({
    ok: true,
    answer: "Не удалось получить ответ от ИИ-агента, попробуйте ещё раз через минуту.",
    model: "fallback",
  });
}

async function loadOrganizationContext(db, organizationId) {
  // Single-field equality `where("organizationId", "==", ...)` on each
  // collection uses Firestore's automatic per-field index — composite
  // indexes are only required when a query combines multiple `where`
  // inequality/equality fields, or mixes `where` on one field with
  // `orderBy` on a different field. Neither query here does either, so no
  // entry in firestore.indexes.json is needed (the repo has no such file,
  // and firebase.json only references firestore.rules).
  const [projectsSnap, tasksSnap] = await Promise.all([
    db.collection("projects").where("organizationId", "==", organizationId).get(),
    db.collection("tasks").where("organizationId", "==", organizationId).get(),
  ]);

  const projects = projectsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const tasks = tasksSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));

  // Parallelized across projects (was a sequential for-await loop, serializing
  // N Firestore round-trips for N projects). Latency matters here: this
  // endpoint isn't listed in vercel.json's `functions` block (that only
  // configures api/webhook.js's maxDuration: 10), so it runs under Vercel's
  // platform-default function timeout rather than an explicit one — still a
  // real budget an org with many projects could exhaust serially.
  const filesSnaps = await Promise.all(
    projects.map((project) =>
      db
        .collection("projects").doc(project.id).collection("files")
        .where("extractionStatus", "==", "done")
        .get()
    )
  );

  const files = [];
  filesSnaps.forEach((filesSnap, index) => {
    const project = projects[index];
    filesSnap.docs.forEach((doc) => {
      const data = doc.data();
      if (data.extractedText) files.push({ projectId: project.id, filename: data.filename, extractedText: data.extractedText });
    });
  });

  return { projects, tasks, files };
}

// Budget split for CONTEXT_CHAR_LIMIT: 70% reserved for structured
// project/task JSON, 30% for appended file text.
//
// Reasoning: structured data (ids/titles/statuses/deadlines/assignees) is
// dense, high-value signal per character — it's exactly what lets the agent
// answer "what's overdue" or "who owns X" questions, and losing a task from
// it silently would make the agent factually wrong. File text is prose
// (extracted PDF/doc contents) that degrades gracefully when cut mid-sentence
// and is inherently supplementary. A large org (hundreds/thousands of tasks)
// will exhaust the structured budget before ever reaching the file-text
// budget, so 70/30 favors the side that actually breaks correctness when
// missing, while still guaranteeing some room for file context in the common
// (smaller-org) case where structured data doesn't come close to its cap.
const STRUCTURED_BUDGET_RATIO = 0.7;

function compactContext(context) {
  const structuredBudget = Math.floor(CONTEXT_CHAR_LIMIT * STRUCTURED_BUDGET_RATIO);
  const { structured, omittedTaskCount } = buildBoundedStructured(context, structuredBudget);

  // Truncation priority: structured project/task data is capped first (see
  // buildBoundedStructured), then whatever budget remains (CONTEXT_CHAR_LIMIT
  // minus the *actual* structured length, not the reserved budget — so a
  // small org that doesn't use its full structured allowance leaves more
  // room for file text) goes to file text, cut at the file boundary.
  let fileBudget = CONTEXT_CHAR_LIMIT - structured.length - 4; // 4 for the two newlines joining them
  const fileTexts = [];
  let filesTruncated = false;
  for (const f of context.files) {
    const chunk = `Файл "${f.filename}" (проект ${f.projectId}):\n${f.extractedText}`;
    if (fileBudget <= 0) {
      filesTruncated = true;
      break;
    }
    if (chunk.length > fileBudget) {
      fileTexts.push(chunk.slice(0, fileBudget));
      filesTruncated = true;
      fileBudget = 0;
      break;
    }
    fileTexts.push(chunk);
    fileBudget -= chunk.length + 2; // 2 for the "\n\n" join between chunks
  }

  let combined = `${structured}\n\n${fileTexts.join("\n\n")}`;
  const notices = [];
  if (omittedTaskCount > 0) {
    notices.push(`...[в контекст не поместилось ${omittedTaskCount} задач(и) — данные по ним не учтены]`);
  }
  if (filesTruncated) {
    notices.push("...[данные обрезаны по объёму — часть файлов могла не попасть в контекст]");
  }
  if (notices.length) combined += `\n${notices.join("\n")}`;
  return combined;
}

// Builds the structured projects+tasks JSON incrementally, sorted
// most-recently-created first (createdAt desc; tasks without a parseable
// createdAt sort last), stopping once adding the next task would exceed
// `budget`. This guarantees `structured` itself is bounded regardless of org
// size — the earlier version serialized the FULL task list unconditionally,
// which reached ~950KB in a 5,000-task synthetic org despite a 45,000-char
// CONTEXT_CHAR_LIMIT.
function buildBoundedStructured(context, budget) {
  const projects = context.projects.map((p) => ({ id: p.id, name: p.name }));
  const sortedTasks = [...context.tasks].sort((a, b) => taskRecency(b) - taskRecency(a));

  // Projects are always included whole: there are orders of magnitude fewer
  // projects than tasks in practice, and losing project names/ids would
  // break every task's projectId reference.
  //
  // Length is tracked incrementally (each task's own serialized length, plus
  // 1 char for the joining comma) rather than re-stringifying the whole
  // growing array on every iteration — the latter is O(n^2) and noticeably
  // slow for orgs with thousands of tasks.
  const skeleton = JSON.stringify({ projects, tasks: [] });
  // `{"projects":[...],"tasks":[]}` -> length before/after the empty "[]"
  // tells us exactly how many characters a non-empty tasks array adds:
  // one pair of brackets already counted in `skeleton`, plus a comma
  // between each task once there's more than one.
  let runningLength = skeleton.length;
  const includedTasks = [];
  let omittedTaskCount = 0;

  for (const t of sortedTasks) {
    const compact = {
      id: t.id, projectId: t.projectId, title: t.title, assignee: t.assignee,
      deadline: t.deadline, status: t.status, subStatus: t.subStatus,
    };
    const taskJson = JSON.stringify(compact);
    const addedLength = taskJson.length + (includedTasks.length > 0 ? 1 : 0); // +1 for comma separator
    if (runningLength + addedLength > budget && includedTasks.length > 0) {
      omittedTaskCount = sortedTasks.length - includedTasks.length;
      break;
    }
    includedTasks.push(compact);
    runningLength += addedLength;
    // Even a single task can't fit (pathological — shouldn't happen with
    // this schema, but avoid silently exceeding budget on the very first task).
    if (runningLength > budget && includedTasks.length === 1 && sortedTasks.length > 1) {
      omittedTaskCount = sortedTasks.length - 1;
      break;
    }
  }

  const structured = JSON.stringify({ projects, tasks: includedTasks });
  return { structured, omittedTaskCount };
}

// Extracts a millisecond timestamp from a task's createdAt for recency
// sorting. Handles Firestore Timestamp objects (`.toDate()`), ISO/date
// strings, and missing values — mirrors the tolerant parsing already used
// for this exact field in script.js. Unparseable/missing values sort last
// (treated as oldest) rather than throwing or defaulting to "now", so a task
// with bad data doesn't unfairly jump to the front of the kept set.
function taskRecency(task) {
  const raw = task && task.createdAt;
  if (!raw) return -Infinity;
  if (typeof raw.toDate === "function") {
    const d = raw.toDate();
    return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : -Infinity;
  }
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? -Infinity : d.getTime();
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  // Any role other than "assistant" collapses to "user" — this is a
  // deliberate allowlist, not just a default. It means a client-supplied
  // `{ role: "system", content: "..." }` turn is coerced to
  // `{ role: "user", ... }` before being spliced into the messages array,
  // so a caller cannot smuggle a second system-prompt-like message past our
  // own SYSTEM_PROMPT_RULES entry (which is always messages[0], added after
  // this history array is built — see handler()). The attacker-controlled
  // text still reaches the model, but only ever framed as a user turn.
  return history.slice(-MAX_HISTORY_TURNS).map((turn) => ({
    role: turn.role === "assistant" ? "assistant" : "user",
    content: String(turn.content || "").slice(0, 2000),
  }));
}

function cleanAnswer(text) {
  if (!text) return "";
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/в предоставленном контексте/gi, "в данных проекта")
    .trim();
}

async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") return JSON.parse(request.body || "{}");
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export { cleanAnswer, normalizeHistory, compactContext };
