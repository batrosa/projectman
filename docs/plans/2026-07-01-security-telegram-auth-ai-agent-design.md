# Дизайн: устранение уязвимостей, вход через Telegram, глобальный ИИ-агент и файлы проекта

Дата: 2026-07-01
Статус: согласован с пользователем, готов к implementation-плану

## Контекст

`projectman` — vanilla JS SPA (Firebase Auth + Firestore), деплой на Vercel, одна serverless-функция `api/webhook.js` для Telegram-бота. Полное исследование кодовой базы см. в истории сессии; ключевые находки ниже.

## 1. Firebase vs Supabase

**Решение: остаться на Firebase.** Ни одна из запрошенных задач (фикс уязвимостей, вход через Telegram, файлы+агент) не требует реляционной модели или SQL-уровня RLS. Миграция — риск и время без выгоды. Недостающая часть — сервер с секретами — закрывается добавлением Vercel serverless-функций (уже есть прецедент: `api/webhook.js`), без смены БД.

Референс по аналогичной архитектуре: проект "Матрица кредита" (`~/Desktop/12`) — Vercel Functions + Supabase + OpenRouter. Оттуда переносим паттерн работы с ИИ-агентом и разбора файлов (адаптируя под Firestore вместо Supabase), но НЕ саму БД.

## 2. Устраняемые уязвимости

1. **Bot-токен и Firebase API key захардкожены дважды** (`api/webhook.js:1,6` и `script.js:3,5116`) — токен виден в браузере. → Отозвать через BotFather, обе копии убрать в переменные окружения Vercel.
2. **Дыра в правах организаций** — `firestore.rules` не содержит блока `organizations`, поля `organizationId`/`orgRole` не защищены как `role`/`allowedProjects` → любой авторизованный может выписать себе `orgRole: 'owner'`. Правило-фикс — см. раздел 4.
3. Мёртвый код admin-пароля (`301098`) и экран `admin-verify-screen` — удалить, обновить `readme.md`/`deployment.md`.
4. Отдельный вопрос (не блокирует rollout, обсудить отдельно): токен/ключ уже виден в истории git на GitHub — ротация не убирает его из истории; переписывание истории (`git filter-repo`/BFG + force-push) — отдельное разрушительное действие, требует отдельного согласия пользователя.

## 3. Вход через Telegram (полная замена email/пароль)

Поток:
1. Telegram Login Widget на фронтенде → возвращает `{id, first_name, last_name, username, photo_url, auth_date, hash}`.
2. Новая функция `api/telegram-auth.js` проверяет HMAC-SHA256 подпись (ключ — `SHA256(bot_token)`, токен только в env на сервере) и свежесть `auth_date` (защита от replay).
3. Ищет `users`-документ с `telegramId == id`. Если найден — минтит Firebase custom token через Admin SDK на существующий `uid`. Если нет — создаёт новый аккаунт `uid = tg_<telegram_id>`, `orgRole` не выставляется (пользователь проходит обычный org-join/create экран после первого входа), `telegramChatId`/`telegramUsername` заполняются сразу.
4. Клиент: `signInWithCustomToken(token)`.

Экран "подключить Telegram для уведомлений" в настройках удаляется — уведомления работают сразу, т.к. `telegramChatId` есть с момента регистрации.

**Известное ограничение**: Telegram Login Widget не отдаёт email, поэтому автоматически связать новый вход с существующим email/password-аккаунтом невозможно. Для уже зарегистрированных членов команды: при первом входе через Telegram будет создан новый аккаунт, администратору нужно вручную перенести `orgRole`/`allowedProjects` на новый uid (или вручную проставить `telegramId` в старый документ через консоль/скрипт до первого входа сотрудника). Учитывая размер команды, это разовая ручная операция, не автоматизирую отдельным flow, если не попросите.

**Требуется от вас**: зарегистрировать домен приложения у @BotFather (`/setdomain`) для работы Login Widget.

## 4. Обновления Firestore Security Rules

```
match /organizations/{orgId} {
  allow read: if request.auth != null;
  allow create: if request.auth != null && request.resource.data.ownerId == request.auth.uid;
  allow update, delete: if request.auth != null && (
    resource.data.ownerId == request.auth.uid ||
    get(/databases/$(database)/documents/users/$(request.auth.uid)).data.orgRole in ['owner', 'admin']
  );
}
```

В `users/{userId}`: расширить защищённые поля и добавить точечный self-service карве-аут только для присоединения по инвайт-коду с минимальной ролью:

```
function notUpdatingRestrictedFields() {
  return !request.resource.data.diff(resource.data).affectedKeys().hasAny(['role', 'allowedProjects']);
}
function isSelfServiceOrgJoin() {
  return request.resource.data.diff(resource.data).affectedKeys().hasOnly(['organizationId', 'orgRole'])
    && request.resource.data.orgRole == 'employee';
}
allow update: if (request.auth != null && request.auth.uid == userId
                   && (notUpdatingRestrictedFields() || isSelfServiceOrgJoin()))
              || isAdmin();
```

Это блокирует самоповышение до owner/admin/moderator напрямую через Firestore SDK, сохраняя рабочим текущий сценарий `joinOrganization()`.

