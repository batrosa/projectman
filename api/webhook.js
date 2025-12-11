const TOKEN = '8318306872:AAFQh2-XtMSMTe6StxJNMdy29l0UzbxD600';
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

module.exports = async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // GET request - verify code
    if (req.method === 'GET') {
        const code = req.query.code;
        
        if (!code) {
            return res.status(400).json({ error: 'Code required' });
        }
        
        try {
            // Delete webhook temporarily
            await fetch(`${TELEGRAM_API}/deleteWebhook`);
            
            // Get updates
            const response = await fetch(`${TELEGRAM_API}/getUpdates?limit=100`);
            const result = await response.json();
            
            // Restore webhook
            const webhookUrl = `https://${req.headers.host}/api/webhook`;
            await fetch(`${TELEGRAM_API}/setWebhook?url=${encodeURIComponent(webhookUrl)}`);
            
            if (!result.ok) {
                return res.status(400).json({ error: 'Telegram API error' });
            }
            
            // Find message with the code
            const updates = result.result || [];
            for (const update of updates.reverse()) {
                const msg = update.message;
                if (msg && msg.text && msg.text.toUpperCase().includes(code.toUpperCase())) {
                    return res.status(200).json({
                        success: true,
                        chatId: msg.chat.id,
                        firstName: msg.from.first_name,
                        username: msg.from.username
                    });
                }
            }
            
            return res.status(404).json({ error: 'Код не найден. Отправьте код боту и попробуйте снова.' });
        } catch (error) {
            console.error('Verify error:', error);
            return res.status(500).json({ error: error.message });
        }
    }

    // POST request - webhook from Telegram
    if (req.method === 'POST') {
        try {
            const { message } = req.body;
            
            if (!message) {
                return res.status(200).send('OK');
            }

            const chatId = message.chat.id;
            const text = message.text || '';
            const firstName = message.from?.first_name || 'друг';

            let replyText = '';

            if (text === '/start') {
                replyText = `👋 Привет, ${firstName}!\n\nЯ бот для уведомлений ProjectMan.\n\nЧтобы подключить уведомления:\n1. Откройте ProjectMan\n2. Настройки → Telegram\n3. Скопируйте код и отправьте мне\n4. Нажмите "Проверить подключение"`;
            } else if (/^[A-Z0-9]{6}$/.test(text.trim().toUpperCase())) {
                replyText = `✅ Код получен!\n\nТеперь вернитесь в ProjectMan и нажмите кнопку "Проверить подключение".`;
            } else {
                replyText = `📋 Отправьте мне код из настроек ProjectMan для подключения уведомлений.\n\nИли напишите /start для инструкции.`;
            }

            // Send reply
            await fetch(`${TELEGRAM_API}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: replyText,
                    parse_mode: 'HTML'
                })
            });

            return res.status(200).send('OK');
        } catch (error) {
            console.error('Webhook error:', error);
            return res.status(200).send('OK');
        }
    }

    return res.status(405).json({ error: 'Method not allowed' });
};
