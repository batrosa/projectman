// One-off "create tasks from an attached file" endpoint for the AI agent chat.
// The file is sent in the request body, parsed in memory, and is NOT stored in
// project files / Cloudinary / Firestore. Project Files remain a persistent
// knowledge base for answers; task creation uses this transient path only.
import { adminDb, adminAuth } from "../lib/firebase-admin.js";
import { extractMaterialText } from "../lib/material-parser.js";
import { buildOpenRouterModels, openRouterModelBody, fetchJsonWithTimeout } from "../lib/openrouter-config.js";
import { extractProposal, validateProposal, matchAssignee } from "../lib/task-proposal.js";
import { callerCanManageProject } from "./award-xp.js";

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 3 * 1024 * 1024;
const MAX_MESSAGE_CHARS = 2000;
const MAX_EXTRACTED_CHARS = 70000;
const ALLOWED_EXTENSIONS = new Set(["md", "xlsx", "xlsm", "pdf", "docx"]);
const NO_ACCESS_SENTINEL = "__no_access__";

const TASK_FILE_SYSTEM_PROMPT = [
  "Ты извлекаешь задачи из разового файла, прикрепленного в чате HoldingMan.",
  "Верни РОВНО ОДИН JSON-блок без текста до и после: ```json {\"action\":\"propose_tasks\",\"file\":\"<имя файла>\",\"tasks\":[{\"title\":\"...\",\"deadline\":\"ГГГГ-ММ-ДД или null\",\"assigneeName\":\"Имя Фамилия\"}],\"hasMore\":false} ```.",
  "В блоке не больше 30 задач. Иди по порядку документа.",
  "Если задач больше 30, верни первые 30 и поставь hasMore=true. Если пользователь просит N первых задач — верни ровно первые N (и hasMore=true, если в файле их больше).",
  "tasks=[] возвращай ТОЛЬКО если в файле вообще нет списка работ/задач. Отсутствие ответственных или сроков — НЕ причина возвращать пустой список.",
  "Название задачи делай кратким, без номера строки, но не выдумывай задачи, которых нет в файле.",
  "Ответственного и срок бери из файла. Если пользователь явно написал общего ответственного или общий срок, используй эти значения для всех задач вместо файла.",
  "Если ответственного нет в файле, или пользователь просит «без ответственных» — assigneeName=\"\" (пустая строка): задача создастся как «Не назначен».",
  "Если срока нет ни в файле, ни в запросе пользователя, или пользователь просит «без сроков» — deadline=null.",
  "Не показывай технические id.",
].join(" ");

export function validateAgentTaskFilePayload(body) {
  if (!body || typeof body !== "object") return { ok: false, error: "нет данных" };
  const message = String(body.message || "").trim().slice(0, MAX_MESSAGE_CHARS);
  const projectId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  const projectName = typeof body.projectName === "string" ? body.projectName.trim().slice(0, 240) : "";
  const file = body.file && typeof body.file === "object" ? body.file : null;
  if (!file) return { ok: false, error: "прикрепите файл" };

  const filename = typeof file.filename === "string" ? file.filename.trim().slice(0, 240) : "";
  if (!filename) return { ok: false, error: "у файла нет имени" };
  const ext = extensionOf(filename);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return { ok: false, error: "поддерживаются только md, xlsx, xlsm, pdf и docx" };
  }

  const declaredSize = Number(file.sizeBytes);
  if (Number.isFinite(declaredSize) && (declaredSize < 0 || declaredSize > MAX_FILE_BYTES)) {
    return { ok: false, error: "файл больше 3 МБ" };
  }

  const base64 = stripDataUrlPrefix(String(file.base64 || ""));
  if (!base64) return { ok: false, error: "файл пустой" };
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) return { ok: false, error: "файл пустой" };
  if (buffer.byteLength > MAX_FILE_BYTES) return { ok: false, error: "файл больше 3 МБ" };

  return {
    ok: true,
    message,
    projectId,
    projectName,
    file: {
      filename,
      mimeType: typeof file.mimeType === "string" ? file.mimeType.slice(0, 160) : "",
      sizeBytes: Number.isFinite(declaredSize) ? declaredSize : buffer.byteLength,
      base64: buffer.toString("base64"),
    },
  };
}

