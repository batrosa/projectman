const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TOKEN}`;

// Firebase Admin for serverless
const FIREBASE_PROJECT_ID = 'projectman-96d3c';
const FIREBASE_API_KEY = process.env.FIREBASE_WEB_API_KEY;

// Firestore REST API helper
async function firestoreGet(collection, docId) {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}?key=${FIREBASE_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
}

async function firestoreUpdate(collection, docId, fields) {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}?updateMask.fieldPaths=${Object.keys(fields).join('&updateMask.fieldPaths=')}&key=${FIREBASE_API_KEY}`;
    
    // Convert to Firestore format
    const firestoreFields = {};
    for (const [key, value] of Object.entries(fields)) {
        if (value === null) {
            firestoreFields[key] = { nullValue: null };
        } else if (typeof value === 'string') {
            firestoreFields[key] = { stringValue: value };
        } else if (typeof value === 'number') {
            firestoreFields[key] = { integerValue: String(value) };
        }
    }
    
    const response = await fetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: firestoreFields })
    });
    return response.ok;
}

async function firestoreDelete(collection, docId) {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}?key=${FIREBASE_API_KEY}`;
    await fetch(url, { method: 'DELETE' });
}

module.exports = async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // POST request - webhook from Telegram
    if (req.method === 'POST') {
        try {
            const { message } = req.body;
            
            if (!message) {
                return res.status(200).send('OK');
            }

            const chatId = message.chat.id;
            const text = (message.text || '').trim().toUpperCase();
            const firstName = message.from?.first_name || 'друг';
            const username = message.from?.username || null;

            let replyText = '';

            if (text === '/START') {
                replyText = `👋 Привет, ${firstName}!\n\nЯ бот для уведомлений ProjectMan.\n\nЧтобы подключить уведомления:\n1. Откройте ProjectMan → Настройки → Telegram\n2. Скопируйте код и отправьте мне\n\nГотово! 🎉`;
            } else if (/^[A-Z0-9]{6}$/.test(text)) {
                // Check if code exists in Firestore
                const codeDoc = await firestoreGet('telegramCodes', text);
                
                if (codeDoc && codeDoc.fields && codeDoc.fields.userId) {
                    const userId = codeDoc.fields.userId.stringValue;
                    
                    // Update user's Telegram info
                    const updated = await firestoreUpdate('users', userId, {
                        telegramChatId: String(chatId),
                        telegramUsername: username || ''
                    });
                    
                    if (updated) {
                        // Delete used code
                        await firestoreDelete('telegramCodes', text);
                        replyText = `✅ Telegram успешно подключен!\n\nТеперь вы будете получать уведомления о:\n📋 Новых задачах\n🔄 Возвратах на доработку\n⏰ Приближении дедлайна\n\nВернитесь в приложение — всё готово!`;
                    } else {
                        replyText = `❌ Ошибка подключения. Попробуйте получить новый код.`;
                    }
                } else {
                    replyText = `❌ Код не найден или устарел.\n\nПолучите новый код в настройках ProjectMan.`;
                }
            } else {
                replyText = `📋 Отправьте мне 6-значный код из настроек ProjectMan.\n\nИли напишите /start для инструкции.`;
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

    return res.status(200).send('Bot is running');
};
