import { describe, it, expect } from "vitest";
import { extractProposal, validateProposal, matchAssignee, validateCreateTasksPayload, matchProposalFile } from "./task-proposal.js";

describe("matchProposalFile", () => {
  const files = [
    { filename: "Елисеевский_парк_дорожная_карта_2 (1).xlsx", projectId: "p1" },
    { filename: "смета.pdf", projectId: "p2" },
  ];

  it("matches exactly (case-insensitive)", () => {
    expect(matchProposalFile(files, "СМЕТА.PDF").file.projectId).toBe("p2");
  });

  it("PROD CASE: model swapped an underscore for a space — still matches", () => {
    const res = matchProposalFile(files, "Елисеевский парк_дорожная_карта_2 (1).xlsx");
    expect(res.file).toBeTruthy();
    expect(res.file.projectId).toBe("p1");
  });

  it("substring both ways (model shortened or padded the name)", () => {
    expect(matchProposalFile(files, "дорожная_карта_2").file.projectId).toBe("p1");
    expect(matchProposalFile(files, "файл смета.pdf из проекта").file.projectId).toBe("p2");
  });

  it("garbled name but only ONE document in scope → take it", () => {
    const one = [{ filename: "план.docx", projectId: "p3" }];
    expect(matchProposalFile(one, "совсем другое имя.docx").file.projectId).toBe("p3");
  });

  it("garbled name with SEVERAL documents → not_found; two similar hits → ambiguous", () => {
    expect(matchProposalFile(files, "несуществующий.docx")).toEqual({ error: "not_found" });
    const twins = [
      { filename: "план v1.pdf", projectId: "a" },
      { filename: "план v2.pdf", projectId: "b" },
    ];
    expect(matchProposalFile(twins, "план")).toEqual({ error: "ambiguous" });
  });

  it("safe on empty inputs", () => {
    expect(matchProposalFile([], "x").error).toBe("not_found");
    expect(matchProposalFile(files, "").error).toBe("not_found");
    expect(matchProposalFile(null, null).error).toBe("not_found");
  });
});

