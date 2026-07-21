(() => {
    'use strict';

    const CLIENT_ID = '52414300696-6v10cqp7oms0spknk4fvj0ngj5t8nqo2.apps.googleusercontent.com';
    const PARENT_ORIGIN = 'https://projectman.online';

    function notifyParent(payload) {
        if (window.opener && !window.opener.closed) {
            window.opener.postMessage(payload, PARENT_ORIGIN);
        }
    }

    function showError(message) {
        const status = document.getElementById('google-auth-status');
        if (status) {
            status.textContent = message;
            status.classList.add('error');
        }
        notifyParent({ type: 'projectman-google-auth-error', message });
    }

    function handleCredentialResponse(response) {
        if (!response || typeof response.credential !== 'string' || response.credential.length < 20) {
            showError('Google не вернул данные для входа. Попробуйте ещё раз.');
            return;
        }
        notifyParent({
            type: 'projectman-google-auth-success',
            credential: response.credential,
        });
        window.setTimeout(() => window.close(), 50);
    }

    function initializeGoogleIdentity() {
        const googleIdentity = window.google && window.google.accounts && window.google.accounts.id;
        const button = document.getElementById('google-auth-button');
        if (!googleIdentity || !button) {
            showError('Сервис Google не загрузился. Проверьте подключение и попробуйте снова.');
            return;
        }

        googleIdentity.initialize({
            client_id: CLIENT_ID,
            callback: handleCredentialResponse,
            context: 'signin',
            auto_select: false,
            cancel_on_tap_outside: false,
            use_fedcm_for_button: true,
            button_auto_select: false,
        });
        googleIdentity.renderButton(button, {
            type: 'standard',
            theme: 'outline',
            size: 'large',
            text: 'signin_with',
            shape: 'rectangular',
            logo_alignment: 'left',
            width: 320,
            locale: 'ru',
        });
        notifyParent({ type: 'projectman-google-auth-ready' });
        googleIdentity.prompt();
    }

    window.addEventListener('load', initializeGoogleIdentity, { once: true });
})();
