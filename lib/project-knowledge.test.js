import { describe, expect, it } from "vitest";
import {
  buildProjectKnowledgeIndex,
  fileHasProjectKnowledge,
  knowledgeChunksFromFile,
  PROJECT_KNOWLEDGE_VERSION,
} from "./project-knowledge.js";

describe("project knowledge index", () => {
  it("builds a persistent overlapping chunk index once from extracted text", () => {
    const text = [
      "Дом находится в Москве. Площадь дома 1200 м².",
      "Управляющий домом — Иван Петров. Повар — Мария.",
      "Бассейн обслуживает Алексей.",
    ].join("\n\n").repeat(80);
    const index = buildProjectKnowledgeIndex(text, { chunkChars: 1200, overlap: 120 });

    expect(index.knowledgeVersion).toBe(PROJECT_KNOWLEDGE_VERSION);
    expect(index.knowledgeStatus).toBe("ready");
    expect(index.knowledgeCharCount).toBeGreaterThan(5000);
    expect(index.knowledgeChunks.length).toBeGreaterThan(3);
    expect(index.knowledgeChunks.every((chunk) => chunk.length <= 1200)).toBe(true);
  });

  it("marks an empty or unextractable file as unavailable knowledge", () => {
    expect(buildProjectKnowledgeIndex("   ")).toEqual({
      knowledgeVersion: PROJECT_KNOWLEDGE_VERSION,
      knowledgeStatus: "error",
      knowledgeCharCount: 0,
      knowledgeChunks: [],
    });
  });

  it("uses stored chunks and keeps legacy extractedText files available", () => {
    expect(knowledgeChunksFromFile({
      knowledgeChunks: ["Площадь — 1200 м²", "Управляющий — Иван"],
      extractedText: "Этот текст не должен заменять готовый индекс",
    })).toEqual(["Площадь — 1200 м²", "Управляющий — Иван"]);

    const legacy = { extractedText: "Повар — Мария. Горничная — Анна." };
    expect(knowledgeChunksFromFile(legacy)).toEqual([legacy.extractedText]);
    expect(fileHasProjectKnowledge(legacy)).toBe(true);
  });
});
