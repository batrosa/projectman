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
const TELEGRAM_TIMEOUT_MS = 8000; // a hung Telegram must not stall a cron sweep
const ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const DEFAULT_APP_URL = "https://projectman.online";

function appBaseUrl() {
  const configured = String(process.env.APP_BASE_URL || "").trim();
  try {
    const url = new URL(configured || DEFAULT_APP_URL);
    if (url.protocol !== "https:") return DEFAULT_APP_URL;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return DEFAULT_APP_URL;
  }
}

// Public HTTPS deep-link only contains opaque Firestore ids. Reading the task
// still requires the user's Firebase session and is enforced by Firestore
// rules, so the URL itself does not grant access or expose task content.
export function buildProjectManLink({ taskId, projectId, organizationId } = {}) {
  const url = new URL(appBaseUrl());
  if (ID_RE.test(String(taskId || ""))) url.searchParams.set("task", String(taskId));
  if (ID_RE.test(String(projectId || ""))) url.searchParams.set("project", String(projectId));
  if (ID_RE.test(String(organizationId || ""))) url.searchParams.set("org", String(organizationId));
  return url.toString();
}

function projectManReplyMarkup({ taskId, projectId, organizationId, linkToProjectMan } = {}) {
  if (!linkToProjectMan && !taskId) return null;
  const hasTask = ID_RE.test(String(taskId || ""));
  return {
    inline_keyboard: [[{
      text: hasTask ? "📋 Открыть задачу" : "🚀 Открыть ProjectMan",
      url: buildProjectManLink({ taskId, projectId, organizationId }),
    }]],
  };
}

export async function sendTelegramMessage(chatId, text, {
  parseMode,
  taskId,
  projectId,
  organizationId,
  linkToProjectMan = false,
} = {}) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId || !text) {
    return { ok: false, transport: true, error: "missing token/chatId/text" };
  }

  const controller = typeof AbortController === "function" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TELEGRAM_TIMEOUT_MS) : null;
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: String(text).slice(0, TELEGRAM_TEXT_LIMIT),
        ...(parseMode ? { parse_mode: parseMode } : {}),
        ...((taskId || linkToProjectMan) ? {
          link_preview_options: { is_disabled: true },
          reply_markup: projectManReplyMarkup({
            taskId,
            projectId,
            organizationId,
            linkToProjectMan,
          }),
        } : {}),
      }),
      ...(controller ? { signal: controller.signal } : {}),
    });
  } catch (error) {
    console.error("sendTelegramMessage: fetch failed", error?.message || error);
    return { ok: false, transport: true, error: String(error?.message || error) };
  } finally {
    if (timer) clearTimeout(timer);
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
