// api/agent-monitor.js
// Серверный «автопилот» агента: обходит активные задачи и рассылает
// уведомления о сроках — в ленту agentNotifications (колокольчик в приложении)
// и дублем в Telegram — исполнителю(ям) И постановщику задачи.
//
// События (вся логика дат — lib/agent-monitor-core.js, Europe/Moscow):
//   overdue           — просрочена; повторяется РАЗ В ДЕНЬ, пока не закрыта
//                       (решение пользователя), антиспам — notifiedOverdueOn;
//   deadline_tomorrow — остался 1 день; один раз (notifiedDeadlineSoonAt);
//   not_taken_1h      — назначена и >1 часа не взята в работу; один раз
//                       (notifiedNotTakenAt).
//
// Кто будит: Vercel Cron раз в сутки (vercel.json, ~09:00 МСК; Hobby-план не
// умеет чаще) и GitHub Actions раз в час (.github/workflows/agent-monitor.yml).
// Оба шлют Authorization: Bearer ${CRON_SECRET}; Vercel добавляет заголовок
// сам, если env задан. Без/с неверным секретом — 401 (fail closed).
//
// Никакого LLM: чистая проверка дат — быстро, бесплатно, детерминированно.
// Заменяет старые клиентские напоминания (checkReminders), которые работали
// только при открытой вкладке и слали только исполнителю.
import { adminDb } from "../lib/firebase-admin.js";
import { FieldValue } from "firebase-admin/firestore";
import { classifyTask, buildEventText, mskDateString } from "../lib/agent-monitor-core.js";
import { sendTelegramMessage } from "../lib/telegram-send.js";

// Safety cap for one sweep; far above the real org size (see the same pattern
// in api/agent-chat.js context caps).
const MAX_TASKS_PER_SWEEP = 2000;

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const secret = process.env.CRON_SECRET;
  const auth = request.headers.authorization || "";
  if (!secret || auth !== `Bearer ${secret}`) {
    return response.status(401).json({ error: "Unauthorized" });
  }

  const db = adminDb();
  const now = new Date();

  let taskSnap;
  try {
    taskSnap = await db.collection("tasks")
      .where("status", "==", "in-progress")
      .limit(MAX_TASKS_PER_SWEEP)
      .get();
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

  let scanned = 0;
  let eventsCount = 0;

  for (const taskDoc of taskSnap.docs) {
    scanned += 1;
    try {
      const task = taskDoc.data();
      const events = classifyTask(task, now);
      if (events.length === 0) continue;

      const project = await getProject(task.projectId);
      const projectName = project?.name || null;

      // Recipients: assignees by uid (legacy assigneeEmail fallback) + creator.
      let uids = Array.isArray(task.assigneeIds) ? task.assigneeIds.filter(Boolean) : [];
      if (uids.length === 0 && task.assigneeEmail) {
        const emails = String(task.assigneeEmail).toLowerCase().split(",").map((e) => e.trim()).filter(Boolean);
        for (const email of emails) {
          try {
            const q = await db.collection("users").where("email", "==", email).limit(1).get();
            if (!q.empty) uids.push(q.docs[0].id);
          } catch (error) {
            console.error("agent-monitor: assignee email resolve failed", email, error);
          }
        }
      }
      if (task.createdByUid) uids.push(task.createdByUid);
      uids = [...new Set(uids)];
      if (uids.length === 0) continue;

      const batch = db.batch();
      const flagUpdates = {};
      const telegramQueue = [];

      for (const event of events) {
        const text = buildEventText(event.type, {
          title: task.title || "Без названия",
          projectName,
          deadline: task.deadline,
        });

        for (const uid of uids) {
          const user = await getUser(uid);
          if (!user) continue; // deleted account — nothing to deliver to
          const noteRef = db.collection("agentNotifications").doc();
          batch.set(noteRef, {
            uid,
            organizationId: task.organizationId || project?.organizationId || null,
            taskId: taskDoc.id,
            projectId: task.projectId || null,
            type: event.type,
            text,
            createdAt: FieldValue.serverTimestamp(),
            readAt: null,
          });
          if (user.telegramChatId) telegramQueue.push({ chatId: user.telegramChatId, text });
        }

        if (event.type === "overdue") flagUpdates.notifiedOverdueOn = mskDateString(now);
        if (event.type === "deadline_tomorrow") flagUpdates.notifiedDeadlineSoonAt = FieldValue.serverTimestamp();
        if (event.type === "not_taken_1h") flagUpdates.notifiedNotTakenAt = FieldValue.serverTimestamp();
        eventsCount += 1;
      }

      batch.update(taskDoc.ref, flagUpdates);
      // Commit the feed entries + anti-spam flags FIRST: a Telegram failure
      // must not lose the flags (re-spam), and a retried run must not
      // duplicate the feed.
      await batch.commit();

      for (const message of telegramQueue) {
        await sendTelegramMessage(message.chatId, message.text);
      }
    } catch (error) {
      // One broken task must not kill the whole sweep.
      console.error("agent-monitor: task sweep failed", taskDoc.id, error);
    }
  }

  return response.status(200).json({ ok: true, scanned, events: eventsCount });
}
