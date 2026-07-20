# Инструкция по развертыванию Firestore Rules

## Вариант 1: Через Firebase Console (Рекомендуется)

1. Откройте [Firebase Console](https://console.firebase.google.com/)
2. Выберите ваш проект **projectman-96d3c**
3. В левом меню выберите **Firestore Database**
4. Перейдите на вкладку **Rules** (Правила)
5. Скопируйте содержимое файла `firestore.rules` и вставьте в редактор
6. Нажмите **Publish** (Опубликовать)

## Вариант 2: Через Firebase CLI

Если у вас установлен Firebase CLI:

```bash
# Войдите в Firebase (если еще не вошли)
firebase login

# Инициализируйте проект (если еще не инициализирован)
firebase init firestore

# Разверните правила
firebase deploy --only firestore:rules
```

## Что делают эти правила (актуальная модель)

Модель — многоарендная (по организациям) с ролями и покомпонентными замками.
Роли в организации: `owner` / `admin` / `moderator` / `employee` (+ legacy `reader`).
Видимость проектов сужается полем `users.allowedProjects` (пусто/нет = все проекты).

- **users/{userId}**: читать — сам пользователь свой док И участники ТОЙ ЖЕ
  организации (для списка исполнителей/коллег) + Админ; межарендное чтение
  закрыто. Писать — только сам пользователь и только НЕзащищённые поля.
  Защищены (пишет лишь сервер через Admin SDK): `role`, `orgRole`,
  `organizationId`, `allowedProjects`, `telegramChatId`, и игровые счётчики
  `totalXP`/`level`/`completedTasksCount`/`onTimeTasksCount`/`noRevisionTasksCount`.
  Игровые счётчики здесь являются только зеркалом АКТИВНОЙ организации для
  совместимости web/iOS; источником истины служит членство пользователя.
- **organizationMemberships/{orgId}_{userId}**: долговечное членство и роль
  пользователя в конкретной организации. Здесь же отдельно для каждой
  организации хранятся XP, уровень и история выполнения. При первом входе
  старые глобальные показатели восстанавливаются по подтверждённым задачам и
  больше не переносятся между организациями.
- **organizations/{orgId}**: `get` — только участник; `list` запрещён (закрывает
  перебор inviteCode); `create` и `delete` — только сервер (`api/org`); `update`
  — владелец/админ и ТОЛЬКО поле `name` (ownerId неизменяем; `inviteCode`/`plan`/
  `membersCount`/`settings` меняет только сервер через Admin SDK).
- **projects/{projectId}**: чтение — участник организации проекта; запись
  (создание/редактирование самого проекта) — только `owner`/`admin` организации.
- **tasks/{taskId}**: чтение — по организации + доступу к проекту; запись —
  `owner`/`admin` ИЛИ `moderator` с доступом к проекту (`canManageProject`),
  плюс узкий carve-out для исполнителя своей задачи (взять в работу / завершить)
  с проверкой перехода статуса, обязательным подтверждением и серверным
  `completedAt` (без бэкдейта).
- **projects/{projectId}/files/{fileId}**: чтение — по доступу к проекту; запись
  — только сервер (`api/project-files`).

Серверные операции (Admin SDK, в обход правил): создание/вступление/выход/
удаление участника в организации (`api/org`, `api/join-org`), начисление XP
(`api/award-xp`), метаданные файлов (`api/project-files`), Telegram-уведомления
(`api/notify-telegram`).

## Порядок деплоя (важно)

Сначала выкатывай клиент (Vercel), потом правила — иначе ужесточённое правило
ударит по старому клиенту. Команды:

```bash
# 1) клиент + api → Vercel (git push в main запускает деплой)
git push origin main

# 2) правила → Firebase
npx firebase deploy --only firestore:rules --project projectman-96d3c
```

Перед деплоем правил гоняй эмулятор:

```bash
PATH=/opt/homebrew/opt/openjdk/bin:$PATH npm run test:rules
```
