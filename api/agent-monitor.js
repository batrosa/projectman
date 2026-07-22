// api/agent-monitor.js
// Серверный «автопилот» агента: обходит активные задачи и рассылает
// уведомления о сроках — в ленту agentNotifications (колокольчик в приложении),
// Telegram, push и email Google-пользователям — исполнителю(ям) И постановщику.
//
// События (вся логика дат — lib/agent-monitor-core.js, Europe/Moscow):
//   overdue           — просрочена; повторяется РАЗ В ДЕНЬ, пока не закрыта
//                       (решение пользователя), антиспам — notifiedOverdueOn;
//   deadline_today    — срок сегодня; раз в день утром по Москве 9:00–12:00
//                       (notifiedDeadlineTodayOn); подхватывает и задачи, чей
//                       «завтрашний» дедлайн поставили после вечернего окна;
//   deadline_tomorrow — остался 1 день; один раз вечером по Москве
//                       (notifiedDeadlineSoonAt);
//   not_taken_1h      — назначена и >1 часа не взята в работу; один раз
//                       (notifiedNotTakenAt).
//   unassigned_1h     — >1 часа нет ответственного; один раз постановщику
//                       (notifiedUnassignedAt).
//
// Дайджест: если за прогон одному получателю набегает >3 сообщений одного
// типа, Telegram, push и email получают ОДНУ сводку («7 задач просрочены: …»);
// лента agentNotifications остаётся по записи на задачу (deep-link).
//
// Кто будит: Vercel Cron раз в сутки (vercel.json, ~18:00 МСК; Hobby-план не
// умеет чаще) и GitHub Actions раз в час (.github/workflows/agent-monitor.yml).
// Оба шлют Authorization: Bearer ${CRON_SECRET}; Vercel добавляет заголовок
// сам, если env задан. Без/с неверным секретом — 401 (fail closed).
//
// Правила событий и обязательные факты полностью детерминированы. Для двух
// управленческих событий OpenRouter может добавить короткую рекомендацию;
// таймаут, лимит вызовов и шаблонный fallback гарантируют доставку без LLM.
import { adminDb } from "../lib/firebase-admin.js";
import { FieldValue } from "firebase-admin/firestore";
import {
  classifyTask,
  buildEventText,
  buildDigestText,
  buildTelegramEventText,
  buildTelegramDigestText,
  appendTelegramAdvice,
  mskDateString,
} from "../lib/agent-monitor-core.js";
import { sendTelegramMessage } from "../lib/telegram-send.js";
import { sendPushToUser } from "../lib/push-send.js";
import { sendEmailNotification } from "../lib/email-send.js";
import { appendAgentAdvice, fallbackAgentAdvice, generateAgentAdvice } from "../lib/agent-monitor-ai.js";

// Paginated sweep: pages of 500 up to 20 pages (10k active tasks) — far above
// the real org size, and unlike a single limit() read nothing past the cap is
// silently skipped until that ceiling.
const SWEEP_PAGE_SIZE = 500;
const MAX_SWEEP_PAGES = 20;
const MAX_AI_ENRICHMENTS_PER_RUN = 6;
const AI_ADVICE_EVENT_TYPES = new Set(["unassigned_1h", "deadline_tomorrow"]);
// Soft run budget: при превышении перестаём захватывать НОВЫЕ события, но
// досылаем всё уже захваченное. AGENT_MONITOR_BUDGET_MS — ручка для тестов/опсов.
const RUN_BUDGET_MS_DEFAULT = 45_000;
// Telegram шлём небольшим пулом, а не строго последовательно.
const TELEGRAM_SEND_POOL = 10;
// Больше 3 однотипных сообщений одному получателю за прогон → один дайджест.
const DIGEST_THRESHOLD = 3;

const PUSH_TITLES = {
  overdue: "Задача просрочена",
  deadline_today: "Срок по задаче сегодня",
  deadline_tomorrow: "Остался 1 день до дедлайна",
  not_taken_1h: "Задача не взята в работу",
  unassigned_1h: "У задачи нет ответственного",
};

