// Global AI agent chat endpoint: an assistant that reads the projects/tasks/
// uploaded-file-text the CALLER may access, via the Admin SDK. The context is
// SCOPED to the caller's accessible projects (see accessibleProjectIdsFor):
// owner/admin and members with no allow-list get all org projects; a restricted
// member gets only their allowedProjects. It does NOT bypass allowedProjects —
// do not "restore" an org-wide read here, it would leak restricted projects.
import { adminDb, adminAuth } from "../lib/firebase-admin.js";
import { FieldValue } from "firebase-admin/firestore";
import { buildOpenRouterModels, openRouterModelBody, fetchJsonWithTimeout } from "../lib/openrouter-config.js";
import { extractProposal, validateProposal, matchAssignee, validateCreateTasksPayload } from "../lib/task-proposal.js";
import { sendTelegramMessage } from "../lib/telegram-send.js";
// Same manage bar as the rules/award flow: owner/admin manage any project in
// their org; a moderator only projects in their allowedProjects.
import { callerCanManageProject } from "./award-xp.js";

const CONTEXT_CHAR_LIMIT = 45000;
const MAX_HISTORY_TURNS = 8;
const MAX_MESSAGE_CHARS = 4000;
// Output-token cap for the model reply. History: 900 (truncated long
// answers) → 2000 (still cut propose_tasks JSON mid-array on a big roadmap) →
// 4000: fits a 30-task JSON portion (the prompt caps the block at 30) plus
// detailed Markdown tables. The extractor still salvages complete tasks if a
// model overruns, and fetchJsonWithTimeout bounds how long generation may take.
const MAX_OUTPUT_TOKENS = 4000;
// Mirrors the frontend access model (see script.js): users.allowedProjects with
// an empty/absent array means "all projects"; a lone sentinel id means "none".
const NO_ACCESS_SENTINEL = "__no_access__";
// Per-user rate limit protecting the OpenRouter budget from a single
// authenticated user spamming the endpoint (a known abuse/cost vector).
const RATE_LIMIT_COLLECTION = "agentRateLimits";
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 20; // requests per window per user
const OFF_TOPIC_RESPONSE =
  "Я отвечаю только по HoldingMan: проектам, задачам, срокам, исполнителям, файлам, уведомлениям и работе внутри вашей организации. По этому вопросу вне системы ответить не могу.";
const TEXT_TASK_SOURCE_NAME = "текстовый запрос";

const PROJECTMAN_CAPABILITY_GUIDE = [
  "Карта реального функционала HoldingMan важнее общих знаний о системах управления проектами.",
  "Основные разделы: список проектов слева, доска выбранного проекта (виды «Канбан» и «Гант»), «Мои задачи», «Уведомления», «ИИ-агент», «Панель управления», «Админ панель», «Личный кабинет», «Рейтинг сотрудников», «Календарь», «Файлы проекта», модалки задачи/подтверждения/возврата/информации о задаче.",
  "Организации: пользователь работает внутри одной организации; в меню организации показываются название и роль. Код приглашения видят owner/admin, они же могут менять код. Owner может удалить организацию; не-owner может выйти из организации.",
  "Панель управления: содержит переходы в «Админ панель», переключатель светлой/тёмной темы, «Личный кабинет», «Рейтинг сотрудников» и «Календарь». Это не отдельный проектный раздел, а меню настроек/инструментов.",
  "Админ панель доступна owner/admin: вкладки «Пользователи», «Доступ к проектам», «История входов», «Данные о пользователях». В пользователях видны участники, роли, Telegram-статус, можно менять роли и исключать пользователей с учётом ограничений владельца. В доступах настраиваются allowedProjects по сотрудникам.",
  "Личный кабинет: показывает аватар/фото профиля, имя, email, уровень, XP-прогресс, активные задачи, завершено всего, сколько выполнено в срок и сколько без доработок; фото можно обрезать перед сохранением.",
  "Рейтинг сотрудников: показывает топ сотрудников начиная с 3 уровня, с podium/top-3, уровнем и метриками «в срок» и «без доработок».",
  "Роли: owner имеет полный контроль. Admin управляет пользователями, проектами, задачами, доступами и кодом приглашения, но не удаляет организацию и не меняет владельца. Moderator создаёт/редактирует/удаляет/назначает/принимает задачи в разрешённых проектах. Employee/reader видит доступные проекты и свои задачи, берёт свои задачи в работу и отправляет их на проверку с подтверждением.",
  "Доступ к проектам: owner/admin видят все проекты. Для moderator/employee можно задать allowedProjects; пустой список означает доступ ко всем, специальный запрет означает отсутствие доступных проектов. Назначать исполнителем можно участников с доступом к текущему проекту.",
  "Проекты: owner/admin создают, переименовывают и удаляют проекты; у проекта может быть дедлайн. У выбранного проекта два вида отображения — переключатель «Канбан / Гант» появляется под активным проектом в списке слева. Канбан — колонки «Назначенные», «В процессе», «На проверке», «Готово»; drag-and-drop нет, статус меняют через действия/статус задачи.",
  "Гант (дорожная карта): вид «Гант» показывает задачи проекта полосами на временной шкале — от даты создания задачи до её дедлайна. Цвет полосы совпадает со статусом на доске: фиолетовый — назначена, оранжевый — в работе, жёлтый — на проверке, зелёный — готово; просроченные с красной обводкой; вертикальная линия отмечает сегодняшний день. Сверху выбирается год (стрелки и список). Изначально показан весь год со шкалой по месяцам; клик по названию месяца в шапке диаграммы открывает этот месяц по дням (с подсветкой выходных), а кнопка «Весь год» возвращает к годовой шкале. Задачи БЕЗ дедлайна на Ганте не отображаются (счётчик «Без срока: N» показан в легенде) — чтобы задача попала на дорожную карту, ей нужно задать срок. Клик по полосе или названию открывает карточку задачи. Отдельной плановой даты начала у задачи нет — начало полосы это дата создания задачи.",
  "Задача: поля — название, описание/комментарий, ответственные, дедлайн, до 2 прикреплённых файлов до 10 МБ. Новая задача создаётся со статусом «Задача поставлена» / subStatus assigned и попадает в «Назначенные». Можно назначать нескольких ответственных.",
  "Статусы задач: «Задача поставлена»/assigned — ждёт принятия; «В работе»/in_work — исполнитель взял в работу; «Завершена»/completed — исполнитель отправил на проверку; «Готово»/done — руководитель принял, задача в архиве. Просрочка в календаре считается по дедлайну для незавершённых задач.",
  "Выполнение задачи: исполнитель обязан добавить комментарий о выполнении и 1-3 файла подтверждения; после этого задача идёт на проверку. Руководитель может принять задачу в «Готово» или вернуть на доработку с причиной.",
  "XP и рейтинг: очки начисляются сервером только при финальном принятии задачи в «Готово», транзакционно и один раз. База 10 XP, +5 XP если выполнено в срок, -3 XP если задача возвращалась на доработку, минимум 1 XP. Уровни: 1 Новичок 0 XP, 2 Стажёр 50, 3 Специалист 150, 4 Профессионал 300, 5 Эксперт 500, 6 Мастер 800, 7 Легенда 1200. Личный кабинет показывает XP, уровень, активные задачи, завершено всего, процент в срок и без доработок. Рейтинг доступен с 3 уровня; сортировка по score = 50% «в срок» + 50% «без доработок», затем по числу завершённых задач.",
  "Файлы: к задаче можно прикреплять до 2 файлов до 10 МБ. В «Файлы проекта» owner/admin/moderator могут загружать md/xlsx/xlsm/pdf/docx до 10 МБ; текст этих файлов извлекается и используется агентом как база знаний для ответов, но не как прямой источник создания задач.",
  "Создание задач через ИИ-агента работает в два способа: из простого текстового поручения в чате или через кнопку прикрепления разового файла до 3 МБ. В обоих случаях owner/admin/moderator получает карточку предпросмотра и нажимает кнопку создания; исполнитель не может создавать задачи через агента. Агент никогда не должен писать «создал» без карточки и подтверждения.",
  "Удаление задач через ИИ-агента доступно owner/admin/moderator с доступом к проекту и только через карточку предпросмотра с явным подтверждением. Поддерживаются строгие фильтры: все задачи проекта, назначенные, в работе, на проверке, готовые, просроченные или задачи с явно процитированным названием. Агент никогда не должен писать «удалил» без карточки и подтверждения.",
  "Календарь показывает задачи по дедлайну, цветные статусы, список задач выбранного дня и переход к задаче. В календаре нет фильтров по блоку/ответственному и нет синхронизации с Outlook или Google Calendar.",
  "«Мои задачи» показывает активные задачи, где текущий пользователь назначен ответственным; клик открывает нужный проект и колонку задачи.",
  "Уведомления: есть in-app «Уведомления агента» с прочтением/удалением уведомлений. Telegram-уведомления работают при подключенном Telegram: новые задачи, возврат на доработку, напоминания/просрочки от server-side monitor. Нет подписок, ежедневных дайджестов и пользовательских правил уведомлений.",
  "Telegram: можно войти через Telegram-бота/Telegram auth; связанный telegramChatId используется для уведомлений. Если Telegram не подключён, пользователь всё равно получает in-app уведомления, но Telegram-сообщение не уйдёт.",
  "ИИ-агент: отвечает только по HoldingMan и данным доступных проектов/участников/задач/файлов. Плюсик в чате для файлов виден только тем, кто может создавать задачи. Файл в чате разовый, не сохраняется в «Файлы проекта».",
  "В HoldingMan НЕТ: автоматической группировки задач по блокам, drag-and-drop смены статуса, отдельной плановой даты начала задачи, зависимостей/связей между задачами на Ганте, конструктора отчётов/отчёта «статус по блокам», чек-листов/подзадач, общего комментарного чата под задачей, подписок, daily digest, custom notification rules, Outlook/Google Calendar sync, планирования совещаний/стендапов внутри приложения.",
  "Если пользователь спрашивает, как контролировать конкретный проект, предлагай только реальный workflow: разложить работу на проекты/задачи, при необходимости кодировать блоки в названии задачи или отдельными проектами, назначать исполнителей и дедлайны, прикреплять документы, смотреть «Мои задачи» и календарь по дедлайнам, следить за сроками по дорожной карте «Гант» (весь год или конкретный месяц), менять статусы через меню статуса, проверять завершение по комментарию/файлам подтверждения, управлять доступами в админ-панели и использовать Telegram-уведомления.",
  "Если пользователь просит функцию, которой нет, прямо скажи «в HoldingMan такой функции нет» и предложи ближайший реальный способ внутри текущего приложения.",
].join(" ");

