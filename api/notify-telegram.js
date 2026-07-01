// Server-side proxy for sending Telegram notifications.
// Keeps the bot token out of the browser bundle — the client only ever
// calls this endpoint, never api.telegram.org directly.
async function parseJsonBody(request) {
    if (request.body && typeof request.body === 'object') return request.body;
    if (typeof request.body === 'string') return JSON.parse(request.body || '{}');
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const text = Buffer.concat(chunks).toString('utf8');
    return text ? JSON.parse(text) : {};
}

module.exports = async (request, response) => {
    if (request.method !== 'POST') {
        response.setHeader('Allow', 'POST');
        return response.status(405).json({ error: 'Method not allowed' });
    }

    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
        return response.status(503).json({ error: 'Telegram is not configured' });
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

        const ok = telegramResponse.ok;
        return response.status(200).json({ ok });
    } catch (error) {
        console.error('Telegram send failed:', error);
        return response.status(502).json({ error: 'Failed to reach Telegram' });
    }
};
