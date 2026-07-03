// Shared server-side Telegram sender. The bot token stays server-only
// (TELEGRAM_BOT_TOKEN env); every server flow that messages Telegram —
// api/notify-telegram (client proxy), api/agent-monitor (deadline sweep),
// api/agent-chat (task creation) — goes through this one function.
//
// Contract: NEVER throws. Returns either
//   { ok: true,  messageId }
// or
//   { ok: false, transport: true, error }                    — fetch itself failed
//   { ok: false, httpOk, httpStatus, statusText,
//     errorCode, description }                               — Telegram refused
// Rich enough for api/notify-telegram to keep proxying upstream status codes
// verbatim, while fire-and-forget callers (monitor) can just check `ok`.
const TELEGRAM_TEXT_LIMIT = 3900; // hard API limit is 4096; keep headroom

export async function sendTelegramMessage(chatId, text, { parseMode } = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId || !text) {
    return { ok: false, transport: true, error: "missing token/chatId/text" };
  }

  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, TELEGRAM_TEXT_LIMIT),
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }),
    });
  } catch (error) {
    console.error("sendTelegramMessage: fetch failed", error?.message || error);
    return { ok: false, transport: true, error: String(error?.message || error) };
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok || !data?.ok) {
    return {
      ok: false,
      httpOk: response.ok,
      httpStatus: response.status,
      statusText: response.statusText || "",
      errorCode: data?.error_code || response.status,
      description: data?.description || response.statusText || "Unknown Telegram error",
    };
  }

  return { ok: true, messageId: data.result?.message_id ?? null };
}