const SYSTEM_PROMPT_RULES = [
  "Ты — ИИ Руководитель проекта, ассистент внутри системы управления задачами HoldingMan.",
  "На приветствия, благодарности и короткие обращения (например «привет», «здравствуйте», «спасибо», «ок») отвечай коротко, дружелюбно и по-человечески, и предлагай помощь по проектам и задачам. Это НЕ повод для отказа.",
  "Отвечай по темам HoldingMan: проекты, задачи, сроки, исполнители, файлы, уведомления, роли, вход и работа внутри организации.",
  `Отказ давай ТОЛЬКО на посторонние вопросы-факты, не связанные с работой организации (например «размер луны», «когда отменили крепостное право», погода, история, политика). В этом случае ответь строго этой фразой: ${OFF_TOPIC_RESPONSE}`,
  PROJECTMAN_CAPABILITY_GUIDE,
  "Если пользователь просит создать задачи из текстового поручения, не отвечай запретом: серверный слой сам покажет карточку предпросмотра и проверит права. Если пользователь просит создать задачи из уже сохранённого «Файла проекта» обычным текстом, не делай вид, что можешь брать файл из хранилища для создания задач: для файлов нужно прикрепить разовый файл кнопкой в чате агента.",
  "По умолчанию отвечай кратко (1-3 тезиса), простым нетехническим языком. Но если пользователь просит подробности, список, таблицу или схему — дай полный, хорошо структурированный ответ и НЕ сокращай данные.",
  "Обычные ответы пиши обычным текстом или короткими пунктами. Таблицу (Markdown: строка заголовков, строка-разделитель | --- | --- |, строки данных) делай ТОЛЬКО когда она действительно уместна: когда перечисляешь НЕСКОЛЬКО (2+) однотипных объектов с общими полями — список задач с исполнителями/сроками/статусами, сравнение проектов и т.п. — ИЛИ когда пользователь прямо просит таблицу. НЕ оборачивай в таблицу один объект, короткий факт, приветствие или пояснение (например «что за задача X» про одну задачу — ответь обычным текстом, а не таблицей «поле—значение»). Для акцентов можно **жирный**, для простых перечней — списки. Ссылки [текст](url) и изображения не вставляй.",
  "НЕ рисуй псевдографику и ASCII-диаграммы (сетки из | и —, стрелочные таймлайны, «нарисованные» схемы) — в чате они не отображаются и выглядят сломанно. Блоки кода (```) используй только для настоящего кода/конфигов. Если просят «схему», «диаграмму», «график», «таймлайн» или «дорожную карту» — представь это Markdown-таблицей (например: Этап | Период | Статус) или структурированным списком по этапам/годам, а не рисунком из символов.",
  "НИКОГДА не показывай технические идентификаторы, коды или ID документов. Проекты, задачи и людей называй только их человеческими именами.",
  "Ты видишь ТОЛЬКО проекты, к которым у пользователя есть доступ (они перечислены ниже в данных), и их задачи — не проси открыть раздел или выбрать проект, если данные уже есть. Если пользователь спрашивает про проект, которого НЕТ в этих данных, — вежливо ответь, что у него нет доступа к этому проекту или такого проекта нет среди его проектов; НЕ раскрывай по нему никаких данных и не придумывай их.",
  "Если факта нет в данных — прямо скажи, что этого пока нет в системе. Не выдумывай.",
  "Никогда не придумывай кнопки, разделы, статусы или функции, которых нет в приложении.",
  "Участники организации перечислены в данных: members — это объект, где КЛЮЧ — имя участника, а значение — его данные. Не говори, что участника нет в системе, если его имя есть среди ключей members. У участника могут быть поля «последний_вход» (последний вход в систему), «был_в_сети» (последняя активность), «уровень», «xp», «задач_завершено» — отвечай на вопросы «когда заходил», «когда был в сети», «какой уровень/XP» ПО ЭТИМ ПОЛЯМ, время указано по Москве. Если поля нет у участника — он ещё не заходил в систему.",
  "КРИТИЧНО про точность: отвечая о конкретном участнике или задаче, найди запись РОВНО с этим именем (ключ в members / название задачи) и бери значения ТОЛЬКО из этой записи. Брать значения из соседних записей ЗАПРЕЩЕНО. Перед отправкой ответа сверь: имя, которое ты называешь, совпадает с ключом записи, из которой взяты цифры и даты. Перепутать данные двух людей — грубая ошибка.",
  "Понимай запросы «с полуслова»: сокращённые и разговорные названия проектов и имён («абрау» — проект «Абрау-Дюрсо», «по елисеевскому» — «Елисеевский парк»), опечатки, склонения, регистр. Сначала сопоставь слова пользователя с реальными проектами/задачами/участниками из данных, и только если совпадений нет — скажи об этом.",
  "Если запрос неоднозначен (подходит несколько проектов, участников или задач) — задай ОДИН короткий уточняющий вопрос, а не отказывай и не гадай.",
  "Не отвечай «нет данных» или «не могу», если ответ выводится из данных ниже (проекты, задачи, сроки, участники, их активность, файлы). Сначала поищи в данных.",
  "Если пользователь пытается создать задачу, не отвечай текстом «создал» или «создаю»: сервер должен вернуть карточку предпросмотра, а реальное создание будет только после кнопки подтверждения.",
  "У тебя НЕТ возможности что-либо «отправить в систему», «инициировать создание» или «сформировать карточку» самому. ЗАПРЕЩЕНО писать «запрос отправлен», «запрос обработан», «карточка сформирована», «подборка отправлена» — это ложь: если карточки предпросмотра нет в чате, значит НИЧЕГО не создано и не отправлено. В HoldingMan НЕТ раздела или кнопки «Массовое создание». Если пользователь просит создать показанный тобой список задач, а карточка не появилась — попроси его написать команду создания заново одной фразой (например: «создай задачи из списка выше, без сроков и ответственных»).",
  "Не говори «в предоставленном контексте» — говори «в данных проекта» или «в системе».",
  "Если пользователь пытается удалить задачи, не отвечай текстом «удалил» или «удаляю»: серверный слой должен вернуть карточку предпросмотра, а реальное удаление будет только после кнопки подтверждения.",
  "Информационные ответы в чате данные не меняют. Создание и удаление задач выполняются отдельными серверными действиями только после карточки предпросмотра.",
].join(" ");