describe("extractProposal", () => {
  it("finds and parses a ```json propose_tasks block", () => {
    const answer = [
      "Вот что я нашёл:",
      "```json",
      JSON.stringify({
        action: "propose_tasks",
        file: "план.pdf",
        tasks: [{ title: "Смета", deadline: "2026-07-10", assigneeName: "Иван Петров" }],
      }),
      "```",
    ].join("\n");
    const res = extractProposal(answer);
    expect(res.found).toBe(true);
    expect(res.proposal.action).toBe("propose_tasks");
    expect(res.proposal.tasks).toHaveLength(1);
  });

  it("plain text answer → found:false (normal chat reply passes through)", () => {
    expect(extractProposal("Обычный ответ агента без JSON").found).toBe(false);
    expect(extractProposal("").found).toBe(false);
    expect(extractProposal(null).found).toBe(false);
  });

  it("tolerates a fence WITHOUT the json tag (real prod case — the model omitted it)", () => {
    const payload = JSON.stringify({
      action: "propose_tasks",
      file: "Абрау-Дюрсо_дорожная_карта.xlsx",
      tasks: [{ title: "Получить разрешение", deadline: "2026-08-01", assigneeName: "Иван Петров" }],
    });
    const res = extractProposal("```\n" + payload + "\n```");
    expect(res.found).toBe(true);
    expect(res.proposal.tasks).toHaveLength(1);
  });

  it("tolerates BARE JSON with no fences at all (and surrounding prose)", () => {
    const payload = JSON.stringify({
      action: "propose_tasks",
      file: "план.pdf",
      tasks: [{ title: "Смета", deadline: "2026-07-10", assigneeName: "Мария Ким" }],
    });
    const res = extractProposal("Вот задачи:\n" + payload);
    expect(res.found).toBe(true);
    expect(res.proposal.file).toBe("план.pdf");
  });

  it("json block with a DIFFERENT action → found:false (not our contract)", () => {
    const answer = "```json\n{\"action\":\"something_else\",\"x\":1}\n```";
    expect(extractProposal(answer).found).toBe(false);
  });

  it("broken JSON inside the block → found:true + error (caller reports parse failure)", () => {
    const answer = "```json\n{\"action\":\"propose_tasks\", broken\n```";
    const res = extractProposal(answer);
    expect(res.found).toBe(true);
    expect(res.error).toBeTruthy();
  });

  it("SALVAGES a truncated tasks array (model hit the output-token cap mid-JSON)", () => {
    const full = {
      action: "propose_tasks",
      file: "Абрау-Дюрсо_дорожная_карта.xlsx",
      tasks: [
        { title: "Задача 1", deadline: "2026-08-01", assigneeName: "Иван Петров" },
        { title: "Задача 2", deadline: "2026-08-05", assigneeName: "Мария Ким" },
        { title: "Задача 3", deadline: "2026-08-09", assigneeName: "Пётр Иванов" },
      ],
    };
    const json = JSON.stringify(full);
    // Обрыв посреди третьей задачи — как это делает max_tokens.
    const cut = json.slice(0, json.indexOf('"Задача 3"') + 12);
    const res = extractProposal("```json\n" + cut);
    expect(res.found).toBe(true);
    expect(res.error).toBeUndefined();
    expect(res.truncated).toBe(true);
    expect(res.proposal.tasks.length).toBe(2); // целые задачи спасены, огрызок отброшен
    expect(res.proposal.tasks[1].title).toBe("Задача 2");
  });

  it("salvage never fabricates: garbage with propose_tasks but no complete task → error", () => {
    const res = extractProposal('{"action":"propose_tasks","file":"x.pdf","tasks":[{"title":"Обры');
    expect(res.found).toBe(true);
    expect(res.error).toBeTruthy();
  });
});

