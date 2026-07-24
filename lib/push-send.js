// Отправка мобильных push-уведомлений (roadmap Этап 3).
//
//   событие -> agentNotification -> sendPushToUsers(uids, title, body, data)
//     -> читаем users/{uid}/devices (FCM-токены, записанные iOS/Android)
//     -> firebase-admin messaging: по токенам
//     -> протухшие токены удаляем (unregistered/invalid)
//
// Всегда fail-open: сбой push никогда не должен ломать основное действие
// (создание задачи, монитор и т.д.) — поэтому все внешние вызовы обёрнуты и
// логируются, наружу ошибки не бросаются.
//
// Доставка на iOS требует загруженного APNs-ключа в Firebase Console
// (Project settings -> Cloud Messaging -> Apple app configuration). До этого
// send вернёт ошибку по каждому iOS-токену — она логируется, приложение живёт.

import { getMessaging } from "firebase-admin/messaging";
import { adminDb } from "./firebase-admin.js";

// Коды FCM, при которых токен мёртв и подлежит удалению. Экспортируется для
// юнит-тестов.
export function isDeadTokenError(errorCode) {
  return [
    "messaging/registration-token-not-registered",
    "messaging/invalid-registration-token",
    "messaging/invalid-argument",
  ].includes(String(errorCode || ""));
}

async function tokensForUser(db, uid) {
  try {
    const snap = await db.collection("users").doc(uid).collection("devices").get();
    return snap.docs
      .map((doc) => ({ ref: doc.ref, token: doc.data()?.fcmToken }))
      .filter((d) => typeof d.token === "string" && d.token.length > 0);
  } catch (error) {
    console.error("push-send: devices read failed", uid, error);
    return [];
  }
}

// Отправляет push одному пользователю на все его устройства.
// data — строковые пары для deep-link (taskId/projectId), опционально.
export async function sendPushToUser(uid, { title, body, data = {} }) {
  if (!uid || !body) return { sent: 0 };
  const db = adminDb();
  const devices = await tokensForUser(db, uid);
  if (devices.length === 0) return { sent: 0 };

  const stringData = {};
  for (const [key, value] of Object.entries(data)) {
    if (value !== null && value !== undefined) stringData[key] = String(value);
  }

  let sent = 0;
  let response;
  try {
    response = await getMessaging().sendEachForMulticast({
      tokens: devices.map((d) => d.token),
      notification: { title: title || "ProjectSfera", body: String(body).slice(0, 500) },
      data: stringData,
      apns: {
        headers: {
          "apns-push-type": "alert",
          "apns-priority": "10",
        },
        payload: { aps: { sound: "default" } },
      },
    });
  } catch (error) {
    console.error("push-send: multicast failed", uid, error);
    return { sent: 0 };
  }

  const deletions = [];
  response.responses.forEach((res, index) => {
    if (res.success) {
      sent += 1;
      return;
    }
    const code = res.error?.code;
    if (isDeadTokenError(code)) {
      deletions.push(devices[index].ref.delete().catch(() => {}));
    } else {
      // Типично до загрузки APNs-ключа в Firebase — оставляем токен, логируем.
      console.error("push-send: send failed", uid, code || res.error?.message);
    }
  });
  await Promise.allSettled(deletions);
  return { sent };
}

// Пачкой нескольким получателям; ошибки по каждому не всплывают наружу.
export async function sendPushToUsers(uids, payload) {
  const unique = [...new Set((uids || []).filter(Boolean))];
  const results = await Promise.allSettled(unique.map((uid) => sendPushToUser(uid, payload)));
  return results.reduce((total, r) => total + (r.status === "fulfilled" ? r.value.sent : 0), 0);
}