const TEXT_TASK_SYSTEM_PROMPT = [
  "Ты превращаешь текстовое поручение пользователя в предложение задач HoldingMan.",
  "Верни РОВНО ОДИН JSON-блок без текста до и после: ```json {\"action\":\"propose_tasks\",\"file\":\"текстовый запрос\",\"tasks\":[{\"title\":\"...\",\"deadline\":\"ГГГГ-ММ-ДД или null\",\"assigneeName\":\"точное имя участника\"}],\"hasMore\":false} ```.",
  "Не больше 30 задач.",
  "Название задачи делай кратким и предметным. Не добавляй слова «задача», «поставить», «создать», если они не часть сути работы.",
  "Если срок указан относительным словом, переведи его в дату по указанной текущей дате: сегодня, завтра, послезавтра, до конца недели.",
  "Если срок не указан, deadline=null.",
  "Ответственного сопоставляй только с участниками HoldingMan из списка. Если форма имени в запросе склонена, верни точное имя из списка. Если участник не найден или есть сомнение, верни имя как написал пользователь.",
  "Если ответственные названы местоимением или косвенно («им», «ему», «этим двум», «обоим», «ей») — определи КОНКРЕТНЫХ людей по разделу «Последние сообщения диалога»: бери тех, кого пользователь обсуждал последними. НИКОГДА не подставляй человека, которого пользователь не называл и который не упоминался в диалоге; автора запроса по умолчанию не назначай. Если однозначно определить людей нельзя — верни \"tasks\": [] (пустой список).",
  "Если пользователь просит «без ответственных» или ответственный не указан — assigneeName=\"\" (пустая строка): задача создастся как «Не назначен». Отсутствие ответственных или сроков — НЕ причина возвращать пустой список задач.",
  "Если пользователь описывает несколько задач для одного ответственного или срока, примени общий ответственный/срок к каждой задаче.",
  "Если текст содержит «Исходное поручение» и «Уточнения пользователя», бери название задачи и срок из исходного поручения, а проект/ответственного уточняй последними сообщениями пользователя.",
  "Если пользователь исправляет исполнителя фразой вроде «давай Тэке Исаеву», замени исполнителя, но не меняй название исходной задачи.",
  "Не показывай технические id.",
].join(" ");

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    return response.status(405).json({ error: "Method not allowed" });
  }

  const idToken = (request.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!idToken) return response.status(401).json({ error: "Unauthorized" });

  let decoded;
  try {
    // verifyIdToken() (no second "checkRevoked" argument) validates the
    // signature against Google's public certs, the issuer/audience against
    // this project's Firebase project id, and expiry — called with defaults,
    // no options are passed that would weaken that validation.
    decoded = await adminAuth().verifyIdToken(idToken);
  } catch {
    return response.status(401).json({ error: "Unauthorized" });
  }

  let body;
  try {
    body = await parseJsonBody(request);
  } catch {
    return response.status(400).json({ error: "Invalid JSON body" });
  }

  // Phase 2 of the create-tasks-from-document flow: the client's «Создать N
  // задач» button posts {action:'create_tasks', ...} instead of a chat message.
  const action = body && body.action;
  const isCreateAction = action === "create_tasks";
  const isDeleteTasksAction = action === "delete_tasks";
  const isMutationAction = isCreateAction || isDeleteTasksAction;
  const isDeleteNotificationAction = action === "delete_notification";

  const message = String(body.message || "").trim().slice(0, MAX_MESSAGE_CHARS);
  if (!isMutationAction && !isDeleteNotificationAction && !message) return response.status(400).json({ error: "message is required" });
  const history = normalizeHistory(body.history);

  // Scope is enforced by the system prompt (greet greetings, refuse only
  // genuinely off-topic factual questions), NOT by a hard regex pre-filter —
  // the old pre-filter false-refused normal conversational openers like
  // "здорова"/"здарова" that no allow-list can reliably enumerate. Letting the
  // model decide is more natural and correct; the OFF_TOPIC_RESPONSE phrase is
  // still enforced verbatim by the prompt for real off-topic questions.
  const db = adminDb();

  // Per-user rate limit (best-effort; fails OPEN if the limiter itself errors,
  // so a limiter hiccup never blocks a legitimate user). Written via the Admin
  // SDK to agentRateLimits/{uid}, which clients can't touch (default-deny).
  if (isDeleteNotificationAction) {
    return handleDeleteNotification({ db, response, decoded, body });
  }

  try {
    const now = Date.now();
    const rlRef = db.collection(RATE_LIMIT_COLLECTION).doc(decoded.uid);
    // Transactional so concurrent requests from the same user can't both read
    // the same window and slip through (a plain get-then-set is a TOCTOU race
    // that under-counts exactly when the limiter matters — rapid repeats).
    const allowed = await db.runTransaction(async (tx) => {
      const rlSnap = await tx.get(rlRef);
      const rl = evaluateRateLimit(rlSnap.exists ? rlSnap.data().timestamps : [], now);
      if (!rl.allowed) return false;
      tx.set(rlRef, { timestamps: rl.timestamps, updatedAt: now }, { merge: true });
      return true;
    });
    if (!allowed) {
      if (isMutationAction) {
        return response.status(429).json({ error: "Слишком много запросов подряд. Подождите минуту и попробуйте снова." });
      }
      return response.status(200).json({ ok: true, answer: "Слишком много запросов подряд. Подождите минуту и попробуйте снова." });
    }
  } catch (error) {
    console.error("agent-chat: rate limit check failed", error);
  }

  let organizationId;
  let accessibleProjectIds = null; // null = all projects (owner/admin or unrestricted)
  let callerData = null; // kept for the task-creation permission check (orgRole/allowedProjects)
  try {
    const userDoc = await db.collection("users").doc(decoded.uid).get();
    callerData = userDoc.exists ? userDoc.data() : null;
    organizationId = callerData ? callerData.organizationId : null;
    accessibleProjectIds = accessibleProjectIdsFor(callerData);
  } catch (error) {
    console.error("agent-chat: failed to load user doc", error);
    if (isMutationAction) {
      return response.status(500).json({ error: "Не удалось загрузить данные организации" });
    }
    return response.status(200).json({ ok: true, answer: "Не удалось загрузить данные организации, попробуйте ещё раз." });
  }
  if (!organizationId) {
    if (isMutationAction) {
      return response.status(403).json({ error: "Вы пока не состоите ни в одной организации" });
    }
    return response.status(200).json({ ok: true, answer: "Вы пока не состоите ни в одной организации — агенту нечего показать." });
  }

  // PHASE 2: confirmed creation from a previously shown proposal. Own
  // validation + a server-side permission check (the button being visible on
  // the client proves nothing).
  if (isCreateAction) {
    return handleCreateTasks({ db, response, decoded, body, callerData, organizationId });
  }
  if (isDeleteTasksAction) {
    return handleDeleteTasks({ db, response, body, callerData, organizationId });
  }
  // Restricted member with access to NO projects: don't even call the model.
  if (Array.isArray(accessibleProjectIds) && accessibleProjectIds.length === 0) {
    return response.status(200).json({ ok: true, answer: "У вас пока нет доступа ни к одному проекту в этой организации — обратитесь к владельцу или администратору." });
  }

  let context;
  try {
    context = await loadOrganizationContext(db, organizationId, accessibleProjectIds);
  } catch (error) {
    console.error("agent-chat: failed to load organization context", error);
    return response.status(200).json({ ok: true, answer: "Не удалось загрузить данные организации, попробуйте ещё раз." });
  }

  if (looksLikeTaskDeletionRequest(message)) {
    return handleTaskDeletionProposal({ db, response, body, message, context, callerData });
  }

  let contextText;
  try {
    contextText = compactContext(context);
  } catch (error) {
    // Defense in depth: compactContext's internals (taskRecency,
    // buildBoundedStructured, JSON.stringify over org-controlled document
    // data, etc.) are hardened individually, but this call site is wrapped
    // too so ANY future failure mode in that pipeline degrades gracefully
    // (HTTP 200 fallback, same pattern as the Firestore-read failures above)
    // instead of crashing the whole request — matching how this file already
    // treats every other external-data-dependent step.
    console.error("agent-chat: failed to compact organization context", error);
    return response.status(200).json({ ok: true, answer: "Не удалось загрузить данные организации, попробуйте ещё раз." });
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY;
  const textTaskRequest = getTextTaskCreationRequest(message, history);
  if (textTaskRequest) {
    if (!["owner", "admin", "moderator"].includes(callerData?.orgRole)) {
      return response.status(200).json({ ok: true, answer: "Создавать задачи через агента может владелец, админ или модератор. У исполнителя нет прав на создание задач." });
    }
    if (!openRouterKey) {
      return response.status(200).json({ ok: true, answer: "ИИ-агент временно недоступен (не настроен OpenRouter)." });
    }

    const projectResult = resolveTextTaskProject({
      projects: context.projects,
      body,
      message: textTaskRequest.message,
      callerData,
    });
    if (projectResult.answer) return response.status(200).json({ ok: true, answer: projectResult.answer });

    const users = await loadOrgUsers(db, organizationId);
    if (!users.ok) return response.status(200).json({ ok: true, answer: users.answer });

    const proposal = await buildTextTaskProposal({
      openRouterKey,
      message: textTaskRequest.message,
      clientToday: body.clientToday,
      users: users.users,
      project: projectResult.project,
      // Недавний диалог: «поставь ИМ двум задачи…» — ответственные названы
      // местоимением, разрешить его можно только по предыдущим репликам
      // (прод-инцидент: без диалога модель подставила не того человека).
      history,
    });

    if (proposal.answer) return response.status(200).json({ ok: true, answer: proposal.answer, model: proposal.model });
    return response.status(200).json({ ok: true, taskProposal: proposal.taskProposal, model: proposal.model });
  }

  if (!openRouterKey) {
    return response.status(200).json({ ok: true, answer: "ИИ-агент временно недоступен (не настроен OpenRouter)." });
  }

  const models = buildOpenRouterModels();
  const messages = [
    { role: "system", content: `${SYSTEM_PROMPT_RULES}\n\nДанные организации:\n${contextText}` },
    ...history,
    { role: "user", content: message },
  ];

  // One hard budget for the WHOLE model-fallback chain, kept safely under the
  // function's maxDuration (60s in vercel.json). fetchJsonWithTimeout bounds
  // headers AND body together — the old fetchWithTimeout+json() pair only
  // bounded time-to-headers, so a slow STREAMING model rode past the platform
  // limit into a 504 ("Task timed out after 60 seconds", prod repro).
  const LLM_TOTAL_BUDGET_MS = 50_000;
  const LLM_PER_MODEL_MS = 25_000;
  const llmDeadline = Date.now() + LLM_TOTAL_BUDGET_MS;

  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    const remainingMs = llmDeadline - Date.now();
    if (remainingMs < 3000) break; // no realistic budget left for another attempt

    const attempt = await fetchJsonWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openRouterKey}`, "Content-Type": "application/json" },
      // 0.1: основной чат — фактовые lookup'ы по данным организации;
      // творческий разброс тут только повышает шанс перепутать записи.
      body: JSON.stringify({ ...openRouterModelBody([model]), temperature: 0.1, max_tokens: MAX_OUTPUT_TOKENS, messages }),
    }, Math.min(LLM_PER_MODEL_MS, remainingMs));

    if (!attempt.ok) {
      if (attempt.timedOut) console.warn("agent-chat: model attempt timed out", model);
      continue;
    }
    const answer = cleanAnswer(attempt.data?.choices?.[0]?.message?.content);
    if (!answer) continue;

    return response.status(200).json({ ok: true, answer, model });
  }

  return response.status(200).json({
    ok: true,
    answer: "Не удалось получить ответ от ИИ-агента, попробуйте ещё раз через минуту.",
    model: "fallback",
  });
}

function looksLikeTextTaskCreationRequest(message) {
  const text = normalizeLookup(message);
  if (!text) return false;
  if (/((из|по|на основе|согласно)\s+(файл|документ|таблиц)|xlsx|xlsm|xls|pdf|docx|md|прикреп|загруз)/u.test(text)) {
    return false;
  }
  const createVerb = /(создай|создать|создайте|поставь|поставить|поставьте|назначь|назначить|назначьте|добавь|добавить|добавьте|заведи|завести|оформи|оформить|поручи|поручить)/u;
  const taskHint = /(задач|поручени|исполнител|ответственн|срок|дедлайн|сегодня|завтра|послезавтра)/u;
  return createVerb.test(text) && taskHint.test(text);
}

// Короткая команда-подтверждение создания («создавай», «создай их», «сам
// создай карточку», «подтверждаю») — без полноценного поручения в ней самой.
export function isCreateAffirmation(message) {
  const text = normalizeLookup(message);
  if (!text || text.length > 80) return false;
  return /(создай|создавай|создать|подтвержда|заведи|оформи|поставь их|давай их)/u.test(text);
}

// Последний ответ АГЕНТА, содержащий пронумерованный/маркированный список или
// таблицу — источник задач для «создавай» после показанного агентом списка.
export function lastAssistantListContent(history) {
  const turns = Array.isArray(history) ? history : [];
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.role !== "assistant") continue;
    const content = String(turn.content || "");
    if (/^\s*\d+[.)]\s+\S/m.test(content) || /\|\s*-{3,}\s*\|/.test(content) || /^\s*[-•]\s+\S/m.test(content)) {
      return content;
    }
  }
  return null;
}

function getTextTaskCreationRequest(message, history) {
  if (looksLikeTextTaskCreationRequest(message)) {
    return { message, fromHistory: false };
  }

  const affirmation = affirmationFromAssistantList(message, history);
  const turns = Array.isArray(history) ? history : [];
  let baseIndex = -1;
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.role === "user" && looksLikeTextTaskCreationRequest(turn.content)) {
      baseIndex = i;
      break;
    }
  }
  if (baseIndex < 0) return affirmation;
  const afterBase = turns.slice(baseIndex + 1);
  if (!isLikelyTextTaskContinuation(message, afterBase)) return affirmation;

  const base = String(turns[baseIndex].content || "").trim();
  const clarifications = turns
    .slice(baseIndex + 1)
    .filter((turn) => turn?.role === "user")
    .map((turn) => String(turn.content || "").trim())
    .filter(Boolean)
    .slice(-4);
  clarifications.push(message);

  return {
    fromHistory: true,
    message: [
      `Исходное поручение: ${base}`,
      "Уточнения пользователя после исходного поручения:",
      ...clarifications.map((item) => `- ${item}`),
    ].join("\n"),
  };
}

// Прод-кейс: агент сам показал список задач текстом, пользователь пишет
// «создавай» — исходного ПОЛЬЗОВАТЕЛЬСКОГО поручения в истории нет, и раньше
// запрос уходил в обычный чат, где модель ВРАЛА («запрос отправлен», выдуманное
// «Массовое создание»). Теперь такая команда строит поручение из последнего
// списка агента и запускает настоящий конвейер карточки.
function affirmationFromAssistantList(message, history) {
  if (!isCreateAffirmation(message)) return null;
  const listContent = lastAssistantListContent(history);
  if (!listContent) return null;
  return {
    fromHistory: true,
    message: [
      "Создай задачи из показанного ранее списка (он приведён ниже, из предыдущего ответа агента).",
      `Команда пользователя к созданию (учти уточнения — например «без сроков», «без ответственных», «первые N»): ${String(message || "").trim()}`,
      "Список из предыдущего ответа агента:",
      String(listContent).slice(0, 3000),
    ].join("\n\n"),
  };
}

// ===== DELETE TASKS (two-phase, fully deterministic — no LLM involved) =====
// Phase 1: a delete command builds a preview card from REAL Firestore tasks
// matched by an explicitly recognized filter; nothing is guessed or generated,
// so nothing can be fabricated. Phase 2 (action 'delete_tasks') re-validates
// every id server-side and batch-deletes. Mirrors the create-tasks protocol.

const TASK_DELETE_MAX = 200; // per confirmation card / per request

export function looksLikeTaskDeletionRequest(message) {
  const text = normalizeLookup(message);
  if (!text) return false;
  const deleteVerb = /(удали|удалить|удалите|удаляй|убери|убрать|уберите|снеси|снести|очисти|очистить|очистите)/u;
  const taskHint = /(задач|поручени)/u;
  return deleteVerb.test(text) && taskHint.test(text);
}

// Recognized deletion filters. Returns null when the request is ambiguous —
// the handler then ASKS instead of guessing (deletion must never guess).
export function extractDeletionFilter(message) {
  const raw = String(message || "");

  // Quoted task titles: «...», "...", „...“. A quote right after the word
  // «проект…» is the PROJECT name, not a task title — skip those.
  const titles = [];
  const quoteRe = /«([^«»]{1,300})»|"([^"]{1,300})"|„([^“”]{1,300})[“”]/gu;
  for (const m of raw.matchAll(quoteRe)) {
    const before = raw.slice(Math.max(0, m.index - 20), m.index);
    if (/проект[а-яё]*\s*[:—-]?\s*$/iu.test(before)) continue;
    const title = (m[1] || m[2] || m[3] || "").trim();
    if (title) titles.push(title);
  }
  if (titles.length > 0) return { kind: "title", titles };

  const text = normalizeLookup(raw);
  if (/просрочен/u.test(text)) return { kind: "overdue" };
  if (/назначенн/u.test(text)) return { kind: "status", status: "assigned" };
  if (/(на проверке|на проверку)/u.test(text)) return { kind: "status", status: "review" };
  if (/(в работе|в процессе)/u.test(text)) return { kind: "status", status: "in-progress" };
  if (/(готовые|готовых|готово|выполненн|завершенн|архивн)/u.test(text)) return { kind: "status", status: "done" };
  // \b does not work for Cyrillic — manual word boundaries. «всё» is already
  // normalized to «все» by normalizeLookup.
  if (/(^|[^а-яa-z0-9])все([^а-яa-z0-9]|$)/u.test(text)) return { kind: "all" };
  return null;
}

export function deletionFilterLabel(filter) {
  if (!filter) return "";
  if (filter.kind === "all") return "все задачи";
  if (filter.kind === "overdue") return "просроченные";
  if (filter.kind === "title") return `с названием ${filter.titles.map((t) => `«${t}»`).join(", ")}`;
  const labels = { assigned: "назначенные", "in-progress": "в работе", review: "на проверке", done: "готовые" };
  return labels[filter.status] || "";
}

// Board-column semantics for a task — EXACTLY the client's boardViewForTask()
// incl. the legacy no-subStatus migration, so «назначенные» here matches the
// «Назначенные» column the user sees.
export function agentTaskBoardStatus(task) {
  if (task?.status === "done") return "done";
  const sub = task?.subStatus || (task?.assigneeCompleted ? "completed" : "assigned");
  if (sub === "completed") return "review";
  if (sub === "in_work") return "in-progress";
  return "assigned";
}

export function matchTasksForDeletion(tasks, filter, todayIso) {
  const list = Array.isArray(tasks) ? tasks : [];
  if (!filter) return [];
  if (filter.kind === "all") return list;
  if (filter.kind === "status") return list.filter((t) => agentTaskBoardStatus(t) === filter.status);
  if (filter.kind === "overdue") {
    return list.filter((t) => {
      if (agentTaskBoardStatus(t) === "done") return false;
      const day = String(t?.deadline || "").slice(0, 10);
      return isIsoDate(day) && day < todayIso;
    });
  }
  if (filter.kind === "title") {
    const wanted = filter.titles.map((t) => normalizeLookup(t)).filter(Boolean);
    return list.filter((t) => {
      const title = normalizeLookup(t?.title);
      if (!title) return false;
      return wanted.some((w) => title === w || title.includes(w) || w.includes(title));
    });
  }
  return [];
}

// Deletion targets the project NAMED IN THE MESSAGE first: the client always
// sends the currently open project's id, and «удали … из проекта X» while
// project Y is open must hit X, never Y. Falls back to the open project only
// when the message names none.
function resolveDeletionProject({ projects, body, message, callerData }) {
  const list = Array.isArray(projects) ? projects : [];
  let project = null;

  const explicitProjectText = extractProjectTextAfterProjectWord(message);
  let fromMessage = explicitProjectText
    ? resolveProjectFromText(list, explicitProjectText)
    : resolveProjectFromText(list, message);
  if (explicitProjectText && fromMessage.error === "not_found") {
    fromMessage = resolveProjectFromText(list, message);
  }
  if (fromMessage.project) {
    project = fromMessage.project;
  } else if (fromMessage.error === "ambiguous") {
    return { answer: "Название проекта подходит к нескольким проектам. Напишите его полное название." };
  } else {
    const requestedId = typeof body.projectId === "string" ? body.projectId.trim() : "";
    project = requestedId ? (list.find((p) => p?.id === requestedId) || null) : null;
  }
  if (!project) {
    return { answer: "Не понял, из какого проекта удалять задачи. Откройте проект или напишите его точное название в сообщении." };
  }
  if (!callerCanManageProject(callerData?.orgRole, callerData?.allowedProjects, project.id)) {
    return { answer: "Нет доступа к удалению задач в этом проекте." };
  }
  return { project };
}

function extractProjectTextAfterProjectWord(message) {
  const raw = String(message || "").trim();
  const match = raw.match(/(?:^|[\s,.;:!?])(из|в|во|по)?\s*проект[а-яё]*\s+(.{2,180})$/iu);
  if (!match) return "";
  return match[2]
    .replace(/["«»„“”]/g, " ")
    .replace(/[.!?;,]+$/g, "")
    .trim();
}

async function handleTaskDeletionProposal({ db, response, body, message, context, callerData }) {
  if (!["owner", "admin", "moderator"].includes(callerData?.orgRole)) {
    return response.status(200).json({ ok: true, answer: "Удалять задачи через агента может владелец, админ или модератор. У исполнителя нет прав на удаление задач." });
  }

  const filter = extractDeletionFilter(message);
  if (!filter) {
    return response.status(200).json({
      ok: true,
      answer: "Не понял, какие задачи удалять. Укажите строгий фильтр: все, назначенные, в работе, на проверке, готовые, просроченные или название задачи в кавычках.",
    });
  }

  const projectResult = resolveDeletionProject({
    projects: context.projects,
    body,
    message,
    callerData,
  });
  if (projectResult.answer) return response.status(200).json({ ok: true, answer: projectResult.answer });

  const loaded = await loadProjectTasksForDeletion(db, projectResult.project.id);
  if (!loaded.ok) return response.status(200).json({ ok: true, answer: loaded.answer });

  const today = isIsoDate(body.clientToday) ? body.clientToday : todayIsoDate();
  const matched = matchTasksForDeletion(loaded.tasks, filter, today);
  if (matched.length === 0) {
    return response.status(200).json({
      ok: true,
      answer: `Не нашёл задач для удаления: ${deletionFilterLabel(filter)} в проекте «${projectResult.project.name || "без названия"}».`,
    });
  }
  if (matched.length > TASK_DELETE_MAX) {
    return response.status(200).json({
      ok: true,
      answer: `Найдено ${matched.length} задач. Для безопасного подтверждения лимит ${TASK_DELETE_MAX}; уточните фильтр и повторите команду.`,
    });
  }

  return response.status(200).json({
    ok: true,
    deleteProposal: buildDeleteTasksProposal({
      project: projectResult.project,
      filter,
      tasks: matched,
    }),
  });
}

async function loadProjectTasksForDeletion(db, projectId) {
  try {
    const snap = await db.collection("tasks")
      .where("projectId", "==", projectId)
      .limit(MAX_CONTEXT_TASKS)
      .get();
    if (snap.size >= MAX_CONTEXT_TASKS) {
      return {
        ok: false,
        answer: "В проекте слишком много задач для безопасного массового удаления через агента. Уточните фильтр или удалите задачи вручную.",
      };
    }
    return { ok: true, tasks: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) };
  } catch (error) {
    console.error("agent-chat delete_tasks: failed to load project tasks", error);
    return { ok: false, answer: "Не удалось загрузить задачи проекта, попробуйте ещё раз." };
  }
}

function buildDeleteTasksProposal({ project, filter, tasks }) {
  const projectName = project?.name || "без названия";
  return {
    source: "delete_tasks",
    projectId: project.id,
    projectName,
    filterLabel: deletionFilterLabel(filter),
    canDelete: true,
    tasks: tasks.map((task) => ({
      id: task.id,
      title: String(task.title || "Без названия").slice(0, 300),
      deadline: task.deadline || null,
      assigneeDisplay: task.assignee || "Не назначен",
      statusDisplay: humanTaskStatus(task),
    })),
  };
}

export function isLikelyTextTaskContinuation(message, historyAfterBase = []) {
  const text = normalizeLookup(message);
  if (!text || text.length > 220) return false;
  if (/^(спасибо|благодарю|ок|понял|поняла|ясно|хорошо|принято|супер|отлично)(\s+\S+){0,3}$/u.test(text)) return false;
  if (/^(какие|какой|какая|какое|когда|что|где|кто|сколько|покажи|покажите|расскажи|есть ли)\b/u.test(text)) return false;
  if (/[?？]\s*$/.test(String(message || ""))) return false;
  if (/(проект|ответственн|исполнител|назнач|давай|пусть|он есть|она есть|срок|дедлайн|сегодня|завтра|послезавтра|без срок|без ответственн|первые\s+\d+)/u.test(text)) {
    return true;
  }
  const lastAssistant = [...(Array.isArray(historyAfterBase) ? historyAfterBase : [])]
    .reverse()
    .find((turn) => turn?.role === "assistant");
  const lastAssistantText = normalizeLookup(lastAssistant?.content);
  const askedForClarification = /(в какой проект|какой проект|кому поставить|назовите имена|не понял.*кому|не понял.*проект|уточните|точное название)/u.test(lastAssistantText);
  return askedForClarification && text.split(" ").length <= 4;
}

function resolveTextTaskProject({ projects, body, message, callerData }) {
  const list = Array.isArray(projects) ? projects : [];
  let project = null;

  const requestedId = typeof body.projectId === "string" ? body.projectId.trim() : "";
  if (requestedId) {
    project = list.find((p) => p?.id === requestedId) || null;
    if (!project) {
      return { answer: "Проект не найден среди доступных вам проектов." };
    }
  } else {
    const lookupText = typeof body.projectName === "string" && body.projectName.trim()
      ? body.projectName
      : message;
    const resolved = resolveProjectFromText(list, lookupText);
    if (resolved.error === "ambiguous") {
      return { answer: "Название проекта подходит к нескольким проектам. Откройте нужный проект или напишите его полное название." };
    }
    if (resolved.error) {
      return { answer: "Не понял, в какой проект поставить задачу. Откройте проект или напишите его точное название в сообщении." };
    }
    project = resolved.project;
  }

  if (!callerCanManageProject(callerData?.orgRole, callerData?.allowedProjects, project.id)) {
    return { answer: "Нет доступа к созданию задач в этом проекте." };
  }
  return { project };
}

function resolveProjectFromText(projects, textValue) {
  const text = normalizeLookup(textValue);
  const list = Array.isArray(projects) ? projects : [];
  if (!text || list.length === 0) return { error: "not_found" };

  let hits = list.filter((project) => normalizeLookup(project?.name) === text);
  if (hits.length === 1) return { project: hits[0] };
  if (hits.length > 1) return { error: "ambiguous" };

  hits = list.filter((project) => {
    const name = normalizeLookup(project?.name);
    if (!name) return false;
    if (text.includes(name) || name.includes(text)) return true;
    const words = name.split(" ").filter((word) => word.length >= 4);
    return words.some((word) => text.includes(word));
  });
  if (hits.length === 1) return { project: hits[0] };
  if (hits.length > 1) return { error: "ambiguous" };
  return { error: "not_found" };
}

// Последние реплики диалога для текстового создания задач: «поставь им двум…»
// разрешимо только по контексту разговора. Компактно: до 6 последних реплик,
// каждая обрезается, роли по-русски. Pure — экспортируется для тестов.
export function formatRecentDialogue(history, { maxTurns = 6, maxChars = 300 } = {}) {
  const turns = (Array.isArray(history) ? history : [])
    .filter((turn) => turn && typeof turn.content === "string" && turn.content.trim())
    .slice(-maxTurns);
  if (turns.length === 0) return "";
  return turns
    .map((turn) => {
      const who = turn.role === "assistant" ? "Агент" : "Пользователь";
      const text = turn.content.trim().replace(/\s+/g, " ").slice(0, maxChars);
      return `${who}: ${text}`;
    })
    .join("\n");
}

async function loadOrgUsers(db, organizationId) {
  try {
    const snap = await db.collection("users").where("organizationId", "==", organizationId).get();
    return { ok: true, users: snap.docs.map((doc) => ({ id: doc.id, ...doc.data() })) };
  } catch (error) {
    console.error("agent-chat: failed to load users", error);
    return { ok: false, answer: "Не удалось загрузить участников организации, попробуйте ещё раз." };
  }
}

async function buildTextTaskProposal({ openRouterKey, message, clientToday, users, project, history }) {
  const today = isIsoDate(clientToday) ? clientToday : todayIsoDate();
  const tomorrow = addDaysIso(today, 1);
  const dayAfterTomorrow = addDaysIso(today, 2);
  const assignableUsers = users.filter((u) => userHasProjectAccessForAssignment(u, project.id));
  const membersText = assignableUsers.map((u) => displayName(u)).filter(Boolean).join(", ");
  const dialogue = formatRecentDialogue(history);
  const userPrompt = [
    `Текущая дата: ${today}.`,
    `Завтра: ${tomorrow}. Послезавтра: ${dayAfterTomorrow}.`,
    `Проект для создаваемых задач: ${project.name || "без названия"}.`,
    `Участники HoldingMan для сопоставления ответственных: ${membersText || "нет участников"}.`,
    ...(dialogue ? [`Последние сообщения диалога (по ним разрешай «им», «ему», «этим двум» и т.п.):\n${dialogue}`] : []),
    "Текстовое поручение пользователя:",
    message,
  ].join("\n\n");

  const llm = await callModelForTextTaskProposal({ openRouterKey, userPrompt });
  if (!llm.ok) {
    return { answer: "Не удалось разобрать текстовое поручение. Попробуйте указать задачу, ответственного и срок одной фразой." };
  }

  const built = buildTextTaskProposalFromRaw({
    rawAnswer: llm.answer,
    users: assignableUsers,
    project,
  });
  return { ...built, model: llm.model };
}

async function callModelForTextTaskProposal({ openRouterKey, userPrompt }) {
  const models = buildOpenRouterModels();
  const deadline = Date.now() + 30_000;
  for (const model of models) {
    const remainingMs = deadline - Date.now();
    if (remainingMs < 3000) break;
    const attempt = await fetchJsonWithTimeout("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openRouterKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        ...openRouterModelBody([model]),
        temperature: 0.1,
        max_tokens: 1400,
        messages: [
          { role: "system", content: TEXT_TASK_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    }, Math.min(15_000, remainingMs));
    if (!attempt.ok) continue;
    const answer = String(attempt.data?.choices?.[0]?.message?.content || "").trim();
    if (answer) return { ok: true, answer, model };
  }
  return { ok: false };
}

function buildTextTaskProposalFromRaw({ rawAnswer, users, project }) {
  const extracted = extractProposal(rawAnswer);
  if (!extracted.found || extracted.error) {
    console.error("agent-chat text-create: propose_tasks parse failed", {
      answerLength: String(rawAnswer || "").length,
      tail: String(rawAnswer || "").slice(-160),
    });
    return { answer: "Не смог корректно разобрать текстовое поручение. Попробуйте написать: «поставь задачу Ивану Иванову: проверить договор, срок 2026-09-01»." };
  }

  const proposal = extracted.proposal;
  if (Array.isArray(proposal?.tasks) && proposal.tasks.length === 0) {
    return { answer: "Не понял однозначно, кому поставить задачу. Назовите имена участников (например: «поставь Эльдару Исаеву и Амирхану Абигасанову задачу …») — и я подготовлю карточку." };
  }

  const validated = validateProposal({
    ...proposal,
    file: TEXT_TASK_SOURCE_NAME,
  });
  if (!validated.ok) {
    return { answer: validated.error.includes("ни одна строка")
      ? "Не понял, какие задачи создать. Назовите их (например: «поставь задачу проверить договор, без срока и ответственного») — и я подготовлю карточку."
      : `Не получилось сформировать задачи: ${validated.error}.` };
  }

  const REASON_TEXT = {
    not_found: "ответственный не найден среди участников HoldingMan",
    ambiguous: "имя подходит нескольким пользователям",
    no_title: "нет названия задачи",
    bad_deadline: "некорректный срок в запросе",
    no_assignee: "не указан ответственный",
  };
  const tasks = validated.tasks.map((t) => {
    if (t.rowError) {
      return { title: t.title || "-", deadline: t.deadline, assigneeName: t.assigneeName, ok: false, reason: REASON_TEXT[t.rowError] || t.rowError };
    }
    // Ответственный ОПЦИОНАЛЕН: «поставь задачи без ответственных» — легальный
    // запрос, задача создаётся как «Не назначен» (как и вручную).
    if (!t.assigneeName) {
      return { ...t, deadline: t.deadline || null, assigneeUid: null, assigneeDisplay: "Не назначен", ok: true };
    }
    const match = matchAssignee(users, t.assigneeName);
    if (match.error) return { ...t, ok: false, reason: REASON_TEXT[match.error] || match.error };
    // Срок ОПЦИОНАЛЕН: задача без дедлайна создаётся (deadline null) — как и
    // при ручном создании. Монитор такие задачи по срокам не пилит (нечего),
    // «не взял в работу за час» работает как обычно.
    return { ...t, deadline: t.deadline || null, assigneeUid: match.uid, assigneeDisplay: match.displayName, ok: true };
  });

  return {
    taskProposal: {
      source: "text",
      file: TEXT_TASK_SOURCE_NAME,
      projectId: project.id,
      projectName: project.name || "без названия",
      tasks,
      canCreate: true,
      truncated: extracted.truncated === true || validated.trimmed === true || proposal.hasMore === true,
    },
  };
}

function displayName(user) {
  return user.displayName
    || `${user.firstName || ""} ${user.lastName || ""}`.trim()
    || user.email
    || "";
}

function getRoleNameRu(role) {
  return ({
    owner: "Владелец",
    admin: "Администратор",
    moderator: "Модератор",
    employee: "Исполнитель",
    reader: "Исполнитель",
  })[role] || "Исполнитель";
}

// Firestore Timestamp | {seconds} | ISO string | Date → «ДД.ММ.ГГГГ, ЧЧ:ММ»
// по Москве (или null). Для полей активности участников в контексте агента.
function formatMskDateTime(value) {
  if (!value) return null;
  let date = null;
  try {
    if (typeof value.toDate === "function") date = value.toDate();
    else if (typeof value === "object" && typeof value.seconds === "number") date = new Date(value.seconds * 1000);
    else date = new Date(value);
  } catch {
    return null;
  }
  if (!date || Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "Europe/Moscow",
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  }).format(date);
}

function normalizeLookup(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[ё]/g, "е")
    .replace(/[\s_-]+/g, " ")
    .trim();
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ""))) return false;
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function addDaysIso(isoDate, days) {
  const [year, month, day] = String(isoDate).split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

// ===== CREATE TASKS FROM A DOCUMENT (two-phase protocol) =====

// PHASE 2: the confirmed «Создать N задач» click. Server-side validation +
// the same manage bar as the main UI, then a single batch creating the task
// docs (field shape mirrors the client's createTask()) and the feed entries;
// Telegram duplicates go out after the commit.
async function handleCreateTasks({ db, response, decoded, body, callerData, organizationId }) {
  const payload = validateCreateTasksPayload(body);
  if (!payload.ok) return response.status(400).json({ error: payload.error });

  let project;
  try {
    const snap = await db.collection("projects").doc(payload.projectId).get();
    project = snap.exists ? snap.data() : null;
  } catch (error) {
    console.error("agent-chat create_tasks: project load failed", error);
    return response.status(500).json({ error: "Не удалось проверить проект" });
  }
  if (!project || project.organizationId !== organizationId) {
    return response.status(403).json({ error: "Проект не найден в вашей организации" });
  }
  if (!callerCanManageProject(callerData?.orgRole, callerData?.allowedProjects, payload.projectId)) {
    return response.status(403).json({ error: "Недостаточно прав для создания задач в этом проекте" });
  }

  // Every assignee must be a real member of the caller's org — reject the
  // whole request otherwise (no partial creation surprises).
  // null/пустой uid легален — задача «Не назначен»; проверяем только реальных.
  const uniqueUids = [...new Set(payload.tasks.map((t) => t.assigneeUid).filter(Boolean))];
  const usersByUid = new Map();
  for (const uid of uniqueUids) {
    try {
      const snap = await db.collection("users").doc(uid).get();
      const data = snap.exists ? snap.data() : null;
      if (!data || data.organizationId !== organizationId) {
        return response.status(400).json({ error: "Один из исполнителей не найден в вашей организации" });
      }
      if (!userHasProjectAccessForAssignment(data, payload.projectId)) {
        return response.status(400).json({ error: "Один из исполнителей не имеет доступа к этому проекту" });
      }
      usersByUid.set(uid, data);
    } catch (error) {
      console.error("agent-chat create_tasks: user load failed", uid, error);
      return response.status(500).json({ error: "Не удалось проверить исполнителей" });
    }
  }

  const createdByName = callerData
    ? (`${callerData.firstName || ""} ${callerData.lastName || ""}`.trim() || callerData.email || "ИИ-агент")
    : "ИИ-агент";
  const description = payload.file
    ? `Создано ИИ-агентом из документа «${payload.file}»`
    : "Создано ИИ-агентом";
  const projectName = project.name || "Проект";

  const batch = db.batch();
  const telegramQueue = [];
  for (const t of payload.tasks) {
    const user = t.assigneeUid ? usersByUid.get(t.assigneeUid) : null;
    // Без исполнителя — «Не назначен», ровно как при ручном создании без
    // выбора ответственного.
    const assigneeDisplay = user
      ? (user.displayName || `${user.firstName || ""} ${user.lastName || ""}`.trim() || user.email || "Исполнитель")
      : "Не назначен";
    const taskRef = db.collection("tasks").doc();
    // Field shape mirrors the client's createTask() exactly, so boards,
    // filters, the reader carve-out and the monitor treat these tasks like any
    // manually created one.
    batch.set(taskRef, {
      projectId: payload.projectId,
      organizationId,
      title: t.title,
      description,
      assignee: assigneeDisplay,
      assigneeEmail: (user && user.email) || "",
      assigneeIds: t.assigneeUid ? [t.assigneeUid] : [],
      deadline: t.deadline,
      status: "in-progress",
      subStatus: "assigned",
      assigneeCompleted: false,
      assignedAt: FieldValue.serverTimestamp(),
      attachments: [],
      createdAt: FieldValue.serverTimestamp(),
      createdBy: createdByName,
      createdByEmail: callerData?.email || "",
      createdByUid: decoded.uid,
    });

    // Уведомление и Telegram — только реальному исполнителю; у задачи «Не
    // назначен» получателя нет.
    if (!user) continue;
    const deadlinePart = t.deadline ? ` Срок: ${t.deadline}.` : "";
    const text = `🆕 Новая задача: «${t.title}». Ответственный: ${assigneeDisplay}.${deadlinePart} Проект «${projectName}». Поставлена ИИ-агентом по поручению: ${createdByName}.`;
    const noteRef = db.collection("agentNotifications").doc();
    batch.set(noteRef, {
      uid: t.assigneeUid,
      organizationId,
      taskId: taskRef.id,
      projectId: payload.projectId,
      type: "tasks_created",
      text,
      createdAt: FieldValue.serverTimestamp(),
      readAt: null,
    });
    if (user.telegramChatId) telegramQueue.push({ chatId: user.telegramChatId, text });
  }

  try {
    await batch.commit();
  } catch (error) {
    console.error("agent-chat create_tasks: batch commit failed", error);
    return response.status(500).json({ error: "Не удалось создать задачи" });
  }
  // Parallel + logged (sendTelegramMessage has its own timeout) — a slow or
  // refused Telegram must neither delay the HTTP response nor fail silently.
  const sendResults = await Promise.allSettled(
    telegramQueue.map((message) => sendTelegramMessage(message.chatId, message.text))
  );
  sendResults.forEach((result, index) => {
    const value = result.status === "fulfilled" ? result.value : null;
    if (result.status === "rejected" || (value && value.ok === false)) {
      console.error("agent-chat create_tasks: telegram send failed", telegramQueue[index].chatId, result.reason || value);
    }
  });

  return response.status(200).json({ ok: true, created: payload.tasks.length });
}

function validateDeleteTasksPayload(body) {
  if (!body || body.action !== "delete_tasks") return { ok: false, error: "Invalid action" };
  const projectId = String(body.projectId || "").trim();
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(projectId)) {
    return { ok: false, error: "Некорректный проект" };
  }
  if (!Array.isArray(body.taskIds)) return { ok: false, error: "Нет списка задач для удаления" };
  const taskIds = [...new Set(body.taskIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (taskIds.length === 0) return { ok: false, error: "Нет задач для удаления" };
  if (taskIds.length > TASK_DELETE_MAX) return { ok: false, error: `Слишком много задач за один раз. Лимит: ${TASK_DELETE_MAX}` };
  if (taskIds.some((id) => !/^[A-Za-z0-9_-]{1,160}$/.test(id))) {
    return { ok: false, error: "Некорректный идентификатор задачи" };
  }
  return { ok: true, projectId, taskIds };
}

async function handleDeleteTasks({ db, response, body, callerData, organizationId }) {
  const payload = validateDeleteTasksPayload(body);
  if (!payload.ok) return response.status(400).json({ error: payload.error });

  let project;
  try {
    const snap = await db.collection("projects").doc(payload.projectId).get();
    project = snap.exists ? snap.data() : null;
  } catch (error) {
    console.error("agent-chat delete_tasks: project load failed", error);
    return response.status(500).json({ error: "Не удалось проверить проект" });
  }
  if (!project || project.organizationId !== organizationId) {
    return response.status(403).json({ error: "Проект не найден в вашей организации" });
  }
  if (!callerCanManageProject(callerData?.orgRole, callerData?.allowedProjects, payload.projectId)) {
    return response.status(403).json({ error: "Недостаточно прав для удаления задач в этом проекте" });
  }

  const refs = payload.taskIds.map((id) => db.collection("tasks").doc(id));
  const loaded = [];
  try {
    for (const ref of refs) {
      const snap = await ref.get();
      if (!snap.exists) {
        return response.status(409).json({ error: "Часть задач уже удалена или изменилась. Запросите карточку удаления заново." });
      }
      const task = snap.data();
      if (task?.projectId !== payload.projectId || (task?.organizationId && task.organizationId !== organizationId)) {
        return response.status(403).json({ error: "Одна из задач не относится к выбранному проекту" });
      }
      loaded.push({ ref, task });
    }
  } catch (error) {
    console.error("agent-chat delete_tasks: task load failed", error);
    return response.status(500).json({ error: "Не удалось проверить задачи" });
  }

  try {
    const batch = db.batch();
    loaded.forEach(({ ref }) => batch.delete(ref));
    await batch.commit();
  } catch (error) {
    console.error("agent-chat delete_tasks: batch commit failed", error);
    return response.status(500).json({ error: "Не удалось удалить задачи" });
  }

  return response.status(200).json({ ok: true, deleted: loaded.length });
}

async function handleDeleteNotification({ db, response, decoded, body }) {
  const id = String(body.id || body.notificationId || "").trim();
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(id)) {
    return response.status(400).json({ error: "Invalid notification id" });
  }

  const ref = db.collection("agentNotifications").doc(id);
  let snap;
  try {
    snap = await ref.get();
  } catch (error) {
    console.error("agent-chat delete_notification: failed to load notification", error);
    return response.status(500).json({ error: "Failed to load notification" });
  }

  if (!snap.exists) return response.status(200).json({ ok: true, deleted: false });
  const notification = snap.data() || {};
  if (notification.uid !== decoded.uid) return response.status(403).json({ error: "Forbidden" });

  let callerOrgId = null;
  try {
    const callerSnap = await db.collection("users").doc(decoded.uid).get();
    callerOrgId = callerSnap.exists ? callerSnap.data()?.organizationId || null : null;
  } catch (error) {
    console.error("agent-chat delete_notification: failed to load caller org", error);
    return response.status(500).json({ error: "Failed to verify notification organization" });
  }
  if (!callerOrgId || notification.organizationId !== callerOrgId) {
    return response.status(403).json({ error: "Forbidden" });
  }

  try {
    await ref.delete();
  } catch (error) {
    console.error("agent-chat delete_notification: failed to delete notification", error);
    return response.status(500).json({ error: "Failed to delete notification" });
  }

  return response.status(200).json({ ok: true, deleted: true });
}

// Pure sliding-window rate-limit decision. Given the user's prior request
// timestamps (ms) and the current time, drop timestamps outside the window and
// decide whether this request is allowed. Returns the new timestamp list to
// persist. Extracted for unit testing; the Firestore read/write lives in the
// handler.
export function evaluateRateLimit(prior, nowMs, windowMs = RATE_LIMIT_WINDOW_MS, max = RATE_LIMIT_MAX) {
  const recent = (Array.isArray(prior) ? prior : []).filter(
    (t) => typeof t === "number" && Number.isFinite(t) && nowMs - t < windowMs
  );
  if (recent.length >= max) return { allowed: false, timestamps: recent };
  return { allowed: true, timestamps: [...recent, nowMs] };
}

// Which project ids this user may see, mirroring the app's access model:
//   owner/admin                    -> null  (all projects)
//   allowedProjects empty/absent   -> null  (all projects, the default)
//   allowedProjects = [ids...]     -> those ids (sentinel entry dropped)
//   allowedProjects = [sentinel]   -> []     (no access to any project)
// `null` means "no filtering"; an array (even empty) means "restrict to these".
export function accessibleProjectIdsFor(userData) {
  if (!userData) return null;
  if (["owner", "admin"].includes(userData.orgRole)) return null;
  const allowed = userData.allowedProjects;
  if (Array.isArray(allowed) && allowed.length > 0) {
    return allowed.filter((id) => id !== NO_ACCESS_SENTINEL);
  }
  return null; // empty/absent = all projects (the default for new members)
}

function userHasProjectAccessForAssignment(userData, projectId) {
  if (!userData || !projectId) return false;
  if (["owner", "admin"].includes(userData.orgRole)) return true;
  const allowed = userData.allowedProjects;
  if (!Array.isArray(allowed) || allowed.length === 0) return true;
  return allowed.includes(projectId);
}

// Bounded context reads — caps so a pathologically large org can't drive
// unbounded Firestore reads. Set far above any realistic small-org size, so for
// normal orgs everything is read (no behaviour change); only a huge org gets a
// bounded sample (and it's logged).
const MAX_CONTEXT_PROJECTS = 200;
const MAX_CONTEXT_TASKS = 1500;
const MAX_CONTEXT_FILES_PER_PROJECT = 30;
const MAX_CONTEXT_USERS = 300;

async function loadOrganizationContext(db, organizationId, accessibleProjectIds = null) {
  // All queries here are single-field (`where(organizationId==)`,
  // `where(projectId in ...)`, `where(extractionStatus==)`), so Firestore's
  // automatic per-field index covers them — no firestore.indexes.json needed.
  const projectsSnap = await db.collection("projects")
    .where("organizationId", "==", organizationId)
    .limit(MAX_CONTEXT_PROJECTS)
    .get();
  let projects = projectsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  if (projectsSnap.size >= MAX_CONTEXT_PROJECTS) {
    console.warn(`agent-chat: project context capped at ${MAX_CONTEXT_PROJECTS} (org ${organizationId})`);
  }

  const usersSnap = await db.collection("users")
    .where("organizationId", "==", organizationId)
    .limit(MAX_CONTEXT_USERS)
    .get();
  const members = usersSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  if (usersSnap.size >= MAX_CONTEXT_USERS) {
    console.warn(`agent-chat: members context capped at ${MAX_CONTEXT_USERS} (org ${organizationId})`);
  }

  // Restrict to the projects this user may see (null = no restriction).
  if (accessibleProjectIds !== null) {
    const allowedSet = new Set(accessibleProjectIds);
    projects = projects.filter((p) => allowedSet.has(p.id));
  }

  // Load tasks BY projectId (not by task.organizationId). Tasks can lack or
  // carry a stale organizationId — the board loads them by projectId and the
  // rules authorize by the PROJECT's org — so querying by task.organizationId
  // would silently miss those tasks and the agent would answer "no tasks" for
  // work the user clearly sees. `where(projectId in ...)` is capped at 10 ids,
  // so chunk and parallelize; a single-field `in` still uses the auto index.
  const projectIds = projects.map((p) => p.id);
  const idChunks = [];
  for (let i = 0; i < projectIds.length; i += 10) idChunks.push(projectIds.slice(i, i + 10));
  const taskSnaps = await Promise.all(
    idChunks.map((chunk) => db.collection("tasks").where("projectId", "in", chunk).limit(MAX_CONTEXT_TASKS).get())
  );
  const tasks = [];
  for (const snap of taskSnaps) {
    for (const doc of snap.docs) {
      if (tasks.length >= MAX_CONTEXT_TASKS) break;
      tasks.push({ id: doc.id, ...doc.data() });
    }
    if (tasks.length >= MAX_CONTEXT_TASKS) break;
  }
  if (tasks.length >= MAX_CONTEXT_TASKS) {
    console.warn(`agent-chat: task context capped at ${MAX_CONTEXT_TASKS} (org ${organizationId})`);
  }

  // Parallelized across projects (was a sequential for-await loop, serializing
  // N Firestore round-trips for N projects). Latency matters here: this
  // endpoint isn't listed in vercel.json's `functions` block (that only
  // configures api/webhook.js's maxDuration: 10), so it runs under Vercel's
  // platform-default function timeout rather than an explicit one — still a
  // real budget an org with many projects could exhaust serially.
  const filesSnaps = await Promise.all(
    projects.map((project) =>
      db
        .collection("projects").doc(project.id).collection("files")
        .where("extractionStatus", "==", "done")
        .limit(MAX_CONTEXT_FILES_PER_PROJECT)
        .get()
    )
  );

  const files = [];
  filesSnaps.forEach((filesSnap, index) => {
    const project = projects[index];
    filesSnap.docs.forEach((doc) => {
      const data = doc.data();
      // projectId is needed by the task-proposal flow to bind proposed tasks
      // to the document's project; compactContext maps it to a NAME for the
      // prompt, so the raw id never leaks to the LLM.
      if (data.extractedText) files.push({ projectId: project.id, projectName: project.name || "без названия", filename: data.filename, extractedText: data.extractedText });
    });
  });

  return { projects, tasks, files, members };
}

// Budget split for CONTEXT_CHAR_LIMIT: 70% reserved for structured
// project/task JSON, 30% for appended file text.
//
// Reasoning: structured data (ids/titles/statuses/deadlines/assignees) is
// dense, high-value signal per character — it's exactly what lets the agent
// answer "what's overdue" or "who owns X" questions, and losing a task from
// it silently would make the agent factually wrong. File text is prose
// (extracted PDF/doc contents) that degrades gracefully when cut mid-sentence
// and is inherently supplementary. A large org (hundreds/thousands of tasks)
// will exhaust the structured budget before ever reaching the file-text
// budget, so 70/30 favors the side that actually breaks correctness when
// missing, while still guaranteeing some room for file context in the common
// (smaller-org) case where structured data doesn't come close to its cap.
const STRUCTURED_BUDGET_RATIO = 0.7;

function compactContext(context) {
  const structuredBudget = Math.floor(CONTEXT_CHAR_LIMIT * STRUCTURED_BUDGET_RATIO);
  let { structured, omittedTaskCount, omittedProjectCount, omittedMemberCount } = buildBoundedStructured(context, structuredBudget);

  // Defense in depth / root-cause guard: buildBoundedStructured's incremental
  // budgeting is only as good as the assumptions baked into it (e.g. that a
  // single project/task entry is reasonably small). If some unanticipated
  // edge case — a single absurdly long name, a future field added to the
  // compact task/project shape, a change to the incremental logic itself —
  // ever lets `structured` exceed its sub-budget, we must never silently
  // return an over-budget (or silently-truncated-with-no-signal) payload.
  // Hard-truncate here as a last resort and ALWAYS disclose it, even though
  // this should be unreachable in normal operation.
  let structuredOverBudget = false;
  if (structured.length > structuredBudget) {
    structuredOverBudget = true;
    structured = structured.slice(0, structuredBudget);
  }

  // Truncation priority: structured project/task data is capped first (see
  // buildBoundedStructured), then whatever budget remains (CONTEXT_CHAR_LIMIT
  // minus the *actual* structured length, not the reserved budget — so a
  // small org that doesn't use its full structured allowance leaves more
  // room for file text) goes to file text, cut at the file boundary.
  let fileBudget = CONTEXT_CHAR_LIMIT - structured.length - 4; // 4 for the two newlines joining them
  const projectNameById = new Map(context.projects.map((p) => [p.id, p.name || "без названия"]));
  const fileTexts = [];
  let filesTruncated = false;
  for (const f of context.files) {
    const projectName = f.projectName || projectNameById.get(f.projectId) || "без проекта";
    const chunk = `Файл "${f.filename}" (проект «${projectName}»):\n${f.extractedText}`;
    if (fileBudget <= 0) {
      filesTruncated = true;
      break;
    }
    if (chunk.length > fileBudget) {
      fileTexts.push(chunk.slice(0, fileBudget));
      filesTruncated = true;
      fileBudget = 0;
      break;
    }
    fileTexts.push(chunk);
    fileBudget -= chunk.length + 2; // 2 for the "\n\n" join between chunks
  }

  let combined = `${structured}\n\n${fileTexts.join("\n\n")}`;
  const notices = [];
  if (omittedProjectCount > 0) {
    notices.push(`...[в контекст не поместилось ${omittedProjectCount} проект(ов) — данные по ним не учтены]`);
  }
  if (omittedTaskCount > 0) {
    notices.push(`...[в контекст не поместилось ${omittedTaskCount} задач(и) — данные по ним не учтены]`);
  }
  if (omittedMemberCount > 0) {
    notices.push(`...[в контекст не поместилось ${omittedMemberCount} участник(ов) — данные по ним не учтены]`);
  }
  if (structuredOverBudget) {
    notices.push("...[данные проектов/задач обрезаны по объёму — часть структурированных данных могла не попасть в контекст]");
  }
  if (filesTruncated) {
    notices.push("...[данные обрезаны по объёму — часть файлов могла не попасть в контекст]");
  }
  if (notices.length) combined += `\n${notices.join("\n")}`;
  return combined;
}

// Budget split *within* the structured sub-budget: projects get a small
// fixed slice, tasks get the remainder.
//
// Reasoning: projects are typically far fewer and lighter (id + name only)
// than tasks, so a small reservation comfortably covers the common case
// while still being a genuine, enforced cap rather than "always include
// everything" (which is exactly the bug this fixes — nothing in
// Firestore/the UI caps how many projects an org can have; a prior review
// found 5,000 empty-name projects alone produce 167,807 chars, 3.7x the
// entire 45,000-char CONTEXT_CHAR_LIMIT, and the projects array participated
// in zero budgeting). Giving tasks "whatever's left" (rather than also a
// fixed ratio of the whole) means a small org with few projects doesn't
// waste reserved-but-unused project budget — tasks get to use it instead,
// since buildBoundedStructured computes the task budget as
// (structuredBudget - actual project JSON length), not a fixed ratio.
const PROJECTS_BUDGET_RATIO = 0.15;
const MEMBERS_BUDGET_RATIO = 0.12;

// Builds the structured projects+tasks JSON incrementally. Both projects and
// tasks are sorted most-recently-created first (createdAt desc; entries
// without a parseable createdAt sort last) and built up one entry at a time,
// stopping once adding the next entry would exceed its respective budget.
// This guarantees `structured` itself is bounded regardless of org size —
// an earlier version serialized the FULL task list unconditionally (~950KB
// for 5,000 tasks against a 45,000-char CONTEXT_CHAR_LIMIT), and a later
// review found the *projects* array had the exact same unbounded-serialization
// bug (167,807 chars for 5,000 projects) that had never been fixed.
//
// Length is tracked incrementally (each entry's own serialized length, plus
// 1 char for the joining comma) rather than re-stringifying the whole
// growing array on every iteration — the latter is O(n^2) and noticeably
// slow for orgs with thousands of tasks/projects.
// Human-readable status matching the board columns the user actually sees.
// The raw `status` field is only 'in-progress'|'done' (legacy 2-value), and
// the real state lives in subStatus/assigneeCompleted — so feeding raw
// status:'in-progress' made the agent wrongly say "в работе" for a task that
// is merely assigned. Mapping (mirrors the board): done -> "готово";
// assigneeCompleted or subStatus 'completed' -> "на проверке"; subStatus
// 'in_work' -> "в работе"; otherwise -> "назначена".
function humanTaskStatus(t) {
  if (t.status === "done") return "готово";
  if (t.assigneeCompleted === true || t.subStatus === "completed") return "на проверке";
  if (t.subStatus === "in_work") return "в работе";
  return "назначена";
}

function buildBoundedStructured(context, budget) {
  // Map internal Firestore doc-ids -> human project names so NO opaque id
  // (e.g. "eQg1UFGwRzGUxCgqGlZc") is ever placed in the model's context and
  // therefore can never leak into a user-facing answer. Tasks reference their
  // project by name, not id.
  const projectNameById = new Map();
  const projects = Array.isArray(context.projects) ? context.projects : [];
  const tasksSource = Array.isArray(context.tasks) ? context.tasks : [];
  const membersSource = Array.isArray(context.members) ? context.members : [];
  for (const p of projects) projectNameById.set(p.id, p.name || "без названия");

  const projectsBudget = Math.floor(budget * PROJECTS_BUDGET_RATIO);
  const membersBudget = Math.floor(budget * MEMBERS_BUDGET_RATIO);
  const sortedProjects = [...projects].sort((a, b) => projectRecency(b) - projectRecency(a));
  const sortedMembers = [...membersSource].sort((a, b) => displayName(a).localeCompare(displayName(b), "ru"));

  const { included: includedProjects, omittedCount: omittedProjectCount, jsonLength: projectsJsonLength } =
    buildBoundedList(sortedProjects, projectsBudget, (p) => ({ name: p.name || "без названия" }));
  const { included: includedMembers, omittedCount: omittedMemberCount, jsonLength: membersJsonLength } =
    buildBoundedList(sortedMembers, membersBudget, (u) => ({
      name: displayName(u) || "без имени",
      role: getRoleNameRu(u.orgRole),
      telegram: Boolean(u.telegramChatId),
      // Активность — агент отвечает «когда последний раз заходил/был в сети»
      // по этим полям (раньше их не было в контексте и агент говорил «нет
      // данных», хотя в системе они есть). Пустые поля опускаем — экономия
      // бюджета и явный сигнал «ещё не заходил».
      ...(formatMskDateTime(u.lastLoginAt || u.lastLogin)
        ? { последний_вход: formatMskDateTime(u.lastLoginAt || u.lastLogin) } : {}),
      ...(formatMskDateTime(u.lastSeenAt || u.lastSeenClientAt)
        ? { был_в_сети: formatMskDateTime(u.lastSeenAt || u.lastSeenClientAt) } : {}),
      ...(Number.isFinite(u.level) ? { уровень: u.level } : {}),
      ...(Number.isFinite(u.totalXP) ? { xp: u.totalXP } : {}),
      ...(Number.isFinite(u.completedTasksCount) ? { задач_завершено: u.completedTasksCount } : {}),
    }));

  // Участники подаются модели ОБЪЕКТОМ «Имя → данные», а не массивом:
  // прод-инцидент — модель, сканируя массив, взяла «последний_вход» СОСЕДНЕЙ
  // записи (спросили про Эльдара, ответила временем Амирхана). Точечный
  // lookup по ключу-имени такой класс ошибок практически исключает.
  const membersByName = {};
  for (const member of includedMembers) {
    const { name, ...rest } = member;
    let key = name;
    let n = 2;
    while (Object.prototype.hasOwnProperty.call(membersByName, key)) {
      key = `${name} (${n})`;
      n += 1;
    }
    membersByName[key] = rest;
  }

  // Tasks get whatever's left of the structured budget after projects
  // actually used their slice (not the reserved projectsBudget) — a small
  // org with few/short project names leaves more room for tasks, the side
  // that's usually much larger and more numerous.
  const tasksBudget = budget - projectsJsonLength - membersJsonLength;
  const sortedTasks = [...tasksSource].sort((a, b) => taskRecency(b) - taskRecency(a));
  const { included: includedTasks, omittedCount: omittedTaskCount } =
    buildBoundedList(sortedTasks, tasksBudget, (t) => ({
      title: t.title, project: projectNameById.get(t.projectId) || "без проекта", assignee: t.assignee,
      deadline: t.deadline, статус: humanTaskStatus(t),
    }));

  const structured = JSON.stringify({ projects: includedProjects, members: membersByName, tasks: includedTasks });
  return { structured, omittedTaskCount, omittedProjectCount, omittedMemberCount };
}

// Shared incremental-budget builder: maps `items` through `toCompact` one at
// a time (in the given, already-sorted order), tracking the running
// serialized-array length, and stops including further items once the next
// one would exceed `budget`. Always includes at least one item (if any exist
// and `budget` isn't absurdly small) so a single pathological entry doesn't
// wipe out the entire category — but that guard itself is bounded by the
// caller-side final structured-length check in compactContext, so a single
// oversized entry can never silently blow the overall budget with zero
// disclosure.
function buildBoundedList(items, budget, toCompact) {
  const skeleton = "[]";
  let runningLength = skeleton.length;
  const included = [];
  let omittedCount = 0;

  for (const item of items) {
    const compact = toCompact(item);
    const json = JSON.stringify(compact);
    const addedLength = json.length + (included.length > 0 ? 1 : 0); // +1 for comma separator
    if (runningLength + addedLength > budget && included.length > 0) {
      omittedCount = items.length - included.length;
      break;
    }
    included.push(compact);
    runningLength += addedLength;
    // Even a single item can't fit (pathological — shouldn't happen with
    // this schema, but avoid silently exceeding budget on the very first item
    // while still guaranteeing at least one entry is present when possible).
    if (runningLength > budget && included.length === 1 && items.length > 1) {
      omittedCount = items.length - 1;
      break;
    }
  }

  const jsonLength = JSON.stringify(included).length;
  return { included, omittedCount, jsonLength };
}

// Extracts a millisecond timestamp from a `createdAt` field for recency
// sorting. Handles Firestore Timestamp objects (`.toDate()`), plain
// `{seconds, nanoseconds}`-shaped objects (what a real Timestamp becomes
// after a JSON.stringify/parse round-trip, or when read via a non-Admin-SDK
// path — reconstructed via `new Date(seconds * 1000)` rather than silently
// falling through to -Infinity, so a genuinely recent task/project isn't
// misordered as "oldest" and preferentially dropped under budget pressure),
// ISO/date strings, and missing values — mirrors the tolerant parsing
// already used for this exact field in script.js. Unparseable/missing
// values sort last (treated as oldest) rather than throwing or defaulting to
// "now", so bad data doesn't unfairly jump to the front of the kept set.
//
// Defensively wrapped end-to-end: `raw` is attacker/data-corruption
// influenced (arbitrary Firestore document content), so ANY property access
// or method call on it — including a malicious/corrupted `.toDate` that
// throws when invoked instead of behaving like a normal method — must never
// propagate an exception out of this function. A single bad record sorting
// as -Infinity (oldest, so it's first in line to be dropped under budget
// pressure) is an acceptable degradation; a crash of the whole request is not.
function recencyOf(raw) {
  try {
    if (!raw) return -Infinity;
    if (typeof raw.toDate === "function") {
      const d = raw.toDate();
      return d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : -Infinity;
    }
    if (typeof raw === "object" && typeof raw.seconds === "number") {
      const ms = raw.seconds * 1000 + (typeof raw.nanoseconds === "number" ? raw.nanoseconds / 1e6 : 0);
      return Number.isNaN(ms) ? -Infinity : ms;
    }
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? -Infinity : d.getTime();
  } catch {
    return -Infinity;
  }
}

function taskRecency(task) {
  return recencyOf(task && task.createdAt);
}

function projectRecency(project) {
  return recencyOf(project && project.createdAt);
}

function normalizeHistory(history) {
  if (!Array.isArray(history)) return [];
  // Any role other than "assistant" collapses to "user" — this is a
  // deliberate allowlist, not just a default. It means a client-supplied
  // `{ role: "system", content: "..." }` turn is coerced to
  // `{ role: "user", ... }` before being spliced into the messages array,
  // so a caller cannot smuggle a second system-prompt-like message past our
  // own SYSTEM_PROMPT_RULES entry (which is always messages[0], added after
  // this history array is built — see handler()). The attacker-controlled
  // text still reaches the model, but only ever framed as a user turn.
  return history.slice(-MAX_HISTORY_TURNS).map((turn) => ({
    role: turn.role === "assistant" ? "assistant" : "user",
    content: String(turn.content || "").slice(0, 2000),
  }));
}

function cleanAnswer(text) {
  if (!text) return "";
  return String(text)
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/в предоставленном контексте/gi, "в данных проекта")
    // Flatten markdown links to their text only: the chat never shows clickable
    // URLs (this also removes the sole link/URL injection surface for the
    // frontend renderer and avoids leaking any id-like link target). All OTHER
    // markdown — tables, lists, **bold**, `code`, headings — is intentionally
    // PRESERVED and rendered safely by the frontend (see renderAgentChatMarkdown).
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .trim();
}

// A chat message + short history is a few KB; cap the accumulated body well
// above that so an oversized/streamed request can't grow the buffer unbounded.
// (Vercel also caps request bodies, but this is explicit and fails fast.)
const MAX_BODY_BYTES = 256 * 1024;

async function parseJsonBody(request) {
  if (request.body && typeof request.body === "object") return request.body;
  if (typeof request.body === "string") {
    if (Buffer.byteLength(request.body, "utf8") > MAX_BODY_BYTES) throw new Error("Request body too large");
    return JSON.parse(request.body || "{}");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("Request body too large");
    chunks.push(Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

export { cleanAnswer, normalizeHistory, compactContext, OFF_TOPIC_RESPONSE };
