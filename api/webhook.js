import { adminDb } from "../lib/firebase-admin.js";
import {
    TELEGRAM_LOGIN_SESSION_COLLECTION,
    isValidTelegramLoginCode,
} from "../lib/telegram-bot-login.js";

export default async function handler(req, res) {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;

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
    const requestWebhookSecret = req.headers?.['x-telegram-bot-api-secret-token'];
    const hasVerifiedWebhookSecret = Boolean(webhookSecret) && requestWebhookSecret === webhookSecret;

    if (webhookSecret && !hasVerifiedWebhookSecret) {
        console.error('webhook: invalid Telegram webhook secret');
        return res.status(401).send('Unauthorized');
    }

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
            const botLoginMatch = rawText.match(/^\/start(?:@[A-Za-z0-9_]+)?\s+login_([A-Za-z0-9_-]{16,64})$/i);

            let replyText = '';

            if (botLoginMatch) {
                const loginResult = hasVerifiedWebhookSecret
                    ? await confirmBotLoginSession(botLoginMatch[1], message)
                    : { ok: false, reason: 'webhook_secret_missing' };
                if (loginResult.ok) {
                    replyText = `✅ Вход подтвержден.\n\nВернитесь в HoldingMan — окно входа завершится автоматически.`;
                } else {
                    replyText = loginResult.reason === 'server'
                        ? `❌ Не удалось подтвердить вход: сервер временно недоступен. Попробуйте ещё раз.`
                        : loginResult.reason === 'webhook_secret_missing'
                            ? `❌ Вход через бота ещё не настроен на сервере. Сообщите администратору: нужен Telegram webhook secret.`
                        : `❌ Ссылка для входа устарела или уже использована.\n\nВернитесь в HoldingMan и нажмите «Войти через бота» ещё раз.`;
                }
            } else if (text === '/START') {
                replyText = `👋 Привет, ${firstName}!\n\nЯ бот уведомлений HoldingMan.\n\nДля входа используйте кнопку «Войти через Telegram» на сайте HoldingMan. Если подтверждение Telegram не приходит, нажмите «Войти через бота» на экране входа.`;
            } else {
                // NOTE: the old 6-char "connect by code" linking flow was removed —
                // it linked a Telegram chat to a user by a world-readable/guessable
                // telegramCodes doc without verifying the webhook secret (account
                // hijack vector). Login + notification linking now happen only via
                // the bot deep-link flow (botLoginMatch above), which requires the
                // verified webhook secret.
                replyText = `📋 Для входа откройте HoldingMan и нажмите «Войти через Telegram».\n\nЕсли вы видите ошибку домена на сайте, напишите администратору.`;
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
