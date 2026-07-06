# HoldingMan iOS

Нативное iOS-приложение HoldingMan (SwiftUI). Работает с **тем же** backend'ом,
что и web-версия: Firebase Auth (те же аккаунты), Firestore (те же организации,
проекты, задачи, роли, уведомления) и Vercel API (ИИ-агент, вход через
Telegram-бота, организации). Ничего не синхронизируется напрямую — все клиенты
ходят в общие сервисы (см. `docs/plans/roadmap.md`, «Принцип архитектуры»).

## Что умеет v1

- **Вход**: email/пароль (Firebase Auth) и «Войти через Telegram» — тот же
  серверный флоу, что в web (`api/telegram-bot-login-start` → открытие бота →
  поллинг → custom token). Статус «Вход подтверждён…» — зелёный.
- **Организации**: список своих организаций (`api/org list`), вход
  (`api/org switch`), вступление по коду (`api/join-org`). Живой слушатель
  собственного документа пользователя ловит смену роли/организации.
- **Проекты**: живой список проектов организации с учётом `allowedProjects`
  (та же семантика доступа, что в web).
- **Канбан**: колонки «Назначенные / В процессе / На проверке / Готово» с
  цветами web-доски, счётчиками и карточками задач; семантика статусов ровно
  как `boardViewForTask` (включая миграцию старых задач без `subStatus`).
- **Гант**: год по месяцам (вписан в экран), тап по месяцу — зум в месяц по
  дням (пружинная анимация), кнопка «Весь год» — обратно; полосы
  «создана → дедлайн» цветом статуса, просроченные с красной обводкой, линия
  «сегодня», выходные затенены; задачи без срока не отображаются (со счётчиком).
- **Задача**: детали, «Взять в работу» для исполнителя (та же форма записи,
  что web `updateTaskSubStatus('in_work')`), удаление менеджером
  с подтверждением, создание задачи менеджером (форма полей как web
  `createTask()`; исполнителей назначает web-версия или ИИ-агент).
- **Мои задачи**: активные задачи текущего пользователя по всем проектам.
- **Уведомления**: живая лента `agentNotifications` (uid + организация),
  бейдж непрочитанных на вкладке, отметка прочитанного тапом, удаление свайпом
  (через `api/agent-chat delete_notification`).
- **ИИ-агент**: тот же протокол, что web — вопросы по данным, карточка
  создания задач с кнопкой подтверждения (`create_tasks`) и карточка
  удаления с красной кнопкой (`delete_tasks`). Выбор целевого проекта — меню
  в правом верхнем углу чата.

## Сборка

Требования: Xcode 16+ с установленной iOS-платформой, [XcodeGen](https://github.com/yonas-kanyo/XcodeGen) (`brew install xcodegen`).

```bash
cd ios
xcodegen generate          # создаёт HoldingMan.xcodeproj из project.yml
open HoldingMan.xcodeproj  # выбрать симулятор и Run
```

Firebase-конфиг не хранится в git. Для локальной сборки скачайте iOS config
из Firebase Console для bundle id `com.holdingman.ios` и положите файл сюда:
`ios/HoldingMan/GoogleService-Info.plist`.

В репозитории есть только пример без реальных значений:
`ios/HoldingMan/GoogleService-Info.example.plist`. Реальный plist содержит
публичные клиентские идентификаторы Firebase, но GitHub Secret Scanning
распознаёт Google API Key как секрет. Поэтому файл игнорируется git; доступ к
данным всё равно должен ограничиваться Firestore rules, серверными проверками
и ограничениями API key в Google Cloud Console.

Для запуска на устройстве: в Xcode → Signing & Capabilities выбрать свою
команду разработчика (bundle id `com.holdingman.ios` можно поменять — тогда
зарегистрируйте новый bundle id в Firebase Console и замените plist).

## Push-уведомления (v2 — код готов, нужен APNs-ключ)

Реализовано (roadmap Этап 3):

- приложение запрашивает разрешение и сохраняет FCM-токен в
  `users/{uid}/devices/{deviceId}` (правила: строго владелец аккаунта);
  при выходе токен отвязывается;
- сервер (`lib/push-send.js`, Admin SDK) шлёт push на все устройства
  получателя и удаляет протухшие токены; интегрировано в:
  `api/agent-monitor` (просрочки, «остался 1 день», «не взята в работу»),
  `api/agent-chat` (задачи, созданные агентом),
  `api/notify-telegram` (новая задача, возврат на доработку — из web и iOS).

Чтобы уведомления реально приходили на iPhone, один раз настройте APNs
(нужен Apple Developer Account):

1. [developer.apple.com](https://developer.apple.com/account/resources/authkeys/list)
   → Keys → «+» → включить **Apple Push Notifications service (APNs)** →
   Continue → Register → **скачать .p8-файл** (даётся один раз), запомнить
   **Key ID** и **Team ID** (правый верхний угол портала).
2. [Firebase Console](https://console.firebase.google.com/project/projectman-96d3c/settings/cloudmessaging)
   → Project settings → Cloud Messaging → **Apple app configuration**
   (com.holdingman.ios) → APNs Authentication Key → **Upload**: .p8-файл +
   Key ID + Team ID.
3. В Xcode: Signing & Capabilities → выбрать команду → capability
   **Push Notifications** добавится из entitlements автоматически.
4. Проверка: войти в приложение на реальном iPhone (симулятор push от FCM не
   получает), разрешить уведомления, затем создать себе задачу через
   ИИ-агента — придёт системный push.

До загрузки ключа всё работает без push: сервер логирует ошибку отправки и
не мешает остальному (fail-open).

## Чего НЕТ в v2 (осознанно)

- **Deep link из push в конкретную задачу** — данные (`taskId`, `projectId`)
  в payload уже есть, обработчик тапа — кандидат на v3.
- **Админ-панели, рейтинга, календаря, файлов проекта** — веб-версия.

## Структура

```
ios/
  project.yml                — XcodeGen-манифест (SPM: FirebaseAuth, FirebaseFirestore)
  HoldingMan/
    App/        HoldingManApp (входная точка), AppState (auth + user doc)
    Support/    Theme (фирменные цвета web-версии)
    Models/     Firestore-модели + карточки предложений агента
    Services/   ApiClient (Vercel API), FirestoreService (живые подписки), AuthService
    Views/      Login, OrgSelect, MainTab, Projects, Board (канбан), Gantt,
                TaskDetail, NewTask, MyTasks, Notifications, AgentChat, Settings
```

`HoldingMan.xcodeproj` генерируется и не хранится в git — правьте `project.yml`.
