const TOKEN = '8318306872:AAFQh2-XtMSMTe6StxJNMdy29l0UzbxD600';

module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        return res.status(200).send('Bot is running');
    }

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
        } else if (/^[A-Z0-9]{6}$/.test(text.trim())) {
            replyText = `✅ Код получен!\n\nТеперь вернитесь в ProjectMan и нажмите кнопку "Проверить подключение".`;
        } else {
            replyText = `📋 Отправьте мне код из настроек ProjectMan для подключения уведомлений.\n\nИли напишите /start для инструкции.`;
        }

        // Send reply
        await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
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
};
