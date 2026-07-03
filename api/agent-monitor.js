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

// Paginated sweep: pages of 500 up to 20 pages (10k active tasks) — far above
// the real org size, and unlike a single limit() read nothing past the cap is
// silently skipped until that ceiling.
const SWEEP_PAGE_SIZE = 500;
const MAX_SWEEP_PAGES = 20;

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

  // Paginated sweep (cursor over __name__) instead of a single hard-capped
  // read: with one limit(N) query, task N+1 was silently never checked.
  const taskDocs = [];
  try {
    let lastDoc = null;
    for (let page = 0; page < MAX_SWEEP_PAGES; page += 1) {
      let query = db.collection("tasks")
        .where("status", "==", "in-progress")
        .orderBy("__name__")
        .limit(SWEEP_PAGE_SIZE);
      if (lastDoc) query = query.startAfter(lastDoc);
      const snap = await query.get();
      taskDocs.push(...snap.docs);
      if (snap.docs.length < SWEEP_PAGE_SIZE) break;
      lastDoc = snap.docs[snap.docs.length - 1];
      if (page === MAX_SWEEP_PAGES - 1) {
        console.warn(`agent-monitor: sweep capped at ${taskDocs.length} tasks`);
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

  let scanned = 0;
  let eventsCount = 0;

  for (const taskDoc of taskDocs) {
    scanned += 1;
    try {
      const task = taskDoc.data();
      const events = classifyTask(task, now);
      if (events.length === 0) continue;

      const project = await getProject(task.projectId);
      const projectName = project?.name || null;
      // Tenant guard for recipients below: a broken/hand-written task must not
      // leak a notification into another organization.
      const taskOrgId = task.organizationId || project?.organizationId || null;

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
          // Cross-tenant guard: when the task's org is known, the recipient
          // must belong to it (stale assigneeIds / manually-edited docs).
          if (taskOrgId && user.organizationId !== taskOrgId) {
            console.warn("agent-monitor: recipient outside task org skipped", { uid, taskId: taskDoc.id });
            continue;
          }
          const noteRef = db.collection("agentNotifications").doc();
          batch.set(noteRef, {
            uid,
            organizationId: taskOrgId,
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

      // Parallel + logged: a hung/refused Telegram send must neither stall the
      // sweep (sendTelegramMessage now has its own timeout) nor fail silently.
      const sendResults = await Promise.allSettled(
        telegramQueue.map((message) => sendTelegramMessage(message.chatId, message.text))
      );
      sendResults.forEach((result, index) => {
        const value = result.status === "fulfilled" ? result.value : null;
        if (result.status === "rejected" || (value && value.ok === false)) {
          console.error("agent-monitor: telegram send failed", telegramQueue[index].chatId, result.reason || value);
        }
      });
    } catch (error) {
      // One broken task must not kill the whole sweep.
      console.error("agent-monitor: task sweep failed", taskDoc.id, error);
    }
  }

  return response.status(200).json({ ok: true, scanned, events: eventsCount });
}