describe("validateProposal", () => {
  const good = {
    action: "propose_tasks",
    file: "план.pdf",
    tasks: [
      { title: "Смета", deadline: "2026-07-10", assigneeName: "Иван Петров" },
      { title: "Договор", deadline: null, assigneeName: "Мария Ким" },
    ],
  };

  it("accepts a valid proposal (deadline may be null)", () => {
    const res = validateProposal(good);
    expect(res.ok).toBe(true);
    expect(res.tasks).toHaveLength(2);
    expect(res.tasks[0].description).toBe("Смета");
    expect(res.trimmed).toBe(false);
  });

  it("keeps a grounded task description and safely caps an excessive one", () => {
    const res = validateProposal({ ...good, tasks: [
      { title: "Смета", description: "Собрать исходные данные и подготовить согласованную смету.", deadline: null, assigneeName: "Иван Петров" },
      { title: "Договор", description: "x".repeat(2500), deadline: null, assigneeName: "Мария Ким" },
    ] });
    expect(res.ok).toBe(true);
    expect(res.tasks[0].description).toBe("Собрать исходные данные и подготовить согласованную смету.");
    expect(res.tasks[1].description.length).toBeLessThanOrEqual(2000);
    expect(res.tasks[1].description.endsWith("…")).toBe(true);
  });

  it("PER-ROW: empty title marks the row (rowError), the rest stays creatable", () => {
    const res = validateProposal({ ...good, tasks: [
      { title: "   ", deadline: null, assigneeName: "X" },
      { title: "Нормальная", deadline: "2026-07-10", assigneeName: "Мария Ким" },
    ] });
    expect(res.ok).toBe(true);
    expect(res.tasks[0].rowError).toBe("no_title");
    expect(res.tasks[1].rowError).toBeUndefined();
  });

  it("PER-ROW: over-long titles are CLAMPED, not rejected", () => {
    const res = validateProposal({ ...good, tasks: [{ title: "x".repeat(300), deadline: null, assigneeName: "X" }] });
    expect(res.ok).toBe(true);
    expect(res.tasks[0].rowError).toBeUndefined();
    expect(res.tasks[0].title.length).toBeLessThanOrEqual(200);
    expect(res.tasks[0].title.endsWith("…")).toBe(true);
  });

  it("PER-ROW: bad deadline formats mark the row, deadline becomes null", () => {
    for (const bad of ["10.07.2026", "2026-13-45"]) {
      const res = validateProposal({ ...good, tasks: [
        { title: "T", deadline: bad, assigneeName: "X" },
        { title: "Ок", deadline: "2026-07-10", assigneeName: "Y" },
      ] });
      expect(res.ok).toBe(true);
      expect(res.tasks[0].rowError).toBe("bad_deadline");
      expect(res.tasks[0].deadline).toBe(null);
    }
  });

  it("PER-ROW: missing assigneeName is ALLOWED (task will be «Не назначен»)", () => {
    const res = validateProposal({ ...good, tasks: [
      { title: "T", deadline: null, assigneeName: "" },
      { title: "Ок", deadline: null, assigneeName: "Y" },
    ] });
    expect(res.ok).toBe(true);
    expect(res.tasks[0].rowError).toBeUndefined();
    expect(res.tasks[0].assigneeName).toBe("");
  });

  it("STRUCTURAL rejects remain: no file, empty tasks, null, ALL rows broken", () => {
    expect(validateProposal({ ...good, file: "" }).ok).toBe(false);
    expect(validateProposal({ ...good, tasks: [] }).ok).toBe(false);
    expect(validateProposal(null).ok).toBe(false);
    expect(validateProposal({ ...good, tasks: [{ title: "", deadline: null, assigneeName: "" }] }).ok).toBe(false);
  });

  it(">100 tasks are TRIMMED to 100 with trimmed:true (not rejected)", () => {
    const res = validateProposal({ ...good, tasks: Array.from({ length: 101 }, (_, i) => ({ title: `T${i}`, deadline: null, assigneeName: "X" })) });
    expect(res.ok).toBe(true);
    expect(res.tasks).toHaveLength(100);
    expect(res.trimmed).toBe(true);
  });
});

describe("coCreatorNames / coCreatorUids (доп. постановщики)", () => {
  it("validateProposal парсит coCreatorNames и отбрасывает мусор", () => {
    const result = validateProposal({
      file: "текстовый запрос",
      tasks: [
        { title: "Задача", coCreatorNames: ["Иван Петров", "", 42, "  Мария Смирнова  "] },
        { title: "Без постановщиков" },
      ],
    });
    expect(result.ok).toBe(true);
    expect(result.tasks[0].coCreatorNames).toEqual(["Иван Петров", "Мария Смирнова"]);
    expect(result.tasks[1].coCreatorNames).toEqual([]);
  });

  it("validateCreateTasksPayload принимает валидные uid и режет дубликаты", () => {
    const result = validateCreateTasksPayload({
      projectId: "p-1",
      tasks: [{ title: "Задача", coCreatorUids: ["u-1", "u-2", "u-1"] }],
    });
    expect(result.ok).toBe(true);
    expect(result.tasks[0].coCreatorUids).toEqual(["u-1", "u-2"]);
  });

  it("validateCreateTasksPayload отклоняет некорректные uid", () => {
    const bad = validateCreateTasksPayload({
      projectId: "p-1",
      tasks: [{ title: "Задача", coCreatorUids: ["нет пробелам!"] }],
    });
    expect(bad.ok).toBe(false);
    const notArray = validateCreateTasksPayload({
      projectId: "p-1",
      tasks: [{ title: "Задача", coCreatorUids: "u-1" }],
    });
    expect(notArray.ok).toBe(false);
  });

  it("coCreatorUids опционален (старые клиенты его не шлют)", () => {
    const result = validateCreateTasksPayload({
      projectId: "p-1",
      tasks: [{ title: "Задача" }],
    });
    expect(result.ok).toBe(true);
    expect(result.tasks[0].coCreatorUids).toEqual([]);
  });
});

