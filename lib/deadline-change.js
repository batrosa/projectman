import { adminAuth, adminDb } from "./firebase-admin.js";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { sendTelegramMessage } from "./telegram-send.js";
import { sendPushToUser } from "./push-send.js";
import { sendEmailNotification } from "./email-send.js";
import { formatIsoDayRu } from "./date-display.js";

const MAX_BODY_BYTES = 32 * 1024;
const MAX_COMMENT = 2000;
const ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDay(value) {
  if (!DATE_RE.test(String(value || ""))) return false;
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

export function canUserViewProject(user, projectId) {
  const allowed = user?.allowedProjects;
  return !Array.isArray(allowed) || allowed.length === 0 || allowed.includes(projectId);
}

export function canRequestDeadlineChangeForTask(task, callerUid) {
  return Array.isArray(task?.assigneeIds) && task.assigneeIds.includes(callerUid);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") {
    if (Buffer.byteLength(request.body, "utf8") > MAX_BODY_BYTES) throw new Error("too-large");
    return JSON.parse(request.body || "{}");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("too-large");
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

async function deliver(user, { title, plainText, htmlText, data }) {
  if (!user?.uid) return;
  await Promise.allSettled([
    sendPushToUser(user.uid, { title, body: plainText, data }),
    sendEmailNotification(user, {
      title,
      body: plainText,
      idempotencyKey: `${data?.type || "deadline"}-${data?.requestId || data?.taskId || user.uid}-${user.uid}`,
    }),
    user.telegramChatId
      ? sendTelegramMessage(String(user.telegramChatId), htmlText, { parseMode: "HTML" })
      : Promise.resolve(),
  ]);
}

function displayName(user) {
  return String(user?.displayName || user?.name || user?.email || "Пользователь").trim().slice(0, 200);
}

async function requestDeadlineChange({ db, decoded, caller, organizationId, body }) {
  const taskId = String(body.taskId || "").trim();
  const requestedDeadline = String(body.requestedDeadline || "").trim();
  const comment = String(body.comment || "").trim();
  if (!ID_RE.test(taskId)) return { status: 400, error: "Некорректная задача" };
  if (!isValidIsoDay(requestedDeadline)) return { status: 400, error: "Укажите корректный желаемый срок" };
  if (!comment || comment.length > MAX_COMMENT) return { status: 400, error: "Комментарий обязателен (до 2000 символов)" };

  const taskRef = db.collection("tasks").doc(taskId);
  const taskSnap = await taskRef.get();
  if (!taskSnap.exists) return { status: 404, error: "Задача не найдена" };
  const task = taskSnap.data();
  const projectId = String(task.projectId || "");
  if (!ID_RE.test(projectId)) return { status: 409, error: "У задачи не указан проект" };
  const projectSnap = await db.collection("projects").doc(projectId).get();
  if (!projectSnap.exists || projectSnap.data().organizationId !== organizationId) {
    return { status: 403, error: "Нет доступа к задаче" };
  }
  if (!canUserViewProject(caller, projectId)) return { status: 403, error: "Нет доступа к проекту" };
  if (!canRequestDeadlineChangeForTask(task, decoded.uid)) {
    return { status: 403, error: "Запросить перенос может только исполнитель задачи" };
  }
  if (task.status === "done") return { status: 409, error: "Готовую задачу изменить нельзя" };
  const currentDeadline = String(task.deadline || "").slice(0, 10);
  if (!isValidIsoDay(currentDeadline)) return { status: 409, error: "У задачи не установлен текущий срок" };
  if (requestedDeadline <= currentDeadline) return { status: 400, error: "Желаемый срок должен быть позже текущего" };
  const creatorUid = String(task.createdByUid || "").trim();
  if (!ID_RE.test(creatorUid)) return { status: 409, error: "У задачи не указан постановщик" };
  const creatorSnap = await db.collection("users").doc(creatorUid).get();
  if (!creatorSnap.exists || creatorSnap.data().organizationId !== organizationId) {
    return { status: 409, error: "Постановщик задачи больше не состоит в организации" };
  }

  const requestRef = db.collection("deadlineChangeRequests").doc();
  const noteRef = db.collection("agentNotifications").doc();
  const now = Timestamp.now();
  const requesterName = displayName(caller);
  const requestedDeadlineDisplay = formatIsoDayRu(requestedDeadline);
  await db.runTransaction(async (tx) => {
    const freshSnap = await tx.get(taskRef);
    if (!freshSnap.exists) throw Object.assign(new Error("Задача удалена"), { httpStatus: 409 });
    const fresh = freshSnap.data();
    if (fresh.status === "done" || !canRequestDeadlineChangeForTask(fresh, decoded.uid)) {
      throw Object.assign(new Error("Состояние задачи изменилось"), { httpStatus: 409 });
    }
    if (String(fresh.deadline || "").slice(0, 10) !== currentDeadline) {
      throw Object.assign(new Error("Срок задачи уже изменился"), { httpStatus: 409 });
    }
    if (fresh.deadlineChangeRequest?.id) {
      throw Object.assign(new Error("По задаче уже есть ожидающий запрос"), { httpStatus: 409 });
    }
    const record = {
      organizationId,
      projectId,
      taskId,
      taskTitle: String(fresh.title || "Без названия").slice(0, 300),
      currentDeadline,
      requestedDeadline,
      comment,
      requestedByUid: decoded.uid,
      requestedByName: requesterName,
      createdByUid: creatorUid,
      status: "pending",
      requestedAt: now,
    };
    tx.create(requestRef, record);
    tx.update(taskRef, { deadlineChangeRequest: { id: requestRef.id, ...record } });
    tx.create(noteRef, {
      uid: creatorUid,
      organizationId,
      projectId,
      taskId,
      requestId: requestRef.id,
      type: "deadline_change_requested",
      text: `${requesterName} просит перенести срок задачи «${record.taskTitle}» на ${requestedDeadlineDisplay}.`,
      createdAt: now,
      readAt: null,
    });
  });

  const creator = { uid: creatorUid, ...creatorSnap.data() };
  const taskTitle = String(task.title || "Без названия");
  // Все постановщики: создатель + доп. постановщики (в той же организации)
  const recipients = [creator];
  const coCreatorUids = [...new Set((Array.isArray(task.coCreatorIds) ? task.coCreatorIds : [])
    .filter((uid) => ID_RE.test(String(uid || "")) && uid !== creatorUid))];
  for (const uid of coCreatorUids) {
    const snap = await db.collection("users").doc(uid).get();
    if (snap.exists && snap.data().organizationId === organizationId) {
      recipients.push({ uid, ...snap.data() });
      // Лента уведомлений для доп. постановщика (создателю запись создана в транзакции)
      await db.collection("agentNotifications").add({
        uid,
        organizationId,
        projectId,
        taskId,
        requestId: requestRef.id,
        type: "deadline_change_requested",
        text: `${requesterName} просит перенести срок задачи «${String(task.title || "Без названия").slice(0, 300)}» на ${requestedDeadlineDisplay}.`,
        createdAt: Timestamp.now(),
        readAt: null,
      });
    }
  }
  await Promise.allSettled(recipients.map((recipient) => deliver(recipient, {
    title: "Запрос переноса срока",
    plainText: `${requesterName} просит перенести «${taskTitle}» на ${requestedDeadlineDisplay}.`,
    htmlText: `<b>Запрос переноса срока</b>\nЗадача: ${escapeHtml(taskTitle)}\nИсполнитель: ${escapeHtml(requesterName)}\nНовый срок: <b>${escapeHtml(requestedDeadlineDisplay)}</b>\nПричина: ${escapeHtml(comment)}`,
    data: { type: "deadline_change_requested", taskId, projectId, requestId: requestRef.id },
  })));
  return { status: 200, data: { ok: true, requestId: requestRef.id } };
}

async function decideDeadlineChange({ db, decoded, caller, organizationId, body }) {
  const requestId = String(body.requestId || "").trim();
  const decision = String(body.decision || "").trim();
  if (!ID_RE.test(requestId) || !["approve", "reject"].includes(decision)) {
    return { status: 400, error: "Некорректное решение" };
  }
  const requestRef = db.collection("deadlineChangeRequests").doc(requestId);
  const initial = await requestRef.get();
  if (!initial.exists) return { status: 404, error: "Запрос не найден" };
  const requestData = initial.data();
  const taskId = String(requestData.taskId || "");
  const taskRef = db.collection("tasks").doc(taskId);
  // Решение принимает постановщик: создатель задачи ИЛИ доп. постановщик
  const taskInitial = await taskRef.get();
  const isCoCreatorDecider = taskInitial.exists
    && Array.isArray(taskInitial.data().coCreatorIds)
    && taskInitial.data().coCreatorIds.includes(decoded.uid);
  if (requestData.organizationId !== organizationId
    || (requestData.createdByUid !== decoded.uid && !isCoCreatorDecider)) {
    return { status: 403, error: "Решение может принять только постановщик задачи" };
  }
  const requesterUid = String(requestData.requestedByUid || "");
  const requesterSnap = ID_RE.test(requesterUid) ? await db.collection("users").doc(requesterUid).get() : null;
  const now = Timestamp.now();
  const noteRef = db.collection("agentNotifications").doc();
  await db.runTransaction(async (tx) => {
    const [freshRequestSnap, taskSnap] = await Promise.all([tx.get(requestRef), tx.get(taskRef)]);
    if (!freshRequestSnap.exists || !taskSnap.exists) throw Object.assign(new Error("Запрос или задача удалены"), { httpStatus: 409 });
    const freshRequest = freshRequestSnap.data();
    const task = taskSnap.data();
    if (freshRequest.status !== "pending" || task.deadlineChangeRequest?.id !== requestId) {
      throw Object.assign(new Error("Запрос уже обработан"), { httpStatus: 409 });
    }
    const deciderIsTaskCreator = freshRequest.createdByUid === decoded.uid
      || (Array.isArray(task.coCreatorIds) && task.coCreatorIds.includes(decoded.uid));
    if (!deciderIsTaskCreator || freshRequest.organizationId !== organizationId) {
      throw Object.assign(new Error("Нет прав на решение"), { httpStatus: 403 });
    }
    const taskUpdate = { deadlineChangeRequest: FieldValue.delete() };
    if (decision === "approve") {
      taskUpdate.deadline = freshRequest.requestedDeadline;
      taskUpdate.reminderSent = false;
    }
    tx.update(taskRef, taskUpdate);
    tx.update(requestRef, {
      status: decision === "approve" ? "approved" : "rejected",
      decidedAt: now,
      decidedByUid: decoded.uid,
      decidedByName: displayName(caller),
    });
    if (ID_RE.test(requesterUid)) {
      tx.create(noteRef, {
        uid: requesterUid,
        organizationId,
        projectId: freshRequest.projectId,
        taskId,
        requestId,
        type: decision === "approve" ? "deadline_change_approved" : "deadline_change_rejected",
        text: decision === "approve"
          ? `Перенос срока задачи «${freshRequest.taskTitle}» подтверждён: новый срок ${formatIsoDayRu(freshRequest.requestedDeadline)}.`
          : `Перенос срока задачи «${freshRequest.taskTitle}» отклонён. Срок не изменён.`,
        createdAt: now,
        readAt: null,
      });
    }
  });
  if (requesterSnap?.exists && requesterSnap.data().organizationId === organizationId) {
    const requester = { uid: requesterUid, ...requesterSnap.data() };
    const approved = decision === "approve";
    const plainText = approved
      ? `Перенос срока «${requestData.taskTitle}» подтверждён: ${formatIsoDayRu(requestData.requestedDeadline)}.`
      : `Перенос срока «${requestData.taskTitle}» отклонён. Текущий срок сохранён.`;
    await deliver(requester, {
      title: approved ? "Срок перенесён" : "Перенос срока отклонён",
      plainText,
      htmlText: `<b>${approved ? "Срок перенесён" : "Перенос срока отклонён"}</b>\nЗадача: ${escapeHtml(requestData.taskTitle)}\n${approved ? `Новый срок: <b>${escapeHtml(formatIsoDayRu(requestData.requestedDeadline))}</b>` : `Срок остаётся: <b>${escapeHtml(formatIsoDayRu(requestData.currentDeadline))}</b>`}`,
      data: { type: approved ? "deadline_change_approved" : "deadline_change_rejected", taskId, projectId: requestData.projectId, requestId },
    });
  }
  return { status: 200, data: { ok: true, decision } };
}

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }
  const token = String(request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return response.status(401).json({ error: "Unauthorized" });
  let decoded;
  try { decoded = await adminAuth().verifyIdToken(token); }
  catch { return response.status(401).json({ error: "Unauthorized" }); }
  let body;
  try { body = await parseJsonBody(request); }
  catch { return response.status(400).json({ error: "Invalid JSON body" }); }
  const db = adminDb();
  try {
    const callerSnap = await db.collection("users").doc(decoded.uid).get();
    if (!callerSnap.exists) return response.status(403).json({ error: "Unknown caller" });
    const caller = callerSnap.data();
    const organizationId = String(caller.organizationId || "");
    if (!organizationId) return response.status(403).json({ error: "No organization" });
    const result = body.action === "request"
      ? await requestDeadlineChange({ db, decoded, caller, organizationId, body })
      : body.action === "decide"
        ? await decideDeadlineChange({ db, decoded, caller, organizationId, body })
        : { status: 400, error: "Unknown action" };
    return response.status(result.status).json(result.data || { error: result.error });
  } catch (error) {
    const status = Number(error?.httpStatus) || 500;
    if (status === 500) console.error("deadline-change:", error);
    return response.status(status).json({ error: status === 500 ? "Не удалось обработать запрос" : String(error.message || "Ошибка") });
  }
}