Деплой правил — после подтверждения доступа к проекту `projectman-96d3c` (см. блокер по Firebase-доступу, решается параллельно).

## 5. Архитектура бэкенда

Новые Vercel serverless-функции (Node.js/ESM, по аналогии с `api/webhook.js` и паттерном из `~/Desktop/12`):

- `api/telegram-auth.js` — вход через Telegram (раздел 3)
- `api/agent-chat.js` — глобальный ИИ-агент (раздел 7)
- `api/project-files.js` — метаданные загруженных файлов + запуск разбора текста (раздел 6)
- `lib/firebase-admin.js` — инициализация Admin SDK (service account из env, только на сервере)
- `lib/openrouter-config.js` — список моделей + `fetchWithTimeout`, портируется из `~/Desktop/12` почти без изменений
- `lib/material-parser.js` — разбор docx/xlsx/pdf/md, портируется из `~/Desktop/12` практически один в один (самодостаточный модуль, не завязан на Supabase)

Новые секреты в Vercel env: `OPENROUTER_API_KEY`, `FIREBASE_SERVICE_ACCOUNT_JSON`, обновлённый `TELEGRAM_BOT_TOKEN` (ротированный).

## 6. Файлы проекта: загрузка, разбор, хранение

Новая подколлекция `projects/{projectId}/files/{fileId}`:
```
{ filename, url, mimeType, sizeBytes, uploadedBy, uploadedAt,
  extractionStatus: 'pending' | 'done' | 'error',
  extractedText, extractionWarnings }
```

Поток загрузки (отличается от `~/Desktop/12`, т.к. у нас уже есть Cloudinary — не нужен base64-транспорт через свою функцию):
1. Клиент грузит файл в Cloudinary тем же unsigned-preset каналом, что уже работает для вложений задач, `resource_type: raw` для pdf/docx/xlsx, расширяем допустимые типы на `.md`.
2. Клиент вызывает `POST /api/project-files` с метаданными + `secure_url` (маленький payload, без base64).
3. Функция скачивает файл по `secure_url`, извлекает текст через `material-parser.js` (docx/xlsx — `fflate` + regex по XML; pdf — `pdf-parse`; md — как текст), пишет результат в Firestore.
4. Ответ клиенту — сразу после шага 2 (`queued`), разбор — в фоне (`waitUntil`), UI показывает статус `pending → done`.

Лимиты: переиспользуем существующий `maxFileSize: 10MB`; текст обрезается до ~70 000 символов с явным предупреждением (без молчаливого урезания), по аналогии с `~/Desktop/12`.

## 7. Глобальный ИИ-агент

Доступ: всем в организации, контекст — вся организация целиком (задачи/сроки/статусы всех проектов + извлечённый текст всех файлов), без ограничения по `allowedProjects` — так решено пользователем осознанно.

**Отступление от паттерна `~/Desktop/12`**: там контекст пересылает клиент (у него уже есть весь стейт). Здесь так делать нельзя — у рядового сотрудника браузер физически не содержит данных по чужим `allowedProjects`, и доверять клиентским данным для агрегации небезопасно. Поэтому `api/agent-chat.js` сам читает Firestore через Admin SDK (обходя security rules легитимно, т.к. это доверенный бэкенд) — все `tasks`/`projects` организации + `extractedText` файлов.

Остальное — паттерн `chat.js` переносится:
- Модели: `openai/gpt-oss-120b` основная, `openai/gpt-oss-20b` запасная.
- Один запрос, без streaming, `fetchWithTimeout` (~9с), линейный перебор моделей, один retry с backoff только на последней модели при 429/5xx.
- Бюджет контекста по символам с приоритетной обрезкой при превышении (без молчаливой потери — предупреждение в системном промпте, что часть данных не поместилась).
- Код-уровневые защиты от галлюцинаций: обрезка `<think>`/reasoning-тегов, переписывание фраз-хеджей ("в предоставленном контексте" → "в данных проекта"), детект утечки рассуждений не на русском.
- Честность: если факта нет — прямо говорить, что его нет, не выдумывать кнопки/разделы/статусы, которых нет в интерфейсе.
- Ошибки LLM никогда не всплывают как 5xx клиенту — только честный резервный ответ с 200; 401/400 — только на auth/валидацию.

**Не переносим**: очередь подтверждений (approval_queue) и автоматическое изменение задач на основе файлов — этого не просили, агент только читает и отвечает.

## 8. Деплой

1. `firebase deploy --only firestore:rules` — после получения доступа к `projectman-96d3c`.
2. Новые env-переменные добавить в Vercel dashboard.
3. `git push` в main (у Vercel уже настроен auto-deploy из GitHub) либо `vercel --prod` вручную — уточнить у пользователя перед первым продовым деплоем.

## 9. Явно не делаем сейчас

- Автоматическое связывание Telegram-входа с существующими email-аккаунтами (нет email от Telegram) — ручной перенос при необходимости.
- Кэширование агрегированного контекста агента — при текущем масштабе команды не нужно.
- Переписывание git-истории для полного удаления утёкших секретов — отдельное решение, если пользователь захочет.
