// Global AI agent chat endpoint: an assistant that reads the projects/tasks/
// uploaded-file-text the CALLER may access, via the Admin SDK. The context is
// SCOPED to the caller's accessible projects (see accessibleProjectIdsFor):
// owner/admin and members with no allow-list get all org projects; a restricted
// member gets only their allowedProjects. It does NOT bypass allowedProjects —
// do not "restore" an org-wide read here, it would leak restricted projects.
import { adminDb, adminAuth } from "../lib/firebase-admin.js";
import { FieldValue } from "firebase-admin/firestore";
import { buildOpenRouterModels, openRouterModelBody, fetchWithTimeout } from "../lib/openrouter-config.js";
import { extractProposal, validateProposal, matchAssignee, validateCreateTasksPayload } from "../lib/task-proposal.js";
import { sendTelegramMessage } from "../lib/telegram-send.js";
// Same manage bar as the rules/award flow: owner/admin manage any project in
// their org; a moderator only projects in their allowedProjects.
import { callerCanManageProject } from "./award-xp.js";

const CONTEXT_CHAR_LIMIT = 45000;
const MAX_HISTORY_TURNS = 8;
const MAX_MESSAGE_CHARS = 4000;
// Output-token cap for the model reply. Was 900 (truncated long answers), then
// 2000 — which still cut propose_tasks JSON mid-array on a big roadmap
// document. 3000 fits a 20-task JSON block (the prompt also caps the block at
// 20 tasks per portion) plus detailed Markdown tables; the extractor can
// additionally salvage complete tasks if a model still overruns.
const MAX_OUTPUT_TOKENS = 3000;
// Mirrors the frontend access model (see script.js): users.allowedProjects with
// an empty/absent array means "all projects"; a lone sentinel id means "none".
const NO_ACCESS_SENTINEL = "__no_access__";
// Per-user rate limit protecting the OpenRouter budget from a single
// authenticated user spamming the endpoint (a known abuse/cost vector).
const RATE_LIMIT_COLLECTION = "agentRateLimits";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20; // requests per window per user
const OFF_TOPIC_RESPONSE =
  "Я отвечаю только по ProjectMan: проектам, задачам, срокам, исполнителям, файлам, уведомлениям и работе внутри вашей организации. По этому вопросу вне системы ответить не могу.";

const PROJECTMAN_CAPABILITY_GUIDE = [
  "Карта реального функционала ProjectMan важнее общих знаний о системах управления проектами.",
  "В ProjectMan есть: организации, роли owner/admin/moderator/employee, проекты, доступ пользователей к проектам, задачи, исполнители, дедлайн задачи, файлы задачи, файлы проекта, статусы задач, календарь по дедлайнам, раздел «Мои задачи», админ-панель, профиль/рейтинг, ИИ-агент и Telegram-уведомления при подключенном Telegram.",
  "Статусы задач: «Задача поставлена», «В работе», «Завершена» (на проверке у руководителя), «Готово» (принята/архив). Статус меняют через бейдж/меню статуса задачи; нет drag-and-drop перетаскивания карточек.",
  "Файлы: к задаче можно прикреплять до 2 файлов до 10 МБ; при завершении исполнитель добавляет комментарий о выполнении и 1-3 файла подтверждения; в «Файлы проекта» можно загружать md/xlsx/xlsm/pdf/docx до 10 МБ, их текст использует агент.",
  "Календарь показывает задачи по дедлайну и список задач выбранного дня. В календаре нет фильтров по блоку/ответственному и нет синхронизации с Outlook или Google Calendar.",
  "Уведомления: Telegram-уведомления о новых задачах, возврате на доработку, напоминаниях и просрочке при подключенном Telegram. Нет подписок, ежедневных дайджестов и пользовательских правил уведомлений.",
  "В ProjectMan НЕТ: отдельного переключателя режима «Канбан», автоматической группировки задач по блокам, drag-and-drop смены статуса, отдельной плановой даты начала задачи, конструктора отчётов/отчёта «статус по блокам», чек-листов/подзадач, общего комментарного чата под задачей, подписок, daily digest, custom notification rules, Outlook/Google Calendar sync, планирования совещаний/стендапов внутри приложения.",
  "Если пользователь спрашивает, как контролировать конкретный проект, предлагай только реальный workflow: разложить работу на проекты/задачи, при необходимости кодировать блоки в названии задачи или отдельными проектами, назначать исполнителей и дедлайны, прикреплять документы, смотреть «Мои задачи» и календарь по дедлайнам, менять статусы через меню статуса, проверять завершение по комментарию/файлам подтверждения, управлять доступами в админ-панели и использовать Telegram-уведомления.",
  "Если пользователь просит функцию, которой нет, прямо скажи «в ProjectMan такой функции нет» и предложи ближайший реальный способ внутри текущего приложения.",
].join(" ");

