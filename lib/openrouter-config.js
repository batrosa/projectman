const DEFAULT_CHAT_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];

export function buildOpenRouterModels() {
  const explicit = parseModelList(process.env.CHAT_AGENT_MODELS);
  if (explicit.length) return withRequiredFallback(explicit);
  return uniqueModels(DEFAULT_CHAT_MODELS);
}

export function openRouterModelBody(models) {
  const list = uniqueModels(models);
  return { model: list[0] || DEFAULT_CHAT_MODELS[0] };
}

export function openRouterTimeoutMs() {
  const n = Number(process.env.OPENROUTER_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 3000 ? Math.min(n, 60000) : 9000;
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = openRouterTimeoutMs()) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function uniqueModels(models) {
  const out = [];
  for (const model of models || []) {
    const clean = String(model || "").trim();
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}

function withRequiredFallback(models) {
  return uniqueModels([...models, ...DEFAULT_CHAT_MODELS]);
}

function parseModelList(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}
