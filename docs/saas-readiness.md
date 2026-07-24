# ProjectSfera SaaS Readiness

Дата ревизии: 2026-07-02.

## Уже закрыто в продукте

| Блок | Статус | Проверка |
| --- | --- | --- |
| Прод-деплой | Работает через Vercel production alias `projectmanteko.vercel.app` | `npx vercel --prod --yes`, prod smoke |
| Аутентификация | Firebase Auth + Telegram login/bot login | `api/telegram-*.test.js` |
| Организации и роли | `owner/admin/moderator/employee`, доступы по организации и проектам | `firestore-tests/*.rules.test.js` |
| Firestore rules | Закрыты self-escalation, cross-tenant reads, client-side org create/delete, server-only поля | `npm run test:rules` |
| ИИ-агент | Ограничен реальным функционалом ProjectSfera и доступными проектами пользователя | `api/agent-chat.test.js` |
| Файлы проекта | Серверная запись метаданных, лимит 10 МБ, допустимые расширения | `api/project-files.test.js` |
| Telegram notifications | Требуют Firebase token, получатель должен быть в той же организации | `api/notify-telegram.test.js` |
| XP/статистика | Начисление server-side, клиент не может сам себе записать XP/счётчики | `api/award-xp.test.js`, rules tests |
| Удаление организации | Server-side cascade через `api/org deleteOrg` | `api/org.js`, rules tests |
| XSS в отображении файлов | Имена/URL вложений рендерятся безопасно | `script.xss.test.js`, `lib/escape-html.test.js` |
| Audit trail | Критичные org-операции пишутся server-side в `auditLogs`; клиентский read/write запрещён | `api/org.js`, `firestore.rules` |

## Сделано как операционная база

- `docs/prod-smoke-checklist.md` — ручной smoke-чеклист перед/после релиза.
- `docs/operations-runbook.md` — деплой, rollback, мониторинг, бэкапы, инциденты.
- `docs/legal/privacy-policy-draft.md` — черновик политики конфиденциальности.
- `docs/legal/terms-of-service-draft.md` — черновик пользовательских условий.

## Что нельзя корректно завершить без внешних решений

| Блок | Что нужно |
| --- | --- |
| Оплата и тарифы | Stripe/ЮKassa/CloudPayments аккаунт, юрлицо/самозанятый/ИП, валюта, тарифы, вебхуки, возвраты, чеки |
| Production monitoring | Выбор Sentry/Vercel Observability/другого APM, DSN/token, политика хранения ошибок |
| Автобэкапы | GCP billing + Cloud Storage bucket + расписание Firestore export, доступ на restore |
| Юридические документы | Реквизиты оператора, контакт поддержки, юрпроверка privacy/terms, политика cookie/152-ФЗ/GDPR при необходимости |
| Ручной E2E под ролями | Реальные тестовые пользователи/Telegram-аккаунты и тестовая организация в production |

## Рекомендованный следующий порядок

1. Создать production тестовую организацию и 4 тестовых пользователя: owner, admin, moderator, employee.
2. Пройти `docs/prod-smoke-checklist.md` руками после каждого релиза.
3. Подключить мониторинг ошибок до оплаты: сначала ловить реальные падения API/браузера.
4. Настроить Firestore backups до коммерческого использования.
5. После этого подключать оплату и тарифные лимиты.