const SYSTEM_PROMPT_RULES = [
  "Ты — ИИ Руководитель проекта, ассистент внутри системы управления задачами ProjectMan.",
  "На приветствия, благодарности и короткие обращения (например «привет», «здравствуйте», «спасибо», «ок») отвечай коротко, дружелюбно и по-человечески, и предлагай помощь по проектам и задачам. Это НЕ повод для отказа.",
  "Отвечай по темам ProjectMan: проекты, задачи, сроки, исполнители, файлы, уведомления, роли, вход и работа внутри организации.",
  `Отказ давай ТОЛЬКО на посторонние вопросы-факты, не связанные с работой организации (например «размер луны», «когда отменили крепостное право», погода, история, политика). В этом случае ответь строго этой фразой: ${OFF_TOPIC_RESPONSE}`,
  PROJECTMAN_CAPABILITY_GUIDE,
  "ФОРМИРОВАНИЕ ЗАДАЧ ИЗ ДОКУМЕНТА: если пользователь просит сформировать/создать/поставить задачи из загруженного документа (файла проекта), НЕ пиши обычный ответ — верни РОВНО ОДИН блок кода: ```json {\"action\":\"propose_tasks\",\"file\":\"<точное имя файла из данных>\",\"tasks\":[{\"title\":\"...\",\"deadline\":\"ГГГГ-ММ-ДД или null\",\"assigneeName\":\"Имя Фамилия\"}]} ``` — без текста до и после блока. В блоке НЕ БОЛЬШЕ 20 задач за раз: если в документе их больше — включи первые 20 по порядку документа (пользователь попросит следующую порцию отдельно). Названия задач краткие и понятные; ответственного и срок бери ТОЛЬКО из документа; если срок не указан — null; не выдумывай задачи, которых в документе нет. Если нужного документа нет в данных — ответь обычным текстом, что документ не найден.",
  "По умолчанию отвечай кратко (1-3 тезиса), простым нетехническим языком. Но если пользователь просит подробности, список, таблицу или схему — дай полный, хорошо структурированный ответ и НЕ сокращай данные.",
  "Обычные ответы пиши обычным текстом или короткими пунктами. Таблицу (Markdown: строка заголовков, строка-разделитель | --- | --- |, строки данных) делай ТОЛЬКО когда она действительно уместна: когда перечисляешь НЕСКОЛЬКО (2+) однотипных объектов с общими полями — список задач с исполнителями/сроками/статусами, сравнение проектов и т.п. — ИЛИ когда пользователь прямо просит таблицу. НЕ оборачивай в таблицу один объект, короткий факт, приветствие или пояснение (например «что за задача X» про одну задачу — ответь обычным текстом, а не таблицей «поле—значение»). Для акцентов можно **жирный**, для простых перечней — списки. Ссылки [текст](url) и изображения не вставляй.",
  "НЕ рисуй псевдографику и ASCII-диаграммы (сетки из | и —, стрелочные таймлайны, «нарисованные» схемы) — в чате они не отображаются и выглядят сломанно. Блоки кода (```) используй только для настоящего кода/конфигов. Если просят «схему», «диаграмму», «график», «таймлайн» или «дорожную карту» — представь это Markdown-таблицей (например: Этап | Период | Статус) или структурированным списком по этапам/годам, а не рисунком из символов.",
  "НИКОГДА не показывай технические идентификаторы, коды или ID документов. Проекты, задачи и людей называй только их человеческими именами.",
  "Ты видишь ТОЛЬКО проекты, к которым у пользователя есть доступ (они перечислены ниже в данных), и их задачи — не проси открыть раздел или выбрать проект, если данные уже есть. Если пользователь спрашивает про проект, которого НЕТ в этих данных, — вежливо ответь, что у него нет доступа к этому проекту или такого проекта нет среди его проектов; НЕ раскрывай по нему никаких данных и не придумывай их.",
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

  // Phase 2 of the create-tasks-from-document flow: the client's «Создать N
  // задач» button posts {action:'create_tasks', ...} instead of a chat message.
  const isCreateAction = body && body.action === "create_tasks";

  const message = String(body.message || "").trim().slice(0, MAX_MESSAGE_CHARS);
  if (!isCreateAction && !message) return response.status(400).json({ error: "message is required" });
  const history = normalizeHistory(body.history);

  // Scope is enforced by the system prompt (greet greetings, refuse only
  // genuinely off-topic factual questions), NOT by a hard regex pre-filter —
  // the old pre-filter false-refused normal conversational openers like
  // "здорова"/"здарова" that no allow-list can reliably enumerate. Letting the
  // model decide is more natural and correct; the OFF_TOPIC_RESPONSE phrase is
  // still enforced verbatim by the prompt for real off-topic questions.
  const db = adminDb();

  // Per-user rate limit (best-effort; fails OPEN if the limiter itself errors,
  // so a limiter hiccup never blocks a legitimate user). Written via the Admin
  // SDK to agentRateLimits/{uid}, which clients can't touch (default-deny).
  try {
    const now = Date.now();
    const rlRef = db.collection(RATE_LIMIT_COLLECTION).doc(decoded.uid);
    // Transactional so concurrent requests from the same user can't both read
    // the same window and slip through (a plain get-then-set is a TOCTOU race
    // that under-counts exactly when the limiter matters — rapid repeats).
    const allowed = await db.runTransaction(async (tx) => {
      const rlSnap = await tx.get(rlRef);
      const rl = evaluateRateLimit(rlSnap.exists ? rlSnap.data().timestamps : [], now);
      if (!rl.allowed) return false;
      tx.set(rlRef, { timestamps: rl.timestamps, updatedAt: now }, { merge: true });
      return true;
    });
    if (!allowed) {
      return response.status(200).json({ ok: true, answer: "Слишком много запросов подряд. Подождите минуту и попробуйте снова." });
    }
  } catch (error) {
    console.error("agent-chat: rate limit check failed", error);
  }

  let organizationId;
  let accessibleProjectIds = null; // null = all projects (owner/admin or unrestricted)
  let callerData = null; // kept for the task-creation permission check (orgRole/allowedProjects)
  try {
    const userDoc = await db.collection("users").doc(decoded.uid).get();
    callerData = userDoc.exists ? userDoc.data() : null;
    organizationId = callerData ? callerData.organizationId : null;
    accessibleProjectIds = accessibleProjectIdsFor(callerData);
  } catch (error) {
    console.error("agent-chat: failed to load user doc", error);
    return response.status(200).json({ ok: true, answer: "Не удалось загрузить данные организации, попробуйте ещё раз." });
  }
  if (!organizationId) {
    return response.status(200).json({ ok: true, answer: "Вы пока не состоите ни в одной организации — агенту нечего показать." });
  }

  // PHASE 2: confirmed creation from a previously shown proposal. Own
  // validation + a server-side permission check (the button being visible on
  // the client proves nothing).
  if (isCreateAction) {
    return handleCreateTasks({ db, response, decoded, body, callerData, organizationId });
  }
  // Restricted member with access to NO projects: don't even call the model.
  if (Array.isArray(accessibleProjectIds) && accessibleProjectIds.length === 0) {
    return response.status(200).json({ ok: true, answer: "У вас пока нет доступа ни к одному проекту в этой организации — обратитесь к владельцу или администратору." });
  }

  let context;
  try {
    context = await loadOrganizationContext(db, organizationId, accessibleProjectIds);
  } catch (error) {
    console.error("agent-chat: failed to load organization context", error);
    return response.status(200).json({ ok: true, answer: "Не удалось загрузить данные организации, попробуйте ещё раз." });
  }
  let contextText;
  try {
    contextText = compactContext(context);
  } catch (error) {
    // Defense in depth: compactContext's internals (taskRecency,
    // buildBoundedStructured, JSON.stringify over org-controlled document
    // data, etc.) are hardened individually, but this call site is wrapped
    // too so ANY future failure mode in that pipeline degrades gracefully
    // (HTTP 200 fallback, same pattern as the Firestore-read failures above)
    // instead of crashing the whole request — matching how this file already
    // treats every other external-data-dependent step.
    console.error("agent-chat: failed to compact organization context", error);
    return response.status(200).json({ ok: true, answer: "Не удалось загрузить данные организации, попробуйте ещё раз." });
  }

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
        body: JSON.stringify({ ...openRouterModelBody([model]), temperature: 0.2, max_tokens: MAX_OUTPUT_TOKENS, messages }),
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

      // PHASE 1: did the model answer with a propose_tasks JSON block?
      // (Only fires when the user asked to form tasks from a document — the
      // system prompt mandates the block for that intent.) Any problem with
      // the block degrades to a plain-text explanation, never a 500.
      try {
        const proposal = await tryBuildTaskProposal({ db, rawAnswer: answer, context, organizationId, callerData });
        if (proposal) {
          if (proposal.error) {
            return response.status(200).json({ ok: true, answer: proposal.error, model });
          }
          return response.status(200).json({ ok: true, taskProposal: proposal.taskProposal, model });
        }
      } catch (error) {
        console.error("agent-chat: task proposal post-processing failed", error);
        return response.status(200).json({ ok: true, answer: "Не удалось подготовить список задач из документа, попробуйте ещё раз.", model });
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

// ===== CREATE TASKS FROM A DOCUMENT (two-phase protocol) =====

// PHASE 1 post-processing: if the LLM answered with a propose_tasks JSON
// block, turn it into a validated proposal for the client's preview card.
// Returns null (not our flow — treat the answer as normal chat),
// { error } (human-readable Russian text to show instead), or
// { taskProposal } for the preview card.
async function tryBuildTaskProposal({ db, rawAnswer, context, organizationId, callerData }) {
  const extracted = extractProposal(rawAnswer);
  if (!extracted.found) return null;
  if (extracted.error) {
    // Log the tail — the usual culprit is the model hitting max_tokens
    // mid-JSON on a huge document, and the tail shows exactly where it died.
    console.error("agent-chat: propose_tasks parse failed", {
      answerLength: rawAnswer.length,
      tail: rawAnswer.slice(-160),
    });
    return { error: "Не смог корректно разобрать задачи из документа — похоже, список получился слишком большим. Попросите порцию поменьше, например: «первые 10 задач из документа X» или задачи по конкретному разделу." };
  }

  // Salvaged from a truncated payload: keep it within the validator's cap and
  // tell the client the list is partial.
  if (extracted.truncated && Array.isArray(extracted.proposal.tasks)) {
    extracted.proposal.tasks = extracted.proposal.tasks.slice(0, 30);
  }

  const validated = validateProposal(extracted.proposal);
  if (!validated.ok) {
    return { error: `Не получилось сформировать задачи: ${validated.error}.` };
  }

  // Bind the proposal to the document's project by filename (exact
  // case-insensitive match first, then a unique substring match). The LLM only
  // ever sees filenames — never project ids.
  const wanted = validated.file.toLowerCase();
  const allFiles = Array.isArray(context.files) ? context.files : [];
  let hits = allFiles.filter((f) => (f.filename || "").toLowerCase() === wanted);
  if (hits.length === 0) {
    hits = allFiles.filter((f) => (f.filename || "").toLowerCase().includes(wanted));
  }
  if (hits.length === 0) {
    return { error: `Документ «${validated.file}» не найден среди файлов ваших проектов (или из него не извлечён текст).` };
  }
  if (hits.length > 1) {
    return { error: `Название «${validated.file}» подходит к нескольким файлам — уточните, какой документ использовать.` };
  }
  const file = hits[0];

  // Org members for assignee matching (by human name from the document).
  let users = [];
  try {
    const usersSnap = await db.collection("users").where("organizationId", "==", organizationId).get();
    users = usersSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (error) {
    console.error("agent-chat proposal: failed to load org users", error);
    return { error: "Не удалось загрузить список участников организации, попробуйте ещё раз." };
  }

  const REASON_TEXT = {
    not_found: "пользователь не найден в организации",
    ambiguous: "имя подходит нескольким пользователям",
    no_deadline: "в документе не указан срок",
  };
  const tasks = validated.tasks.map((t) => {
    const match = matchAssignee(users, t.assigneeName);
    if (match.error) {
      return { ...t, ok: false, reason: REASON_TEXT[match.error] || match.error };
    }
    if (!t.deadline) {
      // Creation requires a real deadline (board rendering + the deadline
      // monitor both assume one) — surface it in the preview instead.
      return { ...t, assigneeUid: match.uid, assigneeDisplay: match.displayName, ok: false, reason: REASON_TEXT.no_deadline };
    }
    return { ...t, assigneeUid: match.uid, assigneeDisplay: match.displayName, ok: true };
  });

  const canCreate = callerCanManageProject(callerData?.orgRole, callerData?.allowedProjects, file.projectId);
  return {
    taskProposal: {
      file: file.filename,
      projectId: file.projectId,
      projectName: file.projectName || "без названия",
      tasks,
      canCreate,
      // Partial list recovered from a token-capped answer — the card warns
      // the user so they can ask for the next portion after creating these.
      truncated: extracted.truncated === true,
    },
  };
}

// PHASE 2: the confirmed «Создать N задач» click. Server-side validation +
// the same manage bar as the main UI, then a single batch creating the task
// docs (field shape mirrors the client's createTask()) and the feed entries;
// Telegram duplicates go out after the commit.
async function handleCreateTasks({ db, response, decoded, body, callerData, organizationId }) {
  const payload = validateCreateTasksPayload(body);
  if (!payload.ok) return response.status(400).json({ error: payload.error });

  let project;
  try {
    const snap = await db.collection("projects").doc(payload.projectId).get();
    project = snap.exists ? snap.data() : null;
  } catch (error) {
    console.error("agent-chat create_tasks: project load failed", error);
    return response.status(500).json({ error: "Не удалось проверить проект" });
  }
  if (!project || project.organizationId !== organizationId) {
    return response.status(403).json({ error: "Проект не найден в вашей организации" });
  }
  if (!callerCanManageProject(callerData?.orgRole, callerData?.allowedProjects, payload.projectId)) {
    return response.status(403).json({ error: "Недостаточно прав для создания задач в этом проекте" });
  }

  // Every assignee must be a real member of the caller's org — reject the
  // whole request otherwise (no partial creation surprises).
  const uniqueUids = [...new Set(payload.tasks.map((t) => t.assigneeUid))];
  const usersByUid = new Map();
  for (const uid of uniqueUids) {
    try {
      const snap = await db.collection("users").doc(uid).get();
      const data = snap.exists ? snap.data() : null;
      if (!data || data.organizationId !== organizationId) {
        return response.status(400).json({ error: "Один из исполнителей не найден в вашей организации" });
      }
      usersByUid.set(uid, data);
    } catch (error) {
      console.error("agent-chat create_tasks: user load failed", uid, error);
      return response.status(500).json({ error: "Не удалось проверить исполнителей" });
    }
  }

  const createdByName = callerData
    ? (`${callerData.firstName || ""} ${callerData.lastName || ""}`.trim() || callerData.email || "ИИ-агент")
    : "ИИ-агент";
  const description = payload.file
    ? `Создано ИИ-агентом из документа «${payload.file}»`
    : "Создано ИИ-агентом";
  const projectName = project.name || "Проект";

  const batch = db.batch();
  const telegramQueue = [];
  for (const t of payload.tasks) {
    const user = usersByUid.get(t.assigneeUid);
    const assigneeDisplay = user.displayName
      || `${user.firstName || ""} ${user.lastName || ""}`.trim()
      || user.email
      || "Исполнитель";
    const taskRef = db.collection("tasks").doc();
    // Field shape mirrors the client's createTask() exactly, so boards,
    // filters, the reader carve-out and the monitor treat these tasks like any
    // manually created one.
    batch.set(taskRef, {
      projectId: payload.projectId,
      organizationId,
      title: t.title,
      description,
      assignee: assigneeDisplay,
      assigneeEmail: user.email || "",
      assigneeIds: [t.assigneeUid],
      deadline: t.deadline,
      status: "in-progress",
      subStatus: "assigned",
      assigneeCompleted: false,
      attachments: [],
      createdAt: FieldValue.serverTimestamp(),
      createdBy: createdByName,
      createdByEmail: callerData?.email || "",
      createdByUid: decoded.uid,
    });

    const text = `🆕 Новая задача: «${t.title}». Срок: ${t.deadline} (проект «${projectName}»). Поставлена ИИ-агентом по поручению: ${createdByName}.`;
    const noteRef = db.collection("agentNotifications").doc();
    batch.set(noteRef, {
      uid: t.assigneeUid,
      organizationId,
      taskId: taskRef.id,
      projectId: payload.projectId,
      type: "tasks_created",
      text,
      createdAt: FieldValue.serverTimestamp(),
      readAt: null,
    });
    if (user.telegramChatId) telegramQueue.push({ chatId: user.telegramChatId, text });
  }

  try {
    await batch.commit();
  } catch (error) {
    console.error("agent-chat create_tasks: batch commit failed", error);
    return response.status(500).json({ error: "Не удалось создать задачи" });
  }
  for (const message of telegramQueue) {
    await sendTelegramMessage(message.chatId, message.text);
  }

  return response.status(200).json({ ok: true, created: payload.tasks.length });
}

// Pure sliding-window rate-limit decision. Given the user's prior request
// timestamps (ms) and the current time, drop timestamps outside the window and
// decide whether this request is allowed. Returns the new timestamp list to
// persist. Extracted for unit testing; the Firestore read/write lives in the
// handler.
export function evaluateRateLimit(prior, nowMs, windowMs = RATE_LIMIT_WINDOW_MS, max = RATE_LIMIT_MAX) {
  const recent = (Array.isArray(prior) ? prior : []).filter(
    (t) => typeof t === "number" && Number.isFinite(t) && nowMs - t < windowMs
  );
  if (recent.length >= max) return { allowed: false, timestamps: recent };
  return { allowed: true, timestamps: [...recent, nowMs] };
}

// Which project ids this user may see, mirroring the app's access model:
//   owner/admin                    -> null  (all projects)
//   allowedProjects empty/absent   -> null  (all projects, the default)
//   allowedProjects = [ids...]     -> those ids (sentinel entry dropped)
//   allowedProjects = [sentinel]   -> []     (no access to any project)
// `null` means "no filtering"; an array (even empty) means "restrict to these".
export function accessibleProjectIdsFor(userData) {
  if (!userData) return null;
  if (["owner", "admin"].includes(userData.orgRole)) return null;
  const allowed = userData.allowedProjects;
  if (Array.isArray(allowed) && allowed.length > 0) {
    return allowed.filter((id) => id !== NO_ACCESS_SENTINEL);
  }
  return null; // empty/absent = all projects (the default for new members)
}

// Bounded context reads — caps so a pathologically large org can't drive
// unbounded Firestore reads. Set far above any realistic small-org size, so for
// normal orgs everything is read (no behaviour change); only a huge org gets a
// bounded sample (and it's logged).
const MAX_CONTEXT_PROJECTS = 200;
const MAX_CONTEXT_TASKS = 1500;
const MAX_CONTEXT_FILES_PER_PROJECT = 30;

async function loadOrganizationContext(db, organizationId, accessibleProjectIds = null) {
  // All queries here are single-field (`where(organizationId==)`,
  // `where(projectId in ...)`, `where(extractionStatus==)`), so Firestore's
  // automatic per-field index covers them — no firestore.indexes.json needed.
  const projectsSnap = await db.collection("projects")
    .where("organizationId", "==", organizationId)
    .limit(MAX_CONTEXT_PROJECTS)
    .get();
  let projects = projectsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  if (projectsSnap.size >= MAX_CONTEXT_PROJECTS) {
    console.warn(`agent-chat: project context capped at ${MAX_CONTEXT_PROJECTS} (org ${organizationId})`);
  }

  // Restrict to the projects this user may see (null = no restriction).
  if (accessibleProjectIds !== null) {
    const allowedSet = new Set(accessibleProjectIds);
    projects = projects.filter((p) => allowedSet.has(p.id));
  }

  // Load tasks BY projectId (not by task.organizationId). Tasks can lack or
  // carry a stale organizationId — the board loads them by projectId and the
  // rules authorize by the PROJECT's org — so querying by task.organizationId
  // would silently miss those tasks and the agent would answer "no tasks" for
  // work the user clearly sees. `where(projectId in ...)` is capped at 10 ids,
  // so chunk and parallelize; a single-field `in` still uses the auto index.
  const projectIds = projects.map((p) => p.id);
  const idChunks = [];
  for (let i = 0; i < projectIds.length; i += 10) idChunks.push(projectIds.slice(i, i + 10));
  const taskSnaps = await Promise.all(
    idChunks.map((chunk) => db.collection("tasks").where("projectId", "in", chunk).limit(MAX_CONTEXT_TASKS).get())
  );
  const tasks = [];
  for (const snap of taskSnaps) {
    for (const doc of snap.docs) {
      if (tasks.length >= MAX_CONTEXT_TASKS) break;
      tasks.push({ id: doc.id, ...doc.data() });
    }
    if (tasks.length >= MAX_CONTEXT_TASKS) break;
  }
  if (tasks.length >= MAX_CONTEXT_TASKS) {
    console.warn(`agent-chat: task context capped at ${MAX_CONTEXT_TASKS} (org ${organizationId})`);
  }

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
        .limit(MAX_CONTEXT_FILES_PER_PROJECT)
        .get()
    )
  );

  const files = [];
  filesSnaps.forEach((filesSnap, index) => {
    const project = projects[index];
    filesSnap.docs.forEach((doc) => {
      const data = doc.data();
      // projectId is needed by the task-proposal flow to bind proposed tasks
      // to the document's project; compactContext maps it to a NAME for the
      // prompt, so the raw id never leaks to the LLM.
      if (data.extractedText) files.push({ projectId: project.id, projectName: project.name || "без названия", filename: data.filename, extractedText: data.extractedText });
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
  let { structured, omittedTaskCount, omittedProjectCount } = buildBoundedStructured(context, structuredBudget);

  // Defense in depth / root-cause guard: buildBoundedStructured's incremental
  // budgeting is only as good as the assumptions baked into it (e.g. that a
  // single project/task entry is reasonably small). If some unanticipated
  // edge case — a single absurdly long name, a future field added to the
  // compact task/project shape, a change to the incremental logic itself —
  // ever lets `structured` exceed its sub-budget, we must never silently
  // return an over-budget (or silently-truncated-with-no-signal) payload.
  // Hard-truncate here as a last resort and ALWAYS disclose it, even though
  // this should be unreachable in normal operation.
  let structuredOverBudget = false;
  if (structured.length > structuredBudget) {
    structuredOverBudget = true;
    structured = structured.slice(0, structuredBudget);
  }

  // Truncation priority: structured project/task data is capped first (see
  // buildBoundedStructured), then whatever budget remains (CONTEXT_CHAR_LIMIT
  // minus the *actual* structured length, not the reserved budget — so a
  // small org that doesn't use its full structured allowance leaves more
  // room for file text) goes to file text, cut at the file boundary.
  let fileBudget = CONTEXT_CHAR_LIMIT - structured.length - 4; // 4 for the two newlines joining them
  const projectNameById = new Map(context.projects.map((p) => [p.id, p.name || "без названия"]));
  const fileTexts = [];
  let filesTruncated = false;
  for (const f of context.files) {
    const projectName = f.projectName || projectNameById.get(f.projectId) || "без проекта";
    const chunk = `Файл "${f.filename}" (проект «${projectName}»):\n${f.extractedText}`;
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
  if (omittedProjectCount > 0) {
    notices.push(`...[в контекст не поместилось ${omittedProjectCount} проект(ов) — данные по ним не учтены]`);
  }
  if (omittedTaskCount > 0) {
    notices.push(`...[в контекст не поместилось ${omittedTaskCount} задач(и) — данные по ним не учтены]`);
  }
  if (structuredOverBudget) {
    notices.push("...[данные проектов/задач обрезаны по объёму — часть структурированных данных могла не попасть в контекст]");
  }
  if (filesTruncated) {
    notices.push("...[данные обрезаны по объёму — часть файлов могла не попасть в контекст]");
  }
  if (notices.length) combined += `\n${notices.join("\n")}`;
  return combined;
}

// Budget split *within* the structured sub-budget: projects get a small
// fixed slice, tasks get the remainder.
//
// Reasoning: projects are typically far fewer and lighter (id + name only)
// than tasks, so a small reservation comfortably covers the common case
// while still being a genuine, enforced cap rather than "always include
// everything" (which is exactly the bug this fixes — nothing in
// Firestore/the UI caps how many projects an org can have; a prior review
// found 5,000 empty-name projects alone produce 167,807 chars, 3.7x the
// entire 45,000-char CONTEXT_CHAR_LIMIT, and the projects array participated
// in zero budgeting). Giving tasks "whatever's left" (rather than also a
// fixed ratio of the whole) means a small org with few projects doesn't
// waste reserved-but-unused project budget — tasks get to use it instead,
// since buildBoundedStructured computes the task budget as
// (structuredBudget - actual project JSON length), not a fixed ratio.
const PROJECTS_BUDGET_RATIO = 0.15;

// Builds the structured projects+tasks JSON incrementally. Both projects and
// tasks are sorted most-recently-created first (createdAt desc; entries
// without a parseable createdAt sort last) and built up one entry at a time,
// stopping once adding the next entry would exceed its respective budget.
// This guarantees `structured` itself is bounded regardless of org size —
// an earlier version serialized the FULL task list unconditionally (~950KB
// for 5,000 tasks against a 45,000-char CONTEXT_CHAR_LIMIT), and a later
// review found the *projects* array had the exact same unbounded-serialization
// bug (167,807 chars for 5,000 projects) that had never been fixed.
//
// Length is tracked incrementally (each entry's own serialized length, plus
// 1 char for the joining comma) rather than re-stringifying the whole
// growing array on every iteration — the latter is O(n^2) and noticeably
// slow for orgs with thousands of tasks/projects.
// Human-readable status matching the board columns the user actually sees.
// The raw `status` field is only 'in-progress'|'done' (legacy 2-value), and
// the real state lives in subStatus/assigneeCompleted — so feeding raw
// status:'in-progress' made the agent wrongly say "в работе" for a task that
// is merely assigned. Mapping (mirrors the board): done -> "готово";
// assigneeCompleted or subStatus 'completed' -> "на проверке"; subStatus
// 'in_work' -> "в работе"; otherwise -> "назначена".
function humanTaskStatus(t) {
  if (t.status === "done") return "готово";
  if (t.assigneeCompleted === true || t.subStatus === "completed") return "на проверке";
  if (t.subStatus === "in_work") return "в работе";
  return "назначена";
}

function buildBoundedStructured(context, budget) {
  // Map internal Firestore doc-ids -> human project names so NO opaque id
  // (e.g. "eQg1UFGwRzGUxCgqGlZc") is ever placed in the model's context and
  // therefore can never leak into a user-facing answer. Tasks reference their
  // project by name, not id.
  const projectNameById = new Map();
  for (const p of context.projects) projectNameById.set(p.id, p.name || "без названия");

  const projectsBudget = Math.floor(budget * PROJECTS_BUDGET_RATIO);
  const sortedProjects = [...context.projects].sort((a, b) => projectRecency(b) - projectRecency(a));

  const { included: includedProjects, omittedCount: omittedProjectCount, jsonLength: projectsJsonLength } =
    buildBoundedList(sortedProjects, projectsBudget, (p) => ({ name: p.name || "без названия" }));

  // Tasks get whatever's left of the structured budget after projects
  // actually used their slice (not the reserved projectsBudget) — a small
  // org with few/short project names leaves more room for tasks, the side
  // that's usually much larger and more numerous.
  const tasksBudget = budget - projectsJsonLength;
  const sortedTasks = [...context.tasks].sort((a, b) => taskRecency(b) - taskRecency(a));
  const { included: includedTasks, omittedCount: omittedTaskCount } =
    buildBoundedList(sortedTasks, tasksBudget, (t) => ({
      title: t.title, project: projectNameById.get(t.projectId) || "без проекта", assignee: t.assignee,
      deadline: t.deadline, статус: humanTaskStatus(t),
    }));

  const structured = JSON.stringify({ projects: includedProjects, tasks: includedTasks });
  return { structured, omittedTaskCount, omittedProjectCount };
}

// Shared incremental-budget builder: maps `items` through `toCompact` one at
// a time (in the given, already-sorted order), tracking the running
// serialized-array length, and stops including further items once the next
// one would exceed `budget`. Always includes at least one item (if any exist
// and `budget` isn't absurdly small) so a single pathological entry doesn't
// wipe out the entire category — but that guard itself is bounded by the
// caller-side final structured-length check in compactContext, so a single
// oversized entry can never silently blow the overall budget with zero
// disclosure.
function buildBoundedList(items, budget, toCompact) {
  const skeleton = "[]";
  let runningLength = skeleton.length;
  const included = [];
  let omittedCount = 0;

  for (const item of items) {
    const compact = toCompact(item);
    const json = JSON.stringify(compact);
    const addedLength = json.length + (included.length > 0 ? 1 : 0); // +1 for comma separator
    if (runningLength + addedLength > budget && included.length > 0) {
      omittedCount = items.length - included.length;
      break;
    }
    included.push(compact);
    runningLength += addedLength;
    // Even a single item can't fit (pathological — shouldn't happen with
    // this schema, but avoid silently exceeding budget on the very first item
    // while still guaranteeing at least one entry is present when possible).
    if (runningLength > budget && included.length === 1 && items.length > 1) {
      omittedCount = items.length - 1;
      break;
    }
  }

  const jsonLength = JSON.stringify(included).length;
  return { included, omittedCount, jsonLength };
}

// Extracts a millisecond timestamp from a `createdAt` field for recency
// sorting. Handles Firestore Timestamp objects (`.toDate()`), plain
// `{seconds, nanoseconds}`-shaped objects (what a real Timestamp becomes
// after a JSON.stringify/parse round-trip, or when read via a non-Admin-SDK
// path — reconstructed via `new Date(seconds * 1000)` rather than silently
// falling through to -Infinity, so a genuinely recent task/project isn't
// misordered as "oldest" and preferentially dropped under budget pressure),
// ISO/date strings, and missing values — mirrors the tolerant parsing
// already used for this exact field in script.js. Unparseable/missing
// values sort last (treated as oldest) rather than throwing or defaulting to
// "now", so bad data doesn't unfairly jump to the front of the kept set.
//
// Defensively wrapped end-to-end: `raw` is attacker/data-corruption
// influenced (arbitrary Firestore document content), so ANY property access
// or method call on it — including a malicious/corrupted `.toDate` that
// throws when invoked instead of behaving like a normal method — must never
// propagate an exception out of this function. A single bad record sorting
// as -Infinity (oldest, so it's first in line to be dropped under budget
// pressure) is an acceptable degradation; a crash of the whole request is not.
function recencyOf(raw) {
  try {
    if (!raw) return -Infinity;
    if (typeof raw.toDate === "function") {
      const d = raw.toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : -Infinity;
    }
    if (typeof raw === "object" && typeof raw.seconds === "number") {
      const ms = raw.seconds * 1000 + (typeof raw.nanoseconds === "number" ? raw.nanoseconds / 1e6 : 0);
      return Number.isNaN(ms) ? -Infinity : ms;
    }
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? -Infinity : d.getTime();
  } catch {
    return -Infinity;
  }
}

function taskRecency(task) {
  return recencyOf(task && task.createdAt);
}

function projectRecency(project) {
  return recencyOf(project && project.createdAt);
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
    // Flatten markdown links to their text only: the chat never shows clickable
    // URLs (this also removes the sole link/URL injection surface for the
    // frontend renderer and avoids leaking any id-like link target). All OTHER
    // markdown — tables, lists, **bold**, `code`, headings — is intentionally
    // PRESERVED and rendered safely by the frontend (see renderAgentChatMarkdown).
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

// A chat message + short history is a few KB; cap the accumulated body well
// above that so an oversized/streamed request can't grow the buffer unbounded.
// (Vercel also caps request bodies, but this is explicit and fails fast.)
const MAX_BODY_BYTES = 256 * 1024;

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

export { cleanAnswer, normalizeHistory, compactContext, OFF_TOPIC_RESPONSE };
