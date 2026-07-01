export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const setupSecret = request.headers?.["x-setup-secret"];

  if (!botToken || !webhookSecret) {
    return response.status(503).json({ ok: false, error: "Telegram webhook setup env is incomplete" });
  }
  if (setupSecret !== webhookSecret) {
    return response.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const result = await fetch(`https://api.telegram.org/bot${botToken}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: "https://projectmanteko.vercel.app/api/webhook",
      secret_token: webhookSecret,
      allowed_updates: ["message"],
    }),
  });
  const body = await result.json().catch(() => null);

  if (!result.ok || !body?.ok) {
    console.error("Telegram setWebhook failed:", {
      status: result.status,
      errorCode: body?.error_code || null,
      description: body?.description || result.statusText,
    });
    return response.status(502).json({ ok: false, error: "Telegram setWebhook failed" });
  }

  return response.status(200).json({ ok: true, description: body.description || null });
}
