# ProjectMan Operations Runbook

Before any Vercel production action, read [`docs/vercel-protection-incident-runbook.md`](vercel-protection-incident-runbook.md). In particular, do not run rapid production request loops: Vercel's automatic DDoS mitigation can challenge cookieless clients and block iOS even while a browser works.

## Deploy

Порядок важен: сначала клиент/API, потом Firestore rules.

```bash
npm test
PATH=/opt/homebrew/opt/openjdk/bin:$PATH npm run test:rules
npx vercel --prod --yes
npx firebase deploy --only firestore:rules --project projectman-96d3c
```

После deploy выполнить `docs/prod-smoke-checklist.md` один раз, без повторяющихся циклов запросов.

## Rollback

Vercel:

1. Открыть Vercel project `projectman`.
2. Deployments.
3. Promote последний рабочий deployment.

Firestore rules:

1. Firebase Console → Firestore Database → Rules.
2. Открыть Rules history.
3. Roll back на предыдущую версию.

Если ошибка затрагивает и клиент, и rules, сначала откатить Vercel, затем rules.

## Monitoring

Минимум сейчас:

- Vercel deployment status и function logs.
- Firebase Console usage/errors.
- Telegram webhook/API ошибки в Vercel logs.

Рекомендуемое production-дополнение:

| Сервис | Что нужно |
| --- | --- |
| Sentry browser + serverless | DSN, project token, release env |
| Vercel Observability | Включение на проекте/плане |
| Uptime monitor | Health endpoint или проверка `/` + критичных API |

Без DSN/token это корректно не включить в код: будет шум или нерабочая интеграция.

## Backups

Firestore export требует GCP billing и Cloud Storage bucket.

Рекомендуемая схема:

1. Создать bucket, например `gs://projectman-firestore-backups`.
2. Ограничить доступ только владельцам проекта.
3. Настроить scheduled export через Cloud Scheduler/Cloud Functions или регулярный ручной export.
4. Периодически тестировать restore в отдельный Firebase/GCP project.

Ручной export:

```bash
gcloud firestore export gs://projectman-firestore-backups/$(date +%Y-%m-%d)
```

Restore всегда сначала проверять на отдельном проекте, не на production.

## Incident Checklist

1. Зафиксировать время, deployment id, commit hash.
2. Проверить заголовки ответа: `403` с `x-vercel-mitigated: challenge` означает edge protection, а не падение ProjectMan.
3. Проверить Vercel function logs по затронутому API. `500 FUNCTION_INVOCATION_FAILED` — отдельная runtime-ошибка.
4. Проверить Firebase Rules history и недавние деплои rules.
5. Если runtime-ошибка массовая: Vercel rollback/promote известного рабочего deployment.
6. Если ошибка прав доступа: rules rollback.
7. Если сработал Vercel challenge: остановить request loops и действовать по Vercel Protection Incident Runbook.
8. После стабилизации добавить regression test, если причина находилась в коде.

## Audit Logs

Критичные действия организации пишутся сервером в `auditLogs`:

- `org.create`
- `org.regenerateInviteCode`
- `org.leave`
- `org.removeMember`
- `org.delete`

Клиентский доступ к `auditLogs` запрещён Firestore rules. Просмотр выполняется через Firebase Console/GCP tools владельцем инфраструктуры. Если понадобится UI для аудита внутри ProjectMan, его нужно делать отдельным admin-only API, не прямым client read.

## Environment Variables

Критичные production env vars:

- `FIREBASE_SERVICE_ACCOUNT_JSON`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET`
- `FIREBASE_WEB_API_KEY`
- `OPENROUTER_API_KEY`

Нельзя коммитить `.env`, service account JSON, bot token, webhook secret.
