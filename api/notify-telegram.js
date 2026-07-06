// Server-side proxy for sending Telegram notifications.
// Keeps the bot token out of the browser bundle — the client only ever
// calls this endpoint, never api.telegram.org directly.
import { adminAuth, adminDb } from "../lib/firebase-admin.js";
import { sendTelegramMessage } from "../lib/telegram-send.js";
import { sendPushToUser } from "../lib/push-send.js";

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

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        return response.status(503).json({ error: 'Telegram is not configured' });
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
    const text = String(body.text || '').trim();
    if (!chatId || !text) {
        return response.status(400).json({ error: 'chatId and text are required' });
    }

    // Anti-open-relay + tenant isolation: the caller may only message a Telegram
    // chatId that belongs to a registered ProjectMan user IN THE CALLER'S OWN
    // organization. Every legitimate notification targets an org member (task
    // assignee, task creator, or the caller themselves), so this is the correct
    // scope and stops an authenticated user from relaying text to members of
    // OTHER organizations. (The old "any registered user" rule was a workaround
    // for legacy null-org accounts; the org data is now clean.)
    let recipientSnap;
    try {
        recipientSnap = await adminDb()
            .collection('users')
            .where('telegramChatId', '==', chatId)
            .limit(1)
            .get();
    } catch (error) {
        console.error('notify-telegram: failed to look up recipient', error);
        return response.status(500).json({ ok: false, error: 'Failed to verify recipient' });
    }
    if (recipientSnap.empty) {
        return response.status(403).json({ ok: false, error: 'Unknown recipient' });
    }
    const recipientOrgId = recipientSnap.docs[0].data().organizationId || null;
    if (!callerOrgId || recipientOrgId !== callerOrgId) {
        return response.status(403).json({ ok: false, error: 'Recipient is not in your organization' });
    }

    const parseMode = body.parseMode ? String(body.parseMode) : undefined;

    // Мобильный push тому же получателю (roadmap Этап 3). Fail-open: сбой
    // push не влияет ни на Telegram-доставку, ни на ответ endpoint'а.
    // Тело — тот же текст без HTML-разметки Telegram.
    try {
        await sendPushToUser(recipientSnap.docs[0].id, {
            title: 'HoldingMan',
            body: text.replace(/<[^>]+>/g, ''),
        });
    } catch (error) {
        console.error('notify-telegram: push send failed', error);
    }

    // Shared sender (lib/telegram-send). Its rich result lets this endpoint
    // keep the exact response semantics it always had: transport failure →
    // 502; Telegram logical refusal on HTTP 200 → 502; Telegram HTTP error →
    // proxy the upstream status; success → 200 with messageId.
    const result = await sendTelegramMessage(chatId, text, { parseMode });

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
