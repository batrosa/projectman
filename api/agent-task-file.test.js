import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/firebase-admin.js", () => ({
  adminDb: () => ({}),
  adminAuth: () => ({}),
}));

const { validateAgentTaskFilePayload, resolveProjectFromMessage, buildTableFallbackProposalFromText } = await import("./agent-task-file.js");

function base64(text = "задача") {
  return Buffer.from(text, "utf8").toString("base64");
}

describe("validateAgentTaskFilePayload", () => {
  it("accepts supported file types up to 3 MB and strips data-url prefix", () => {
    const result = validateAgentTaskFilePayload({
      message: "создай задачи",
      projectId: "p1",
      file: {
        filename: "roadmap.xlsx",
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        sizeBytes: 12,
        base64: `data:application/octet-stream;base64,${base64("hello")}`,
      },
    });
    expect(result.ok).toBe(true);
    expect(result.file.filename).toBe("roadmap.xlsx");
    expect(result.file.base64).toBe(base64("hello"));
    expect(result.projectName).toBe("");
  });

  it("keeps visible projectName as a fallback project hint", () => {
    const result = validateAgentTaskFilePayload({
      projectName: "Елисеевский парк",
      file: { filename: "roadmap.xlsx", sizeBytes: 12, base64: base64("hello") },
    });
    expect(result.ok).toBe(true);
    expect(result.projectName).toBe("Елисеевский парк");
  });

  it("rejects unsupported extensions", () => {
    const result = validateAgentTaskFilePayload({
      file: { filename: "tasks.txt", sizeBytes: 1, base64: base64() },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("поддерживаются");
  });

  it("rejects files over the 3 MB transient-upload limit", () => {
    const result = validateAgentTaskFilePayload({
      file: { filename: "tasks.pdf", sizeBytes: 3 * 1024 * 1024 + 1, base64: base64() },
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain("3 МБ");
  });
});

describe("resolveProjectFromMessage", () => {
  const projects = [
    { id: "p1", name: "Абрау-Дюрсо" },
    { id: "p2", name: "Елисеевский парк" },
    { id: "p3", name: "Абрау логистика" },
  ];

  it("matches a project by a significant word from the name", () => {
    const result = resolveProjectFromMessage(projects.slice(0, 2), "создай задачи в проект Абрау");
    expect(result.project?.id).toBe("p1");
  });

  it("returns ambiguous when the message can match several projects", () => {
    const result = resolveProjectFromMessage(projects, "создай задачи в Абрау");
    expect(result.error).toBe("ambiguous");
  });

  it("prefers exact project name over partial word ambiguity", () => {
    const result = resolveProjectFromMessage(projects, "Абрау-Дюрсо");
    expect(result.project?.id).toBe("p1");
  });

  it("asks for a project when there is no project mention", () => {
    const result = resolveProjectFromMessage(projects, "создай задачи из файла");
    expect(result.error).toBe("not_found");
  });
});

describe("buildTableFallbackProposalFromText", () => {
  const text = [
    "Лист: Елисеевский парк",
    "№\tПункт договора\tРаздел\tЗадача / обязательство\tОтветственный\tОт чего считается срок\tДлительность\tДата начала отсчёта\tРасчётный дедлайн\tСтатус\tПримечание",
    "1\t14.1\tДокументация\tРазработать ППТ и ПМТ\tПравообладатели\tОт даты подписания\t8 месяцев\t45936\t46179\tНе начато\tПроверить",
    "2\t24.1\tДокументация\tУтвердить документацию\tАдминистрация\tОт даты подачи\t15 дней\t46179\t46199\tНе начато\t",
    "3\t14.3\tАрхеология\tПолучить заключение\tПравообладатели\tОт утверждения\t12 месяцев\t—\t—\tНе начато\t",
  ].join("\n");

  it("extracts tasks from the xlsx text table when the model output is invalid", () => {
    const proposal = buildTableFallbackProposalFromText(text, { fileName: "roadmap.xlsx" });
    expect(proposal.file).toBe("roadmap.xlsx");
    expect(proposal.tasks).toHaveLength(3);
    expect(proposal.tasks[0]).toEqual({
      title: "Разработать ППТ и ПМТ",
      assigneeName: "Правообладатели",
      deadline: "2026-06-06",
    });
    expect(proposal.tasks[2].deadline).toBe(null);
  });

  it("applies user-provided assignee and deadline overrides", () => {
    const proposal = buildTableFallbackProposalFromText(text, {
      userMessage: "назначь все на Тэко Исаев со сроком 2026-09-01",
    });
    expect(proposal.tasks[0].assigneeName).toBe("Тэко Исаев");
    expect(proposal.tasks[0].deadline).toBe("2026-09-01");
    expect(proposal.tasks[2].deadline).toBe("2026-09-01");
  });

  it("supports the simple template headers: наименование / ответственный / срок", () => {
    const proposal = buildTableFallbackProposalFromText([
      "Лист: Задачи",
      "наименование\tответственный\tсрок",
      "пукнуть\tтэко исаев\tдо 25.10.2026",
      "пожрать\tАмирхан абигасанов\t09.09.2026",
    ].join("\n"));
    expect(proposal.tasks).toEqual([
      { title: "пукнуть", assigneeName: "тэко исаев", deadline: "2026-10-25" },
      { title: "пожрать", assigneeName: "Амирхан абигасанов", deadline: "2026-09-09" },
    ]);
  });
});
