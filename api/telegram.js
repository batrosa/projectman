// Vercel Serverless Function for Telegram notifications
const TELEGRAM_BOT_TOKEN = '8318306872:AAFQh2-XtMSMTe6StxJNMdy29l0UzbxD600';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

export default async function handler(req, res) {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { action, chatId, message, code } = req.body;

        // Action: send message
        if (action === 'send') {
            if (!chatId || !message) {
                return res.status(400).json({ error: 'chatId and message required' });
            }

            const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: message,
                    parse_mode: 'HTML'
                })
            });

            const result = await response.json();
            
            if (!result.ok) {
                console.error('Telegram API error:', result);
                return res.status(400).json({ error: result.description });
            }

            return res.status(200).json({ success: true });
        }

        // Action: verify code (get updates to find user)
        if (action === 'verify') {
            if (!code) {
                return res.status(400).json({ error: 'code required' });
            }

            // Get recent messages to the bot
            const response = await fetch(`${TELEGRAM_API}/getUpdates?limit=100`);
            const result = await response.json();

            if (!result.ok) {
                return res.status(400).json({ error: 'Failed to get updates' });
            }

            // Find message with the code
            const updates = result.result || [];
            for (const update of updates.reverse()) {
                const msg = update.message;
                if (msg && msg.text && msg.text.includes(code)) {
                    return res.status(200).json({
                        success: true,
                        chatId: msg.chat.id,
                        firstName: msg.from.first_name,
                        username: msg.from.username
                    });
                }
            }

            return res.status(404).json({ error: 'Code not found. Please send the code to the bot.' });
        }

        return res.status(400).json({ error: 'Invalid action' });

    } catch (error) {
        console.error('Telegram API error:', error);
        return res.status(500).json({ error: error.message });
    }
}
