// Server-side proxy for sending Telegram notifications.
// Keeps the bot token out of the browser bundle — the client only ever
// calls this endpoint, never api.telegram.org directly.
import { adminAuth, adminDb } from "../lib/firebase-admin.js";

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

    let callerOrgId;
    try {
        const userDoc = await adminDb().collection('users').doc(decoded.uid).get();
        if (!userDoc.exists) return response.status(403).json({ error: 'Unknown caller' });
        // organizationId may legitimately be null/undefined: a large share of
        // real accounts predate the multi-tenant org feature and were never
        // migrated into an organization. Treat "no org" as its own tenant
        // (null) rather than rejecting outright — the recipient check below
        // still scopes the send to same-tenant users only.
        callerOrgId = userDoc.data().organizationId ?? null;
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

    // Open-relay guard: the caller may only message a Telegram chatId that
    // belongs to a user in their own tenant. Without this, any authenticated
    // user (of any org) could relay arbitrary text to any chatId that happens
    // to exist in the users collection — this endpoint was previously
    // reachable with no auth at all, so this check plus the idToken
    // requirement above together close that hole. "Tenant" includes the
    // legacy no-org case (organizationId null/undefined on both sides), so
    // pre-org accounts can still notify each other, e.g. self-assignment.
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
    const recipientDoc = recipientSnap.empty ? null : recipientSnap.docs[0];
    const recipientOrgId = recipientDoc ? (recipientDoc.data().organizationId ?? null) : undefined;
    if (!recipientDoc || recipientOrgId !== callerOrgId) {
        return response.status(403).json({ ok: false, error: 'Recipient not in your organization' });
    }

    const parseMode = body.parseMode ? String(body.parseMode) : undefined;

    try {
        const telegramResponse = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text.slice(0, 3900),
                ...(parseMode ? { parse_mode: parseMode } : {})
            })
        });

        let telegramBody = null;
        try {
            telegramBody = await telegramResponse.json();
        } catch {
            telegramBody = null;
        }

        if (!telegramResponse.ok || !telegramBody?.ok) {
            return response.status(telegramResponse.ok ? 502 : telegramResponse.status).json({
                ok: false,
                error: 'Telegram send failed',
                errorCode: telegramBody?.error_code || telegramResponse.status,
                description: telegramBody?.description || telegramResponse.statusText || 'Unknown Telegram error'
            });
        }

        return response.status(200).json({ ok: true, messageId: telegramBody.result?.message_id || null });
    } catch (error) {
        console.error('Telegram send failed:', error);
        return response.status(502).json({ ok: false, error: 'Failed to reach Telegram' });
    }
}
