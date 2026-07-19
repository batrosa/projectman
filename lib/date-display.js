const ISO_DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function formatIsoDayRu(value, fallback = "") {
  const match = ISO_DAY_RE.exec(String(value || "").slice(0, 10));
  if (!match) return fallback || String(value || "");
  return `${match[3]}.${match[2]}.${match[1]}`;
}
