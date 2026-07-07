// Уведомление участнику о событии задачи (единая серверная точка):
//   Telegram (если у получателя привязан чат) + мобильный push + запись в
//   ленту agentNotifications (раздел «Уведомления» в приложениях), когда
//   передан event.type. Держит bot token вне клиента.
//
// Обратная совместимость: старый вызов {chatId, text} работает как раньше
// (telegram + push, без записи в ленту). Новое: получателя можно задать
// recipientUid (для участников БЕЗ Telegram), event {type, taskId, projectId}
// добавляет запись в ленту и типизированный push с deep-link-данными.
import { adminAuth, adminDb } from "../lib/firebase-admin.js";
import { FieldValue } from "firebase-admin/firestore";
import { sendTelegramMessage } from "../lib/telegram-send.js";
import { sendPushToUser } from "../lib/push-send.js";

// Типы событий задачи → заголовок системного push
export const TASK_EVENT_TITLES = {
    task_created: "Новая задача",
    task_completed: "Задача на проверке",
    task_revision: "Возврат на доработку",
    task_done: "Задача принята",
};

async function parseJsonBody(request) {
    if (request.body && typeof request.body === 'object') return request.body;
    if (typeof request.body === 'string') return JSON.parse(request.body || '{}');
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
}

export default async function handler(request, response) {
    if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return response.status(405).json({ error: 'Method not allowed' });
    }

    const idToken = (request.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!idToken) return response.status(401).json({ error: 'Unauthorized' });

    let decoded;
    try {
        // Mirrors the auth pattern in api/agent-chat.js: verifyIdToken() with
        // no options validates signature, issuer/audience and expiry against
        // this Firebase project's defaults.
        decoded = await adminAuth().verifyIdToken(idToken);
    } catch {
        return response.status(401).json({ error: 'Unauthorized' });
    }

    let callerOrgId = null;
    try {
        const userDoc = await adminDb().collection('users').doc(decoded.uid).get();
        if (!userDoc.exists) return response.status(403).json({ error: 'Unknown caller' });
        callerOrgId = userDoc.data().organizationId || null;
    } catch (error) {
        console.error('notify-telegram: failed to load caller user doc', error);
        return response.status(500).json({ ok: false, error: 'Failed to verify caller' });
    }

    let body;
    try {
        body = await parseJsonBody(request);
    } catch {
        return response.status(400).json({ error: 'Invalid JSON body' });
    }

    const chatId = String(body.chatId || '').trim();
    const recipientUid = String(body.recipientUid || '').trim();
    const text = String(body.text || '').trim();
    if ((!chatId && !recipientUid) || !text) {
        return response.status(400).json({ error: 'text and chatId or recipientUid are required' });
    }
    if (recipientUid && !/^[A-Za-z0-9_-]{1,160}$/.test(recipientUid)) {
        return response.status(400).json({ error: 'Invalid recipientUid' });
    }

    // Anti-open-relay + tenant isolation: получатель обязан быть
    // зарегистрированным пользователем В ОРГАНИЗАЦИИ вызывающего. Каждое
    // легитимное уведомление адресовано участнику (исполнитель, постановщик,
    // сам вызывающий) — это правильный скоуп, и он не даёт авторизованному
    // пользователю рассылать текст участникам ЧУЖИХ организаций.
    let recipientDoc;
    try {
        if (recipientUid) {
            const snap = await adminDb().collection('users').doc(recipientUid).get();
            recipientDoc = snap.exists ? { id: recipientUid, data: snap.data() } : null;
        } else {
            const snap = await adminDb()
                .collection('users')
                .where('telegramChatId', '==', chatId)
                .limit(1)
                .get();
            recipientDoc = snap.empty ? null : { id: snap.docs[0].id, data: snap.docs[0].data() };
        }
    } catch (error) {
        console.error('notify-telegram: failed to look up recipient', error);
        return response.status(500).json({ ok: false, error: 'Failed to verify recipient' });
    }
    if (!recipientDoc) {
        return response.status(403).json({ ok: false, error: 'Unknown recipient' });
    }
    const recipientOrgId = recipientDoc.data.organizationId || null;
    if (!callerOrgId || recipientOrgId !== callerOrgId) {
        return response.status(403).json({ ok: false, error: 'Recipient is not in your organization' });
    }

    const parseMode = body.parseMode ? String(body.parseMode) : undefined;
    const plainText = text.replace(/<[^>]+>/g, '');

    // Событие задачи: запись в ленту (раздел «Уведомления») + типизированный push
    const event = body.event && typeof body.event === 'object' ? body.event : null;
    const eventType = event && TASK_EVENT_TITLES[event.type] ? String(event.type) : null;
    const taskId = event && typeof event.taskId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(event.taskId)
        ? event.taskId : null;
    const projectId = event && typeof event.projectId === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(event.projectId)
        ? event.projectId : null;

    if (eventType) {
        try {
            await adminDb().collection('agentNotifications').add({
                uid: recipientDoc.id,
                organizationId: callerOrgId,
                taskId,
                projectId,
                type: eventType,
                text: plainText,
                createdAt: FieldValue.serverTimestamp(),
                readAt: null,
            });
        } catch (error) {
            // Лента — не повод ронять доставку telegram/push
            console.error('notify-telegram: feed write failed', error);
        }
    }

    // Мобильный push (fail-open внутри sendPushToUser)
    try {
        await sendPushToUser(recipientDoc.id, {
            title: eventType ? TASK_EVENT_TITLES[eventType] : 'HoldingMan',
            body: plainText,
            data: {
                ...(taskId ? { taskId } : {}),
                ...(projectId ? { projectId } : {}),
                ...(eventType ? { type: eventType } : {}),
            },
        });
    } catch (error) {
        console.error('notify-telegram: push send failed', error);
    }

    // Telegram — только если чат привязан. Для uid-получателя без Telegram
    // push и лента уже доставлены — это успех, а не 4xx/5xx.
    const targetChatId = chatId || String(recipientDoc.data.telegramChatId || '').trim();
    if (!targetChatId) {
        if (!process.env.TELEGRAM_BOT_TOKEN) {
            return response.status(200).json({ ok: true, messageId: null, telegram: 'skipped' });
        }
        return response.status(200).json({ ok: true, messageId: null, telegram: 'no-chat' });
    }
    if (!process.env.TELEGRAM_BOT_TOKEN) {
        // Токен не настроен: push/лента доставлены, телеграм пропущен
        return response.status(200).json({ ok: true, messageId: null, telegram: 'skipped' });
    }

    // Shared sender (lib/telegram-send). Its rich result lets this endpoint
    // keep the exact response semantics it always had: transport failure →
    // 502; Telegram logical refusal on HTTP 200 → 502; Telegram HTTP error →
    // proxy the upstream status; success → 200 with messageId.
    const result = await sendTelegramMessage(targetChatId, text, { parseMode });

    if (result.ok) {
        return response.status(200).json({ ok: true, messageId: result.messageId || null });
    }
    if (result.transport) {
        console.error('Telegram send failed:', result.error);
        return response.status(502).json({ ok: false, error: 'Failed to reach Telegram' });
    }
    return response.status(result.httpOk ? 502 : result.httpStatus).json({
        ok: false,
        error: 'Telegram send failed',
        errorCode: result.errorCode,
        description: result.description
    });
}
