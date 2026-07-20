// Email-уведомления для пользователей, которые зарегистрировались через
// Google. Отправка идёт через Resend Email API и всегда fail-open: проблема
// почтового провайдера не должна ломать создание/изменение задачи.

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_BODY_LENGTH = 10_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function cleanText(value, maxLength) {
  return String(value ?? "").trim().slice(0, maxLength);
}

function appUrl() {
  const configured = cleanText(process.env.APP_BASE_URL, 2_048);
  if (/^https:\/\//i.test(configured)) return configured.replace(/\/+$/, "");
  return "https://projectmanteko.vercel.app";
}

export function isGoogleEmailRecipient(user) {
  const email = cleanText(user?.email, 320).toLowerCase();
  return user?.authProvider === "google.com"
    && email.length <= 320
    && EMAIL_RE.test(email);
}

function emailHtml(title, body) {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body).replaceAll("\n", "<br>");
  const safeUrl = escapeHtml(appUrl());
  return `<!doctype html>
<html lang="ru">
  <body style="margin:0;background:#f5f6fa;font-family:Arial,sans-serif;color:#172033">
    <div style="max-width:600px;margin:0 auto;padding:28px 16px">
      <div style="background:#fff;border:1px solid #e7e9f0;border-radius:16px;padding:28px">
        <div style="font-size:14px;font-weight:700;color:#5b4ee8;margin-bottom:16px">HoldingMan</div>
        <h1 style="font-size:22px;line-height:1.3;margin:0 0 16px">${safeTitle}</h1>
        <div style="font-size:15px;line-height:1.6;margin-bottom:24px">${safeBody}</div>
        <a href="${safeUrl}" style="display:inline-block;background:#5b4ee8;color:#fff;text-decoration:none;border-radius:10px;padding:12px 18px;font-weight:700">Открыть HoldingMan</a>
      </div>
      <div style="font-size:12px;line-height:1.5;color:#7b8191;text-align:center;padding:14px 16px 0">
        Уведомление отправлено на адрес Google-аккаунта, используемого для входа в HoldingMan.
      </div>
    </div>
  </body>
</html>`;
}

// Возвращает структурированный результат и не бросает наружу ошибки сети или
// провайдера. idempotencyKey (обычно id записи agentNotifications) защищает от
// повторной отправки одного события при сетевом ретрае.
export async function sendEmailNotification(user, {
  title = "Уведомление",
  body,
  idempotencyKey = "",
} = {}) {
  if (!isGoogleEmailRecipient(user)) return { sent: false, reason: "not-google-user" };

  const text = cleanText(body, MAX_BODY_LENGTH);
  if (!text) return { sent: false, reason: "empty-body" };

  const apiKey = cleanText(process.env.RESEND_API_KEY, 512);
  const from = cleanText(process.env.EMAIL_FROM, 320);
  if (!apiKey || !from) return { sent: false, reason: "not-configured" };

  const subjectTitle = cleanText(title, 160) || "Уведомление";
  const email = cleanText(user.email, 320).toLowerCase();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    const key = cleanText(idempotencyKey, 220).replace(/[^A-Za-z0-9_-]/g, "-");
    if (key) headers["Idempotency-Key"] = `holdingman-${key}`;

    const response = await fetch(RESEND_EMAILS_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        from,
        to: [email],
        subject: `[HoldingMan] ${subjectTitle}`,
        text: `${subjectTitle}\n\n${text}\n\nОткрыть HoldingMan: ${appUrl()}`,
        html: emailHtml(subjectTitle, text),
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = cleanText(await response.text().catch(() => ""), 500);
      console.error("email-send: provider rejected message", response.status, detail);
      return { sent: false, reason: "provider-error", status: response.status };
    }
    const result = await response.json().catch(() => ({}));
    return { sent: true, id: result.id || null };
  } catch (error) {
    console.error("email-send: request failed", error?.name || error?.message || error);
    return { sent: false, reason: error?.name === "AbortError" ? "timeout" : "transport-error" };
  } finally {
    clearTimeout(timeout);
  }
}