export function resolveProjectFromMessage(projects, message) {
  const text = normalizeLookup(message);
  if (!text) return { error: "not_found" };
  const list = Array.isArray(projects) ? projects : [];
  const exactHits = list.filter((project) => normalizeLookup(project?.name) === text);
  if (exactHits.length === 1) return { project: exactHits[0] };
  if (exactHits.length > 1) return { error: "ambiguous" };

  const hits = list.filter((project) => {
    const name = normalizeLookup(project?.name);
    if (!name) return false;
    if (text.includes(name)) return true;
    const words = name.split(" ").filter((word) => word.length >= 4);
    return words.some((word) => text.includes(word));
  });
  if (hits.length === 1) return { project: hits[0] };
  if (hits.length > 1) return { error: "ambiguous" };
  return { error: "not_found" };
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const idToken = (request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!idToken) return response.status(401).json({ error: "Unauthorized" });

  let decoded;
  try {
    decoded = await adminAuth().verifyIdToken(idToken);
  } catch {
    return response.status(401).json({ error: "Unauthorized" });
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return response.status(400).json({ error: "Invalid JSON body" });
  }

  const payload = validateAgentTaskFilePayload(body);
  if (!payload.ok) return response.status(400).json({ error: payload.error });

  const db = adminDb();
  let callerData = null;
  try {
    const userDoc = await db.collection("users").doc(decoded.uid).get();
    callerData = userDoc.exists ? userDoc.data() : null;
  } catch (error) {
    console.error("agent-task-file: failed to load caller", error);
    return response.status(200).json({ ok: true, answer: "Не удалось проверить пользователя, попробуйте ещё раз." });
  }

  const organizationId = callerData?.organizationId || null;
  if (!organizationId) {
    return response.status(200).json({ ok: true, answer: "Вы пока не состоите ни в одной организации — задачи создать нельзя." });
  }
  if (!["owner", "admin", "moderator"].includes(callerData?.orgRole)) {
    return response.status(200).json({ ok: true, answer: "Создавать задачи через агента может владелец, админ или модератор. У исполнителя нет таких прав." });
  }

  let projects = [];
  try {
    const snap = await db.collection("projects").where("organizationId", "==", organizationId).limit(200).get();
    projects = snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error("agent-task-file: failed to load projects", error);
    return response.status(200).json({ ok: true, answer: "Не удалось загрузить проекты организации, попробуйте ещё раз." });
  }

  const accessible = filterAccessibleProjects(projects, callerData);
  const projectResult = await resolveTargetProject({ db, payload, projects: accessible, organizationId, callerData });
  if (projectResult.answer) return response.status(200).json({ ok: true, answer: projectResult.answer });
  if (projectResult.error) return response.status(projectResult.status || 400).json({ error: projectResult.error });
  const project = projectResult.project;

  let extracted;
  try {
    extracted = await extractMaterialText({
      filename: payload.file.filename,
      contentType: payload.file.mimeType,
      base64: payload.file.base64,
    });
  } catch (error) {
    console.error("agent-task-file: extraction threw", error);
    return response.status(200).json({ ok: true, answer: "Не удалось прочитать файл. Проверьте формат и попробуйте ещё раз." });
  }

  const fileText = String(extracted.text || "").slice(0, MAX_EXTRACTED_CHARS);
  if (!fileText.trim()) {
    return response.status(200).json({ ok: true, answer: "Создавать нечего: из файла не удалось извлечь текст с задачами." });
  }

  const users = await loadOrgUsers(db, organizationId);
  if (!users.ok) return response.status(200).json({ ok: true, answer: users.answer });

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) {
    const fallback = await buildFallbackTaskProposal({
      fileText,
      users: users.users,
      file: payload.file,
      project,
      userMessage: payload.message,
      extractedTruncated: extracted.truncated === true,
    });
    if (fallback.taskProposal) return response.status(200).json({ ok: true, taskProposal: fallback.taskProposal });
    return response.status(200).json({ ok: true, answer: "ИИ-агент временно недоступен (не настроен OpenRouter)." });
  }

  const membersText = users.users.map((u) => displayName(u)).filter(Boolean).join(", ");
  const userPrompt = [
    `Проект для создаваемых задач: ${project.name || "без названия"}.`,
    `Файл: ${payload.file.filename}.`,
    `Участники HoldingMan для сопоставления ответственных: ${membersText || "нет участников"}.`,
    payload.message ? `Инструкция пользователя: ${payload.message}` : "Инструкция пользователя: нет.",
    "Текст файла:",
    fileText,
  ].join("\n\n");

  const llm = await callModelForProposal({ openRouterKey, userPrompt });
  if (!llm.ok) {
    const fallback = await buildFallbackTaskProposal({
      fileText,
      users: users.users,
      file: payload.file,
      project,
      userMessage: payload.message,
      extractedTruncated: extracted.truncated === true,
    });
    if (fallback.taskProposal) return response.status(200).json({ ok: true, taskProposal: fallback.taskProposal });
    return response.status(200).json({ ok: true, answer: "Не удалось разобрать файл агентом, попробуйте ещё раз или сократите файл." });
  }

  const proposal = await buildTaskProposal({
    db,
    rawAnswer: llm.answer,
    users: users.users,
    file: payload.file,
    project,
    extractedTruncated: extracted.truncated === true,
  });

  if (proposal.answer) return response.status(200).json({ ok: true, answer: proposal.answer, model: llm.model });
  return response.status(200).json({ ok: true, taskProposal: proposal.taskProposal, model: llm.model });
}