describe("validateCreateTasksPayload (phase 2)", () => {
  const good = {
    action: "create_tasks",
    projectId: "p1",
    file: "план.pdf",
    tasks: [{ title: "Смета", deadline: "2026-07-10", assigneeUid: "u1" }],
  };

  it("accepts a valid payload", () => {
    const res = validateCreateTasksPayload(good);
    expect(res.ok).toBe(true);
    expect(res.projectId).toBe("p1");
    expect(res.tasks).toEqual([{ title: "Смета", description: "", deadline: "2026-07-10", assigneeUid: "u1", coCreatorUids: [] }]);
  });

  it("preserves the approved description and rejects an oversized one", () => {
    const accepted = validateCreateTasksPayload({ ...good, tasks: [{
      title: "Смета",
      description: "Подготовить итоговую смету по данным проекта.",
      deadline: null,
      assigneeUid: "u1",
    }] });
    expect(accepted.ok).toBe(true);
    expect(accepted.tasks[0].description).toBe("Подготовить итоговую смету по данным проекта.");
    expect(validateCreateTasksPayload({ ...good, tasks: [{
      title: "Смета",
      description: "x".repeat(2001),
      deadline: null,
      assigneeUid: "u1",
    }] }).ok).toBe(false);
  });

  it("deadline is OPTIONAL: null/empty → task without a deadline; a non-empty value must be a real date", () => {
    const noDeadline = validateCreateTasksPayload({ ...good, tasks: [{ title: "T", deadline: null, assigneeUid: "u1" }] });
    expect(noDeadline.ok).toBe(true);
    expect(noDeadline.tasks[0].deadline).toBe(null);
    const empty = validateCreateTasksPayload({ ...good, tasks: [{ title: "T", deadline: "", assigneeUid: "u1" }] });
    expect(empty.ok).toBe(true);
    expect(empty.tasks[0].deadline).toBe(null);
    // Кривые значения по-прежнему бракуются (не молча теряются).
    expect(validateCreateTasksPayload({ ...good, tasks: [{ title: "T", deadline: "2026-13-01", assigneeUid: "u1" }] }).ok).toBe(false);
    expect(validateCreateTasksPayload({ ...good, tasks: [{ title: "T", deadline: 12345, assigneeUid: "u1" }] }).ok).toBe(false);
  });

  it("rejects: no projectId, empty tasks, >100 tasks, malformed assigneeUid, bad title", () => {
    expect(validateCreateTasksPayload({ ...good, projectId: "" }).ok).toBe(false);
    expect(validateCreateTasksPayload({ ...good, tasks: [] }).ok).toBe(false);
    expect(validateCreateTasksPayload({ ...good, tasks: Array.from({ length: 101 }, (_, i) => ({ title: `T${i}`, deadline: "2026-07-10", assigneeUid: "u" })) }).ok).toBe(false);
    (() => {
      const unassigned = validateCreateTasksPayload({ ...good, tasks: [{ title: "T", deadline: "2026-07-10", assigneeUid: "" }] });
      expect(unassigned.ok).toBe(true); // исполнитель опционален → «Не назначен»
      expect(unassigned.tasks[0].assigneeUid).toBe(null);
    })();
    expect(validateCreateTasksPayload({ ...good, tasks: [{ title: "  ", deadline: "2026-07-10", assigneeUid: "u1" }] }).ok).toBe(false);
    expect(validateCreateTasksPayload(null).ok).toBe(false);
  });

  it("file is optional and gets trimmed/capped", () => {
    expect(validateCreateTasksPayload({ ...good, file: undefined }).ok).toBe(true);
    expect(validateCreateTasksPayload({ ...good, file: "x".repeat(500) }).file.length).toBe(200);
  });

  it("supports multi-project confirmation and remains compatible with old clients", () => {
    const multi = validateCreateTasksPayload({
      action: "create_tasks",
      projectId: "__all__",
      tasks: [
        { title: "A", deadline: "2026-07-10", assigneeUid: "u1", projectId: "p1" },
        { title: "B", deadline: null, assigneeUid: null, projectId: "p2" },
      ],
    });
    expect(multi).toMatchObject({
      ok: true,
      projectId: "__all__",
      tasks: [
        { title: "A", projectId: "p1" },
        { title: "B", projectId: "p2" },
      ],
    });
    expect(validateCreateTasksPayload({
      action: "create_tasks",
      projectId: "__all__",
      tasks: [{ title: "A", deadline: null, assigneeUid: null }],
    })).toMatchObject({ ok: true, tasks: [{ title: "A", projectId: null }] });
    expect(validateCreateTasksPayload({
      ...good,
      tasks: [{ title: "A", deadline: null, assigneeUid: null, projectId: "other" }],
    }).ok).toBe(false);
  });
});

