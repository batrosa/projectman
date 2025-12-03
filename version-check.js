// Version checker - auto-reload when version changes
const APP_VERSION = "1.9"; // ВАЖНО: Меняйте это число при каждом обновлении!

(function checkVersion() {
    try {
        const storedVersion = localStorage.getItem('app_version');

        // Первый запуск или версия не установлена
        if (!storedVersion) {
            localStorage.setItem('app_version', APP_VERSION);
            console.log(`✅ Установлена версия: ${APP_VERSION}`);
            return;
        }

        // Версия актуальна
        if (storedVersion === APP_VERSION) {
            console.log(`✅ Версия актуальна: ${APP_VERSION}`);
            return;
        }

        // Обнаружена новая версия - обновляем
        console.log(`🔄 Обнаружена новая версия: ${APP_VERSION} (была: ${storedVersion})`);

        // Сохраняем новую версию ПЕРЕД перезагрузкой
        localStorage.setItem('app_version', APP_VERSION);

        // Флаг что мы уже делаем reload (защита от бесконечного цикла)
        const reloadFlag = sessionStorage.getItem('reloading');
        if (reloadFlag) {
            console.warn('⚠️ Reload уже выполняется, пропускаем...');
            return;
        }

        sessionStorage.setItem('reloading', 'true');
        console.log('Принудительное обновление через 500ms...');

        // Небольшая задержка чтобы сообщения успели вывестись
        setTimeout(() => {
            // Принудительная перезагрузка с очисткой кэша
            window.location.reload(true);
        }, 500);

    } catch (error) {
        console.error('❌ Ошибка проверки версии:', error);
        // Не блокируем загрузку если что-то пошло не так
    }
})();