async function resolveTargetProject({ db, payload, projects, organizationId, callerData }) {
  let project = null;
  if (payload.projectId) {
    try {
      const snap = await db.collection("projects").doc(payload.projectId).get();
      project = snap.exists ? { id: snap.id, ...snap.data() } : null;
    } catch (error) {
      console.error("agent-task-file: failed to load target project", error);
      return { answer: "Не удалось проверить проект, попробуйте ещё раз." };
    }
    if (!project || project.organizationId !== organizationId) {
      return { answer: "Проект не найден в вашей организации." };
    }
  } else {
    const projectLookupText = payload.projectName || payload.message;
    const resolved = resolveProjectFromMessage(projects, projectLookupText);
    if (resolved.error === "ambiguous") {
      return { answer: "Название проекта подходит к нескольким проектам. Откройте нужный проект или уточните его полное название в сообщении." };
    }
    if (resolved.error) {
      return { answer: "Откройте проект перед прикреплением файла или напишите название проекта в сообщении." };
    }
    project = resolved.project;
  }

  if (!callerCanManageProject(callerData?.orgRole, callerData?.allowedProjects, project.id)) {
    return { answer: "Нет доступа к созданию задач в этом проекте." };
  }
  return { project };
}

async function loadOrgUsers(db, organizationId) {
  try {
    const snap = await db.collection("users").where("organizationId", "==", organizationId).get();
    return { ok: true, users: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) };
  } catch (error) {
    console.error("agent-task-file: failed to load users", error);
    return { ok: false, answer: "Не удалось загрузить участников организации, попробуйте ещё раз." };
  }
}

async function callModelForProposal({ openRouterKey, userPrompt }) {
  const models = buildOpenRouterModels();
  const deadline = Date.now() + 50_000;
  for (const model of models) {
    const remainingMs = deadline - Date.now();
    if (remainingMs < 3000) break;
    const attempt = await fetchJsonWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openRouterKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...openRouterModelBody([model]),
        temperature: 0.1,
        max_tokens: 4000,
        messages: [
          { role: "system", content: TASK_FILE_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    }, Math.min(25_000, remainingMs));
    if (!attempt.ok) continue;
    const answer = String(attempt.data?.choices?.[0]?.message?.content || "").trim();
    if (answer) return { ok: true, answer, model };
  }
  return { ok: false };
}

