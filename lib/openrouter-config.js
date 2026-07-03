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

// fetchWithTimeout ONLY bounds time-to-headers: it clears the timer the moment
// fetch() resolves, and the caller then reads the body with NO timeout at all.
// OpenRouter sends headers quickly and STREAMS the completion, so a slow model
// generating a long answer hung api/agent-chat past Vercel's maxDuration
// (prod: 504 "Task timed out after 60 seconds"). This variant keeps ONE
// deadline over the whole exchange — headers AND body — and never throws:
//   { ok, status, data }        — HTTP done, data = parsed JSON (or null)
//   { ok: false, timedOut }     — deadline hit (headers or mid-body)
//   { ok: false, error }        — network failure
export async function fetchJsonWithTimeout(url, options = {}, timeoutMs = openRouterTimeoutMs()) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text(); // still under the same abort signal
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    if (error && error.name === "AbortError") return { ok: false, timedOut: true };
    return { ok: false, error: String(error?.message || error) };
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
