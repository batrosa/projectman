# Production Smoke Checklist

Запускать после каждого production deploy и после изменения Firestore rules.

## Подготовка

- Production URL: `https://projectmanteko.vercel.app`
- Firebase project: `projectman-96d3c`
- Нужны тестовые аккаунты: owner, admin, moderator, employee.
- Нужна тестовая организация, отдельная от боевых клиентов.

## Быстрый технический smoke

```bash
curl -fsSL https://projectmanteko.vercel.app/ | rg "script\\.js\\?v="

for endpoint in /api/agent-chat /api/org /api/notify-telegram /api/project-files; do
  curl -sS -o /tmp/projectman-smoke.txt -w "$endpoint %{http_code}\n" \
    -X POST "https://projectmanteko.vercel.app$endpoint"
done
```

Ожидание: HTML отдаётся, API без Firebase token возвращают `401`, не `500`.

## Роли и UI

| Роль | Проверка | Ожидание |
| --- | --- | --- |
| owner | Создать проект, задачу, назначить исполнителя | Проект/задача создаются |
| owner | Открыть админ-панель, изменить роль/доступы участника | Изменения применяются без relogin или после live-refresh |
| owner | Regenerate invite code | Старый код не должен работать, новый работает |
| admin | Создать проект/задачу, открыть админ-панель | Доступ есть, удалить владельца нельзя |
| moderator с `allowedProjects=[A]` | Создать/изменить задачу в проекте A | Разрешено |
| moderator с `allowedProjects=[A]` | Создать/изменить задачу в проекте B | Запрещено |
| employee | Видеть свои задачи, взять в работу, завершить с proof file | Разрешено |
| employee | Создать проект/удалить задачу/поменять чужую роль | Запрещено |

## Задачи и подтверждения

1. Owner создаёт задачу с исполнителем employee.
2. Employee берёт задачу в работу.
3. Employee пытается завершить без proof-файла.
   Ожидание: UI/rules блокируют.
4. Employee завершает с комментарием и 1 proof-файлом.
5. Owner принимает задачу.
6. Проверить XP/leaderboard: начисление произошло только после принятия.

## Файлы проекта и агент

1. Owner загружает `.md` или `.pdf` до 10 МБ в “Файлы проекта”.
2. Дождаться extraction status.
3. Спросить агента по содержанию файла.
4. Спросить агента: “как контролировать этот проект в ProjectMan?”
   Ожидание: агент не предлагает несуществующие Kanban drag-and-drop, Outlook sync, отчёты, checklists.

## Telegram

1. Войти через Telegram.
2. Создать задачу на пользователя с `telegramChatId`.
3. Проверить уведомление о новой задаче.
4. Вернуть задачу на доработку.
5. Проверить уведомление о доработке.

## Firestore rules spot checks

Выполняются автоматом:

```bash
PATH=/opt/homebrew/opt/openjdk/bin:$PATH npm run test:rules
```

Ручная проверка нужна только если rules менялись и есть сомнение в реальных production данных.