async function buildTaskProposal({ rawAnswer, users, file, project, extractedTruncated }) {
  const extracted = extractProposal(rawAnswer);
  if (!extracted.found || extracted.error) {
    console.error("agent-task-file: propose_tasks parse failed", {
      answerLength: String(rawAnswer || "").length,
      tail: String(rawAnswer || "").slice(-160),
    });
    return { answer: "Не смог корректно разобрать задачи из файла. Попробуйте файл поменьше или уточните, какие строки считать задачами." };
  }

  return buildTaskProposalFromProposal({
    proposal: extracted.proposal,
    users,
    file,
    project,
    truncated: extracted.truncated === true || extractedTruncated === true,
  });
}

async function buildFallbackTaskProposal({ fileText, users, file, project, userMessage, extractedTruncated }) {
  const proposal = buildTableFallbackProposalFromText(fileText, {
    fileName: file.filename,
    userMessage,
  });
  if (!proposal) return { answer: "Не удалось разобрать файл агентом, попробуйте ещё раз или сократите файл." };
  return buildTaskProposalFromProposal({
    proposal,
    users,
    file,
    project,
    truncated: extractedTruncated === true,
  });
}

function buildTaskProposalFromProposal({ proposal, users, file, project, truncated }) {
  if (Array.isArray(proposal?.tasks) && proposal.tasks.length === 0) {
    return { answer: "Создавать нечего: не нашёл в файле список работ/задач. Если он там есть — напишите, в каких колонках/разделе искать." };
  }

  const validated = validateProposal({
    ...proposal,
    file: file.filename,
  });
  if (!validated.ok) {
    return { answer: validated.error.includes("ни одна строка")
      ? "Создавать нечего: в файле не найден список задач (нужны хотя бы названия работ)."
      : `Не получилось сформировать задачи: ${validated.error}.` };
  }

  const REASON_TEXT = {
    not_found: "ответственный не найден среди участников HoldingMan",
    ambiguous: "имя подходит нескольким пользователям",
    no_title: "нет названия задачи",
    bad_deadline: "некорректный срок в документе",
    no_assignee: "не указан ответственный",
  };
  const tasks = validated.tasks.map((t) => {
    if (t.rowError) {
      return { title: t.title || "-", deadline: t.deadline, assigneeName: t.assigneeName, ok: false, reason: REASON_TEXT[t.rowError] || t.rowError };
    }
    // Ответственный ОПЦИОНАЛЕН: строка без исполнителя (или запрос «без
    // ответственных») создаётся как «Не назначен».
    if (!t.assigneeName) {
      return { ...t, deadline: t.deadline || null, assigneeUid: null, assigneeDisplay: "Не назначен", ok: true };
    }
    const match = matchAssignee(users, t.assigneeName);
    if (match.error) return { ...t, ok: false, reason: REASON_TEXT[match.error] || match.error };
    // Срок ОПЦИОНАЛЕН: строка без срока в документе создаётся с deadline null
    // (как при ручном создании задачи), а не бракуется.
    return { ...t, deadline: t.deadline || null, assigneeUid: match.uid, assigneeDisplay: match.displayName, ok: true };
  });

  return {
    taskProposal: {
      file: file.filename,
      projectId: project.id,
      projectName: project.name || "без названия",
      tasks,
      canCreate: true,
      truncated: truncated === true
        || validated.trimmed === true
        || proposal.hasMore === true,
    },
  };
}

