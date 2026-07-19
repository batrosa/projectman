// Persistent project knowledge derived once when a project file is uploaded.
// The AI chat reads these compact chunks; it never downloads or parses the
// original binary again. Keeping the chunks on the same Firestore file doc
// also makes deletion atomic from the product's point of view: deleting the
// file doc removes every piece of knowledge derived from that file.

export const PROJECT_KNOWLEDGE_VERSION = 1;
export const PROJECT_KNOWLEDGE_CHUNK_CHARS = 5000;
export const PROJECT_KNOWLEDGE_CHUNK_OVERLAP = 250;

export function buildProjectKnowledgeIndex(text, {
  chunkChars = PROJECT_KNOWLEDGE_CHUNK_CHARS,
  overlap = PROJECT_KNOWLEDGE_CHUNK_OVERLAP,
} = {}) {
  const normalized = normalizeKnowledgeText(text);
  if (!normalized) {
    return {
      knowledgeVersion: PROJECT_KNOWLEDGE_VERSION,
      knowledgeStatus: "error",
      knowledgeCharCount: 0,
      knowledgeChunks: [],
    };
  }

  const safeChunkChars = Math.max(1000, Number(chunkChars) || PROJECT_KNOWLEDGE_CHUNK_CHARS);
  const safeOverlap = Math.max(0, Math.min(Number(overlap) || 0, safeChunkChars - 1));
  const chunks = [];
  let start = 0;

  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + safeChunkChars);
    if (end < normalized.length) {
      const boundary = findNaturalBoundary(normalized, start, end);
      if (boundary > start + Math.floor(safeChunkChars * 0.55)) end = boundary;
    }
    const chunk = normalized.slice(start, end).trim();
    if (chunk) chunks.push(chunk);
    if (end >= normalized.length) break;
    const nextStart = Math.max(start + 1, end - safeOverlap);
    start = nextStart;
  }

  return {
    knowledgeVersion: PROJECT_KNOWLEDGE_VERSION,
    knowledgeStatus: chunks.length > 0 ? "ready" : "error",
    knowledgeCharCount: normalized.length,
    knowledgeChunks: chunks,
  };
}

// Backward-compatible reader: production files uploaded before the knowledge
// index rollout only have extractedText. They immediately remain usable and
// are chunked in memory without re-downloading or re-parsing the file.
export function knowledgeChunksFromFile(file) {
  if (Array.isArray(file?.knowledgeChunks)) {
    const stored = file.knowledgeChunks
      .map((value) => normalizeKnowledgeText(value))
      .filter(Boolean);
    if (stored.length > 0) return stored;
  }
  return buildProjectKnowledgeIndex(file?.extractedText || "").knowledgeChunks;
}

export function fileHasProjectKnowledge(file) {
  return knowledgeChunksFromFile(file).length > 0;
}

function findNaturalBoundary(text, start, end) {
  const floor = start + Math.floor((end - start) * 0.55);
  const window = text.slice(floor, end);
  const candidates = ["\n\n", "\n", ". ", "; "];
  let best = -1;
  let width = 0;
  for (const candidate of candidates) {
    const index = window.lastIndexOf(candidate);
    if (index > best) {
      best = index;
      width = candidate.length;
    }
  }
  return best >= 0 ? floor + best + width : end;
}

function normalizeKnowledgeText(value) {
  return String(value || "")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
