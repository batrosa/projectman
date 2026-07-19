import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchJsonWithTimeout: vi.fn(),
}));

vi.mock("./openrouter-config.js", () => ({
  buildOpenRouterModels: () => ["test/model"],
  openRouterModelBody: (models) => ({ model: models[0] }),
  fetchJsonWithTimeout: mocks.fetchJsonWithTimeout,
}));

import {
  appendAgentAdvice,
  fallbackAgentAdvice,
  generateAgentAdvice,
  validateAgentAdvice,
} from "./agent-monitor-ai.js";

describe("agent monitor AI advice", () => {
  beforeEach(() => mocks.fetchJsonWithTimeout.mockReset());

  it("uses a deterministic fallback when OpenRouter is unavailable", async () => {
    const result = await generateAgentAdvice({ apiKey: "", eventType: "unassigned_1h" });
    expect(result).toEqual({
      advice: "Назначьте ответственного, чтобы задача не осталась без контроля.",
      source: "template",
    });
    expect(mocks.fetchJsonWithTimeout).not.toHaveBeenCalled();
  });

  it("has a template fallback for every monitor event type (incl. non-LLM ones)", async () => {
    // overdue / not_taken_1h / deadline_today не ходят в LLM, но рекомендация
    // у них быть обязана — api/agent-monitor подставляет fallbackAgentAdvice.
    expect(fallbackAgentAdvice("overdue")).toContain("Уточните причину задержки");
    expect(fallbackAgentAdvice("not_taken_1h")).toContain("Свяжитесь с исполнителем");
    expect(fallbackAgentAdvice("deadline_today")).toContain("Согласуйте");
    expect(fallbackAgentAdvice("deadline_today")).toContain("сегодня");
    // Все fallback-тексты проходят тот же валидатор, что и ответы LLM.
    for (const type of ["overdue", "not_taken_1h", "deadline_today", "deadline_tomorrow", "unassigned_1h"]) {
      expect(validateAgentAdvice(fallbackAgentAdvice(type))).not.toBe(null);
    }
    // ...и независимо от типа generateAgentAdvice без ключа не зовёт сеть.
    const result = await generateAgentAdvice({ apiKey: "", eventType: "deadline_today" });
    expect(result).toEqual({ advice: fallbackAgentAdvice("deadline_today"), source: "template" });
    expect(mocks.fetchJsonWithTimeout).not.toHaveBeenCalled();
  });

  it("accepts only a short fact-free imperative recommendation", async () => {
    mocks.fetchJsonWithTimeout.mockResolvedValueOnce({
      ok: true,
      data: { choices: [{ message: { content: '{"advice":"Сверьте текущий прогресс с исполнителем и согласуйте дальнейшие действия."}' } }] },
    });
    const result = await generateAgentAdvice({
      apiKey: "key",
      eventType: "deadline_tomorrow",
      title: "Подготовить договор",
      projectName: "Дом",
      description: "Согласовать финальную редакцию",
      subStatus: "in_work",
    });
    expect(result).toMatchObject({ source: "ai", model: "test/model" });
    expect(result.advice).toContain("Сверьте текущий прогресс");
    expect(appendAgentAdvice("ИИ-агент: срок завтра.", result.advice))
      .toContain("Рекомендация: Сверьте");
    const request = JSON.parse(mocks.fetchJsonWithTimeout.mock.calls[0][1].body);
    expect(request.temperature).toBe(0);
    expect(request.messages[1].content).toContain("<task_data>");
  });

  it("rejects invented facts, numbers and non-imperative prose", async () => {
    expect(validateAgentAdvice("Исполнитель уже сделал половину работы.")).toBe(null);
    expect(validateAgentAdvice("Проверьте выполнение на 75 процентов.")).toBe(null);
    expect(validateAgentAdvice("Проверьте текущий прогресс и согласуйте следующий шаг"))
      .toBe("Проверьте текущий прогресс и согласуйте следующий шаг.");

    mocks.fetchJsonWithTimeout.mockResolvedValueOnce({
      ok: true,
      data: { choices: [{ message: { content: '{"advice":"Исполнитель уже сделал половину работы."}' } }] },
    });
    const result = await generateAgentAdvice({ apiKey: "key", eventType: "deadline_tomorrow" });
    expect(result).toEqual({ advice: fallbackAgentAdvice("deadline_tomorrow"), source: "template" });
  });
});