export function buildTableFallbackProposalFromText(fileText, { fileName = "файл", userMessage = "" } = {}) {
  const lines = String(fileText || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const override = parseUserOverrides(userMessage);
  const tasks = [];

  for (let i = 0; i < lines.length; i += 1) {
    const cells = splitTableLine(lines[i]);
    const header = detectTaskTableHeader(cells);
    if (!header) continue;

    for (let j = i + 1; j < lines.length && tasks.length < 30; j += 1) {
      const row = splitTableLine(lines[j]);
      if (row.length < 3) continue;
      if (detectTaskTableHeader(row)) break;
      const title = row[header.titleIdx] || "";
      const assigneeName = override.assigneeName || row[header.assigneeIdx] || "";
      const deadline = override.deadline || normalizeDeadlineCell(row[header.deadlineIdx] || "");
      if (!title || !assigneeName) continue;
      tasks.push({ title, assigneeName, deadline });
    }
    break;
  }

  if (tasks.length === 0) return null;
  return {
    action: "propose_tasks",
    file: fileName,
    tasks,
    hasMore: tasks.length >= 30,
  };
}

function splitTableLine(line) {
  return String(line || "").split("\t").map((cell) => cell.trim());
}

function detectTaskTableHeader(cells) {
  const normalized = cells.map(normalizeHeaderCell);
  const titleIdx = normalized.findIndex((cell) =>
    cell.includes("задача") || cell.includes("обязательство") || cell.includes("наименование"));
  const assigneeIdx = normalized.findIndex((cell) => cell.includes("ответственный"));
  let deadlineIdx = normalized.findIndex((cell) => cell.includes("расчетный дедлайн") || cell.includes("расчётный дедлайн"));
  if (deadlineIdx < 0) {
    deadlineIdx = normalized.findIndex((cell) => cell === "дедлайн" || cell.includes("крайний срок"));
  }
  if (deadlineIdx < 0) {
    deadlineIdx = normalized.findIndex((cell) => cell === "срок");
  }
  if (deadlineIdx < 0) {
    deadlineIdx = normalized.findIndex((cell) =>
      cell.includes("срок") && !cell.includes("от чего") && !cell.includes("длительность"));
  }
  if (titleIdx < 0 || assigneeIdx < 0 || deadlineIdx < 0) return null;
  return { titleIdx, assigneeIdx, deadlineIdx };
}

function normalizeHeaderCell(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[ё]/g, "е")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDeadlineCell(value) {
  const text = String(value || "").trim();
  if (!text || text === "—" || /график|факт|срок по|не указано/i.test(text)) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const ru = text.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (ru) return `${ru[3]}-${ru[2].padStart(2, "0")}-${ru[1].padStart(2, "0")}`;
  if (/^\d{5}$/.test(text)) return excelSerialToDate(Number(text));
  return null;
}

function excelSerialToDate(serial) {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return null;
  const ms = Math.round((serial - 25569) * 86400 * 1000);
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function parseUserOverrides(message) {
  const text = String(message || "").trim();
  const deadlineMatch = text.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  let assigneeName = "";
  const assigneeMatch = text.match(/назнач(?:ь|ить)?(?:\s+все)?\s+на\s+(.+?)(?:\s+со\s+сроком|\s+срок|\s+до\s+20\d{2}-\d{2}-\d{2}|$)/i);
  if (assigneeMatch) assigneeName = assigneeMatch[1].trim();
  return {
    assigneeName,
    deadline: deadlineMatch ? deadlineMatch[1] : null,
  };
}

function filterAccessibleProjects(projects, callerData) {
  if (callerData?.orgRole === "owner" || callerData?.orgRole === "admin") return projects;
  const allowed = callerData?.allowedProjects;
  if (!Array.isArray(allowed) || allowed.length === 0) return projects;
  const set = new Set(allowed.filter((id) => id !== NO_ACCESS_SENTINEL));
  return projects.filter((p) => set.has(p.id));
}

function displayName(user) {
  return user.displayName
    || `${user.firstName || ""} ${user.lastName || ""}`.trim()
    || user.email
    || "";
}

function normalizeLookup(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[ё]/g, "е")
    .replace(/[\s_-]+/g, " ")
    .trim();
}

function extensionOf(filename) {
  const clean = String(filename || "").toLowerCase().split("?")[0].split("#")[0];
  const idx = clean.lastIndexOf(".");
  return idx >= 0 ? clean.slice(idx + 1) : "";
}

function stripDataUrlPrefix(value) {
  return value.replace(/^data:[^,]*;base64,/i, "").trim();
}

async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") {
    if (Buffer.byteLength(request.body, "utf8") > MAX_BODY_BYTES) throw new Error("Request body too large");
    return JSON.parse(request.body || "{}");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}