describe("matchAssignee", () => {
  const users = [
    { id: "u1", displayName: "Иван Петров", firstName: "Иван", lastName: "Петров" },
    { id: "u2", displayName: "Мария Ким", firstName: "Мария", lastName: "Ким" },
    { id: "u3", firstName: "Иван", lastName: "Сидоров" }, // без displayName
    { id: "u4", displayName: "Пётр Иванов", firstName: "Пётр", lastName: "Иванов" },
    { id: "u6", displayName: "Эльдар Исаев", firstName: "Эльдар", lastName: "Исаев" },
  ];

  it("matches displayName case-insensitively with extra spaces", () => {
    expect(matchAssignee(users, "  иван   петров ")).toEqual({ uid: "u1", displayName: "Иван Петров" });
  });

  it("matches 'Имя Фамилия' and 'Фамилия Имя'", () => {
    expect(matchAssignee(users, "Сидоров Иван").uid).toBe("u3");
    expect(matchAssignee(users, "Иван Сидоров").uid).toBe("u3");
  });

  it("matches a roadmap surname-first name to a member stored name-first", () => {
    expect(matchAssignee([
      { id: "u-ch", firstName: "Христос", lastName: "Чахиров", displayName: "Христос Чахиров" },
    ], "Чахиров Христос")).toEqual({ uid: "u-ch", displayName: "Христос Чахиров" });
  });

  it("matches common Russian dative forms and collapsed names from natural-language requests", () => {
    expect(matchAssignee(users, "Эльдару Исаеву")).toEqual({ uid: "u6", displayName: "Эльдар Исаев" });
    expect(matchAssignee(users, "ЭльдарИсаев")).toEqual({ uid: "u6", displayName: "Эльдар Исаев" });
  });

  it("ambiguity → error 'ambiguous' (никогда не угадываем между двумя людьми)", () => {
    const dup = [...users, { id: "u5", displayName: "Иван Петров" }];
    expect(matchAssignee(dup, "Иван Петров")).toEqual({ error: "ambiguous" });
  });

  it("no match → error 'not_found'; garbage input safe", () => {
    expect(matchAssignee(users, "Нет Такого")).toEqual({ error: "not_found" });
    expect(matchAssignee(users, "")).toEqual({ error: "not_found" });
    expect(matchAssignee([], "Иван Петров")).toEqual({ error: "not_found" });
    expect(matchAssignee(users, null)).toEqual({ error: "not_found" });
  });

  it("«Иван Петров» vs «Пётр Иванов» не путаются (реверс проверяется по полям, не по перестановке слов)", () => {
    expect(matchAssignee(users, "Пётр Иванов").uid).toBe("u4");
    expect(matchAssignee(users, "Иванов Пётр").uid).toBe("u4");
  });
});
