import { adminDb } from "../lib/firebase-admin.js";
import {
    TELEGRAM_LOGIN_SESSION_COLLECTION,
    isValidTelegramLoginCode,
} from "../lib/telegram-bot-login.js";

// Firebase Admin for serverless
const FIREBASE_PROJECT_ID = 'projectman-96d3c';

// Firestore REST API helper
async function firestoreGet(collection, docId, apiKey) {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}?key=${apiKey}`;
    const response = await fetch(url);
    if (!response.ok) return null;
    return await response.json();
}

async function firestoreUpdate(collection, docId, fields, apiKey) {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}?updateMask.fieldPaths=${Object.keys(fields).join('&updateMask.fieldPaths=')}&key=${apiKey}`;
    
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

async function firestoreDelete(collection, docId, apiKey) {
    const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT_ID}/databases/(default)/documents/${collection}/${docId}?key=${apiKey}`;
    await fetch(url, { method: 'DELETE' });
}

export default async function handler(req, res) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const firebaseApiKey = process.env.FIREBASE_WEB_API_KEY;

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    if (!token) {
        console.error('webhook: TELEGRAM_BOT_TOKEN is not configured');
        return res.status(503).json({ error: 'Telegram bot token is not configured' });
    }

    const telegramApi = `https://api.telegram.org/bot${token}`;

    // POST request - webhook from Telegram
    if (req.method === 'POST') {
        try {
            const { message } = req.body;
            
            if (!message) {
                return res.status(200).send('OK');
            }

            const chatId = message.chat.id;
            const rawText = (message.text || '').trim();
            const text = rawText.toUpperCase();
            const firstName = message.from?.first_name || 'друг';
            const username = message.from?.username || null;
            const botLoginMatch = rawText.match(/^\/start(?:@[A-Za-z0-9_]+)?\s+login_([A-Za-z0-9_-]{16,64})$/i);

            let replyText = '';

            if (botLoginMatch) {
                const loginResult = await confirmBotLoginSession(botLoginMatch[1], message);
                if (loginResult.ok) {
                    replyText = `✅ Вход подтвержден.\n\nВернитесь в ProjectMan — окно входа завершится автоматически.`;
                } else {
                    replyText = loginResult.reason === 'server'
                        ? `❌ Не удалось подтвердить вход: сервер временно недоступен. Попробуйте ещё раз.`
                        : `❌ Ссылка для входа устарела или уже использована.\n\nВернитесь в ProjectMan и нажмите «Войти через бота» ещё раз.`;
                }
            } else if (text === '/START') {
                replyText = `👋 Привет, ${firstName}!\n\nЯ бот уведомлений ProjectMan.\n\nДля входа используйте кнопку «Войти через Telegram» на сайте ProjectMan. Если подтверждение Telegram не приходит, нажмите «Войти через бота» на экране входа.`;
            } else if (/^[A-Z0-9]{6}$/.test(text)) {
                if (!firebaseApiKey) {
                    replyText = `❌ Подключение по коду сейчас недоступно: сервер не настроен. Используйте вход через кнопку Telegram на сайте ProjectMan.`;
                } else {
                    // Check if code exists in Firestore
                    const codeDoc = await firestoreGet('telegramCodes', text, firebaseApiKey);
                    
                    if (codeDoc && codeDoc.fields && codeDoc.fields.userId) {
                        const userId = codeDoc.fields.userId.stringValue;

                        // Update user's Telegram info
                        const updated = await firestoreUpdate('users', userId, {
                            telegramChatId: String(chatId),
                            telegramUsername: username || ''
                        }, firebaseApiKey);

                        if (updated) {
                            // Delete used code
                            await firestoreDelete('telegramCodes', text, firebaseApiKey);
                            replyText = `✅ Telegram успешно подключен!\n\nТеперь вы будете получать уведомления о:\n📋 Новых задачах\n🔄 Возвратах на доработку\n⏰ Приближении дедлайна\n\nВернитесь в приложение — всё готово!`;
                        } else {
                            replyText = `❌ Ошибка подключения. Попробуйте получить новый код.`;
                        }
                    } else {
                        replyText = `❌ Код не найден или устарел.\n\nПолучите новый код в настройках ProjectMan.`;
                    }
                }
            } else {
                replyText = `📋 Для входа откройте ProjectMan и нажмите «Войти через Telegram».\n\nЕсли вы видите ошибку домена на сайте, напишите администратору.`;
            }

            // Send reply
            const telegramResponse = await fetch(`${telegramApi}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: replyText,
                    parse_mode: 'HTML'
                })
            });
            if (!telegramResponse.ok) {
                const body = await telegramResponse.text().catch(() => '');
                console.error('webhook: Telegram sendMessage failed:', telegramResponse.status, body);
            }

            return res.status(200).send('OK');
        } catch (error) {
            console.error('Webhook error:', error);
            return res.status(200).send('OK');
        }
    }

    return res.status(200).send('Bot is running');
}

async function confirmBotLoginSession(code, message) {
    if (!isValidTelegramLoginCode(code)) return { ok: false, reason: 'invalid' };

    const from = message.from || {};
    const telegramId = from.id ? String(from.id) : '';
    const chatId = message.chat?.id ? String(message.chat.id) : telegramId;
    if (!telegramId) return { ok: false, reason: 'missing_user' };

    try {
        const ref = adminDb().collection(TELEGRAM_LOGIN_SESSION_COLLECTION).doc(code);
        const doc = await ref.get();
        if (!doc.exists) return { ok: false, reason: 'missing' };

        const session = doc.data() || {};
        const expiresAtMs = Date.parse(session.expiresAt || '');
        if (session.status !== 'pending') return { ok: false, reason: session.status || 'used' };
        if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
            await ref.set({ status: 'expired', expiredAt: new Date().toISOString() }, { merge: true });
            return { ok: false, reason: 'expired' };
        }

        await ref.set(
            {
                status: 'confirmed',
                telegramId,
                telegramChatId: chatId,
                telegramUsername: from.username || null,
                firstName: from.first_name || null,
                lastName: from.last_name || null,
                confirmedAt: new Date().toISOString(),
            },
            { merge: true }
        );
        return { ok: true };
    } catch (error) {
        console.error('webhook: bot login confirmation failed:', error);
        return { ok: false, reason: 'server' };
    }
}