const PUSH_DIGEST_TITLES = {
  overdue: "Просрочено задач",
  deadline_today: "Дедлайн сегодня",
  deadline_tomorrow: "Дедлайн завтра",
  not_taken_1h: "Задачи не взяты в работу",
  unassigned_1h: "Задачи без ответственного",
};

// Группировка очереди по получателю+типу: группы больше порога схлопываются
// в один дайджест, остальное уходит индивидуальными сообщениями.
function planAggregatedMessages(queue, keyOf) {
  const groups = new Map();
  for (const item of queue) {
    const key = keyOf(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const plan = [];
  for (const items of groups.values()) {
    if (items.length > DIGEST_THRESHOLD) {
      plan.push({ digest: true, items });
    } else {
      for (const item of items) plan.push({ digest: false, items: [item] });
    }
  }
  return plan;
}

export default async function handler(request, response) {
  // GET **and** POST: Vercel Cron invokes the path with a GET (it still sends
  // the Authorization: Bearer CRON_SECRET header) — POST-only made the daily
  // cron die with 405. GitHub Actions posts. Auth is identical either way.
  if (request.method !== "POST" && request.method !== "GET") {
    response.setHeader("Allow", "GET, POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.CRON_SECRET;
  const auth = request.headers.authorization || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  const db = adminDb();
  const now = new Date();
  const startedAt = Date.now();
  const budgetEnv = Number(process.env.AGENT_MONITOR_BUDGET_MS);
  const runBudgetMs = Number.isFinite(budgetEnv) && budgetEnv > 0 ? budgetEnv : RUN_BUDGET_MS_DEFAULT;

  // Paginated sweep (cursor over __name__) instead of a single hard-capped
  // read: with one limit(N) query, task N+1 was silently never checked.
  const taskDocs = [];
  const taskCollectionByPath = new Map();
  try {
    for (const collectionName of ["tasks", "privateTasks"]) {
      let lastDoc = null;
      for (let page = 0; page < MAX_SWEEP_PAGES; page += 1) {
        let query = db.collection(collectionName)
          .where("status", "==", "in-progress")
          .orderBy("__name__")
          .limit(SWEEP_PAGE_SIZE);
        if (lastDoc) query = query.startAfter(lastDoc);
        const snap = await query.get();
        taskDocs.push(...snap.docs);
        snap.docs.forEach((doc) => taskCollectionByPath.set(doc.ref.path, collectionName));
        if (snap.docs.length < SWEEP_PAGE_SIZE) break;
        lastDoc = snap.docs[snap.docs.length - 1];
        if (page === MAX_SWEEP_PAGES - 1) {
          console.warn(`agent-monitor: ${collectionName} sweep capped at ${taskDocs.length} tasks`);
        }
      }
    }
  } catch (error) {
    console.error("agent-monitor: failed to load tasks", error);
    return response.status(500).json({ error: "Failed to load tasks" });
  }

  // Per-run caches: each project/user doc is read at most once per sweep.
  const projectCache = new Map();
  async function getProject(id) {
    if (!id) return null;
    if (!projectCache.has(id)) {
      try {
        const snap = await db.collection("projects").doc(id).get();
        projectCache.set(id, snap.exists ? snap.data() : null);
      } catch (error) {
        console.error("agent-monitor: project load failed", id, error);
        projectCache.set(id, null);
      }
    }
    return projectCache.get(id);
  }

  const userCache = new Map();
  async function getUser(uid) {
    if (!uid) return null;
    if (!userCache.has(uid)) {
      try {
        const snap = await db.collection("users").doc(uid).get();
        userCache.set(uid, snap.exists ? snap.data() : null);
      } catch (error) {
        console.error("agent-monitor: user load failed", uid, error);
        userCache.set(uid, null);
      }
    }
    return userCache.get(uid);
  }

  // Email → uid lookups repeat across tasks (assignee resolution + display
  // names); one query per distinct email per run is enough.
  const emailUidCache = new Map();
  async function resolveUidByEmail(email) {
    if (!emailUidCache.has(email)) {
      try {
        const q = await db.collection("users").where("email", "==", email).limit(1).get();
        emailUidCache.set(email, q.empty ? null : q.docs[0].id);
      } catch (error) {
        console.error("agent-monitor: email resolve failed", email, error);
        emailUidCache.set(email, null);
      }
    }
    return emailUidCache.get(email);
  }

  let scanned = 0;
  let eventsCount = 0;
  let aiAttempts = 0;
  let aiMessages = 0;
  let truncated = false;
  // Run-level outboxes: Telegram/push уходят ПОСЛЕ обхода, чтобы дайджест
  // видел все сообщения получателя за прогон (лента пишется в транзакциях).
  const telegramOutbox = [];
  const pushOutbox = [];
  const noteIndex = []; // { noteId, uid, type } — для отметок о доставке

  for (const taskDoc of taskDocs) {
    if (Date.now() - startedAt >= runBudgetMs) {
      truncated = true;
      console.warn("agent-monitor: run budget exceeded, new claims stopped", { scanned, remaining: taskDocs.length - scanned });
      break;
    }
    scanned += 1;
    try {
      const task = taskDoc.data();
      const taskCollection = taskCollectionByPath.get(taskDoc.ref.path) || "tasks";
      const events = classifyTask(task, now);
      if (events.length === 0) continue;

      const project = await getProject(task.projectId);
      const projectName = project?.name || null;
      // Tenant guard for recipients below: the project is the canonical tenant
      // boundary. The task's own organizationId can be missing or stale on old
      // docs, so it is used only for orphan tasks whose project no longer
      // exists.
      const projectOrgId = project?.organizationId || null;
      const taskFieldOrgId = task.organizationId || null;
      const taskOrgId = projectOrgId || taskFieldOrgId || null;
      if (projectOrgId && taskFieldOrgId && projectOrgId !== taskFieldOrgId) {
        console.warn("agent-monitor: task organizationId differs from project organizationId; using project org", { taskId: taskDoc.id });
      }
      if (!taskOrgId) {
        console.warn("agent-monitor: task without verifiable org skipped", taskDoc.id);
        continue;
      }

      // Recipients: assignees by uid (legacy assigneeEmail fallback) + creator.
      let uids = Array.isArray(task.assigneeIds) ? task.assigneeIds.filter(Boolean) : [];
      if (uids.length === 0 && task.assigneeEmail) {
        const emails = String(task.assigneeEmail).toLowerCase().split(",").map((e) => e.trim()).filter(Boolean);
        for (const email of emails) {
          const uid = await resolveUidByEmail(email);
          if (uid) uids.push(uid);
        }
      }
      if (task.createdByUid) uids.push(task.createdByUid);
      // Доп. постановщики получают те же события, что и создатель задачи
      if (Array.isArray(task.coCreatorIds)) uids.push(...task.coCreatorIds.filter(Boolean));
      uids = [...new Set(uids)];
      if (uids.length === 0) continue;
      const assigneeNames = await getTaskAssigneeNames(task, taskOrgId);

      const recipients = [];
      for (const uid of uids) {
        const user = await getUser(uid);
        if (!user) continue; // deleted account — nothing to deliver to
        // Cross-tenant guard: when the task's org is known, the recipient
        // must belong to it (stale assigneeIds / manually-edited docs).
        if (taskOrgId && user.organizationId !== taskOrgId) {
          console.warn("agent-monitor: recipient outside task org skipped", { uid, taskId: taskDoc.id });
          continue;
        }
        recipients.push({ ...user, uid, telegramChatId: user.telegramChatId || null });
      }

      if (recipients.length === 0) continue;

      // Network/LLM work must never happen inside a Firestore transaction.
      // The model produces advice only; the transaction below always rebuilds
      // the factual part from the fresh task snapshot. Шаблонный fallback
      // готовится для ВСЕХ типов событий; LLM — только для AI_ADVICE_EVENT_TYPES.
      const preparedAdvice = new Map();
      for (const event of events) {
        if (!AI_ADVICE_EVENT_TYPES.has(event.type)) {
          preparedAdvice.set(event.type, { advice: fallbackAgentAdvice(event.type), source: "template" });
          continue;
        }
        const canCallAi = Boolean(process.env.OPENROUTER_API_KEY)
          && aiAttempts < MAX_AI_ENRICHMENTS_PER_RUN;
        if (canCallAi) aiAttempts += 1;
        preparedAdvice.set(event.type, await generateAgentAdvice({
          apiKey: canCallAi ? process.env.OPENROUTER_API_KEY : "",
          eventType: event.type,
          title: task.title,
          projectName,
          description: task.description,
          subStatus: task.subStatus,
        }));
      }

      const claim = await db.runTransaction(async (tx) => {
        const freshSnap = await tx.get(taskDoc.ref);
        if (!freshSnap.exists) return { events: [], telegramQueue: [], pushQueue: [], notes: [], aiMessages: 0 };
        const freshTask = freshSnap.data() || {};
        const freshEvents = classifyTask(freshTask, now);
        if (freshEvents.length === 0) return { events: [], telegramQueue: [], pushQueue: [], notes: [], aiMessages: 0 };

        const flagUpdates = {};
        const telegramQueue = [];
        const pushQueue = []; // мобильные push (roadmap Этап 3) — всем получателям
        const notes = [];
        let claimedAiMessages = 0;
        const originalAssigneeIds = (Array.isArray(task.assigneeIds) ? task.assigneeIds : []).filter(Boolean).sort();
        const freshAssigneeIds = (Array.isArray(freshTask.assigneeIds) ? freshTask.assigneeIds : []).filter(Boolean).sort();
        const assigneesUnchanged = JSON.stringify(originalAssigneeIds) === JSON.stringify(freshAssigneeIds)
          && String(freshTask.assigneeEmail || "") === String(task.assigneeEmail || "")
          && String(freshTask.assignee || "") === String(task.assignee || "");
        for (const event of freshEvents) {
          const taskTitle = freshTask.title || task.title || "Без названия";
          const baseText = buildEventText(event.type, {
            title: taskTitle,
            projectName,
            deadline: freshTask.deadline || task.deadline,
            // Never publish a stale name if assignment changed between the
            // initial read and the transactional claim.
            assigneeNames: assigneesUnchanged ? assigneeNames : [],
            today: mskDateString(now),
          });
          const telegramBaseText = buildTelegramEventText(event.type, {
            title: taskTitle,
            projectName,
            deadline: freshTask.deadline || task.deadline,
            assigneeNames: assigneesUnchanged ? assigneeNames : [],
            today: mskDateString(now),
          });
          const adviceResult = preparedAdvice.get(event.type);
          const text = adviceResult
            ? appendAgentAdvice(baseText, adviceResult.advice)
            : baseText;
          const telegramText = adviceResult
            ? appendTelegramAdvice(telegramBaseText, adviceResult.advice)
            : telegramBaseText;
          if (adviceResult?.source === "ai") claimedAiMessages += 1;

          for (const recipient of recipients) {
            const noteRef = db.collection("agentNotifications").doc();
            tx.set(noteRef, {
              uid: recipient.uid,
              organizationId: taskOrgId,
              taskId: taskDoc.id,
              projectId: freshTask.projectId || task.projectId || null,
              taskCollection,
              type: event.type,
              text,
              generatedBy: adviceResult?.source === "ai" ? "ai_agent" : "rules",
              createdAt: FieldValue.serverTimestamp(),
              readAt: null,
            });
            notes.push({ noteId: noteRef.id, uid: recipient.uid, type: event.type });
            if (recipient.telegramChatId) {
              telegramQueue.push({
                chatId: recipient.telegramChatId,
                text: telegramText,
                type: event.type,
                title: taskTitle,
                taskId: taskDoc.id,
                projectId: freshTask.projectId || task.projectId || null,
                organizationId: taskOrgId,
                taskCollection,
                noteId: noteRef.id,
              });
            }
            pushQueue.push({
              uid: recipient.uid,
              user: recipient,
              text,
              type: event.type,
              title: taskTitle,
              taskId: taskDoc.id,
              projectId: freshTask.projectId || task.projectId || null,
              taskCollection,
              noteId: noteRef.id,
            });
          }

          if (event.type === "overdue") flagUpdates.notifiedOverdueOn = mskDateString(now);
          if (event.type === "deadline_today") flagUpdates.notifiedDeadlineTodayOn = mskDateString(now);
          if (event.type === "deadline_tomorrow") flagUpdates.notifiedDeadlineSoonAt = FieldValue.serverTimestamp();
          if (event.type === "not_taken_1h") flagUpdates.notifiedNotTakenAt = FieldValue.serverTimestamp();
          if (event.type === "unassigned_1h") flagUpdates.notifiedUnassignedAt = FieldValue.serverTimestamp();
        }

        tx.update(taskDoc.ref, flagUpdates);
        return { events: freshEvents, telegramQueue, pushQueue, notes, aiMessages: claimedAiMessages };
      });
      if (claim.events.length === 0) continue;
      eventsCount += claim.events.length;
      aiMessages += claim.aiMessages || 0;
      telegramOutbox.push(...claim.telegramQueue);
      pushOutbox.push(...claim.pushQueue);
      noteIndex.push(...claim.notes);
    } catch (error) {
      // One broken task must not kill the whole sweep.
      console.error("agent-monitor: task sweep failed", taskDoc.id, error);
    }
  }

  // --- Доставка (после всех транзакций): дайджест-агрегация по получателю ---
  let telegramSent = 0;
  let telegramFailed = 0;
  const telegramPlan = planAggregatedMessages(telegramOutbox, (i) => `${i.chatId}${i.type}`).map((entry) => {
    const first = entry.items[0];
    return {
      chatId: first.chatId,
      text: entry.digest
        ? buildTelegramDigestText(first.type, { count: entry.items.length, titles: entry.items.map((i) => i.title) })
        : first.text,
      taskId: entry.digest ? null : first.taskId,
      projectId: entry.digest ? null : first.projectId,
      organizationId: first.organizationId,
      taskCollection: entry.digest ? null : first.taskCollection,
      items: entry.items,
    };
  });
  // Пул по TELEGRAM_SEND_POOL: hung/refused send не должен ни останавливать
  // прогон (у sendTelegramMessage свой таймаут), ни падать молча.
  for (let i = 0; i < telegramPlan.length; i += TELEGRAM_SEND_POOL) {
    const chunk = telegramPlan.slice(i, i + TELEGRAM_SEND_POOL);
    const results = await Promise.allSettled(chunk.map((message) => sendTelegramMessage(message.chatId, message.text, {
      parseMode: "HTML",
      taskId: message.taskId,
      projectId: message.projectId,
      organizationId: message.organizationId,
      taskCollection: message.taskCollection,
      linkToProjectMan: true,
    })));
    results.forEach((result, index) => {
      const value = result.status === "fulfilled" ? result.value : null;
      const ok = result.status === "fulfilled" && (!value || value.ok !== false);
      if (ok) {
        telegramSent += 1;
      } else {
        telegramFailed += 1;
        console.error("agent-monitor: telegram send failed", chunk[index].chatId, result.reason || value);
      }
      for (const item of chunk[index].items) item.telegramOk = ok;
    });
  }

  // Мобильные push тем же получателям (fail-open внутри sendPushToUser)
  let pushSent = 0;
  let pushFailed = 0;
  const pushPlan = planAggregatedMessages(pushOutbox, (i) => `${i.uid}${i.type}`).map((entry) => {
    const first = entry.items[0];
    if (!entry.digest) {
      return {
        uid: first.uid,
        payload: {
          title: PUSH_TITLES[first.type] || "ProjectMan",
          body: first.text,
          data: { taskId: first.taskId, projectId: first.projectId, taskCollection: first.taskCollection },
        },
        items: entry.items,
      };
    }
    const count = entry.items.length;
    return {
      uid: first.uid,
      payload: {
        title: `${PUSH_DIGEST_TITLES[first.type] || "Сводка задач"}: ${count}`,
        body: buildDigestText(first.type, { count, titles: entry.items.map((i) => i.title) }),
        data: { digestType: first.type },
      },
      items: entry.items,
    };
  });
  const pushResults = await Promise.allSettled(pushPlan.map((message) => sendPushToUser(message.uid, message.payload)));
  pushResults.forEach((result, index) => {
    const ok = result.status === "fulfilled";
    if (ok) {
      pushSent += 1;
    } else {
      pushFailed += 1;
      console.error("agent-monitor: push send failed", pushPlan[index].uid, result.reason);
    }
    for (const item of pushPlan[index].items) item.pushOk = ok;
  });

  // Та же агрегация для email: Google-пользователь получает одно письмо-
  // дайджест вместо серии писем, когда однотипных событий больше трёх.
  let emailSent = 0;
  let emailFailed = 0;
  let emailSkipped = 0;
  const emailResults = await Promise.allSettled(pushPlan.map((message) => {
    const first = message.items[0];
    return sendEmailNotification(first.user, {
      title: message.payload.title,
      body: message.payload.body,
      idempotencyKey: first.noteId,
    });
  }));
  emailResults.forEach((result, index) => {
    if (result.status === "fulfilled" && result.value?.sent) {
      emailSent += 1;
      return;
    }
    const reason = result.status === "fulfilled" ? result.value?.reason : "unexpected-error";
    if (["provider-error", "transport-error", "timeout", "unexpected-error"].includes(reason)) {
      emailFailed += 1;
      console.error("agent-monitor: email send failed", pushPlan[index].uid, result.status === "rejected" ? result.reason : reason);
    } else {
      emailSkipped += 1;
    }
  });

  // Отметки о доставке на записях ленты: флаги антиспама ставятся в транзакции
  // ДО факта доставки, поэтому сбой Telegram/push фиксируем здесь — best-effort,
  // никогда не бросаем наружу.
  const noteDelivery = new Map();
  for (const note of noteIndex) noteDelivery.set(note.noteId, { telegramFailed: false, pushFailed: false });
  for (const item of telegramOutbox) {
    if (item.telegramOk === false && noteDelivery.has(item.noteId)) noteDelivery.get(item.noteId).telegramFailed = true;
  }
  for (const item of pushOutbox) {
    if (item.pushOk === false && noteDelivery.has(item.noteId)) noteDelivery.get(item.noteId).pushFailed = true;
  }
  const deliveryUpdates = [];
  for (const [noteId, status] of noteDelivery) {
    const payload = status.telegramFailed || status.pushFailed
      ? { deliveryFailed: { telegram: status.telegramFailed, push: status.pushFailed } }
      : { deliveredAt: FieldValue.serverTimestamp() };
    deliveryUpdates.push(
      db.collection("agentNotifications").doc(noteId).update(payload)
        .catch((error) => console.error("agent-monitor: delivery mark failed", noteId, error))
    );
  }
  await Promise.allSettled(deliveryUpdates);

  return response.status(200).json({
    ok: true,
    scanned,
    events: eventsCount,
    aiAttempts,
    aiMessages,
    telegramSent,
    telegramFailed,
    pushSent,
    pushFailed,
    emailSent,
    emailFailed,
    emailSkipped,
    truncated,
    processed: scanned,
    remaining: taskDocs.length - scanned,
  });

  async function getTaskAssigneeNames(task, taskOrgId) {
    const names = [];
    const ids = Array.isArray(task.assigneeIds) ? task.assigneeIds.filter(Boolean) : [];
    for (const uid of ids) {
      const user = await getUser(uid);
      if (taskOrgId && user?.organizationId && user.organizationId !== taskOrgId) continue;
      const name = displayName(user);
      if (name) names.push(name);
    }
    if (names.length === 0 && task.assigneeEmail) {
      const emails = String(task.assigneeEmail).toLowerCase().split(",").map((e) => e.trim()).filter(Boolean);
      for (const email of emails) {
        const uid = await resolveUidByEmail(email);
        const user = uid ? await getUser(uid) : null;
        if (taskOrgId && user?.organizationId && user.organizationId !== taskOrgId) continue;
        const name = displayName(user) || email;
        if (name) names.push(name);
      }
    }
    if (names.length === 0 && task.assignee && task.assignee !== "Не назначен") {
      names.push(task.assignee);
    }
    return [...new Set(names)];
  }
}

function displayName(user) {
  if (!user) return "";
  return user.displayName
    || `${user.firstName || ""} ${user.lastName || ""}`.trim()
    || user.email
    || "";
}
