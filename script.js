// Firebase Config
const firebaseConfig = {
    apiKey: "AIzaSyBqNCgLUmlxfIKlDCwmx0-9D-JJm63RpuU",
    authDomain: "projectman-96d3c.firebaseapp.com",
    projectId: "projectman-96d3c",
    storageBucket: "projectman-96d3c.firebasestorage.app",
    messagingSenderId: "52414300696",
    appId: "1:52414300696:web:8dd04516cfd1c9668b796d"
};

// Cloudinary Config for file uploads
const cloudinaryConfig = {
    cloudName: "dwoa1lqz1",
    uploadPreset: "projectman",
    maxFileSize: 10 * 1024 * 1024, // 10 MB
    maxFiles: 2
};

// Pending attachments for new/edited task
let pendingAttachments = [];

// Sound Effect - DISABLED
function playClickSound() {
    // Sound removed per user request
}

// ========== APP START ==========
let pendingInviteCode = null; // Store invite code from URL
let pendingTaskLink = null; // Telegram/email deep-link, applied after the org projects load
let pendingTaskLinkInFlight = false;
let pendingTaskOrgEntryInFlight = false;
const DEEP_LINK_ID_RE = /^[A-Za-z0-9_-]{1,160}$/;

function proceedToApp() {
    // DON'T hide loading screen here - let it stay until fully loaded
    // Just initialize Firebase - onAuthStateChanged will handle the rest
    initFirebase();
}

// Unified async-button feedback. Preserve the exact original markup (icons,
// spans and accessible text), then place the spinner inside the pressed button
// until its operation finishes. WeakMap avoids serialising user-controlled
// labels into data attributes or rebuilding them through unsafe innerHTML.
const buttonLoadingStates = new WeakMap();

function setButtonLoading(button, isLoading, loadingText = '') {
    if (!button) return;

    if (isLoading) {
        if (!buttonLoadingStates.has(button)) {
            buttonLoadingStates.set(button, {
                html: button.innerHTML,
                disabled: button.disabled,
            });
        }
        const label = String(loadingText || button.textContent || '').trim();
        const spinner = document.createElement('span');
        spinner.className = 'btn-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        button.replaceChildren(spinner);
        if (label) {
            const text = document.createElement('span');
            text.className = 'btn-loading-label';
            text.textContent = label;
            button.appendChild(text);
        }
        button.disabled = true;
        button.classList.add('is-loading');
        button.setAttribute('aria-busy', 'true');
        return;
    }

    const state = buttonLoadingStates.get(button);
    if (state) {
        button.innerHTML = state.html;
        button.disabled = state.disabled;
        buttonLoadingStates.delete(button);
    }
    button.classList.remove('is-loading');
    button.removeAttribute('aria-busy');
}

// Synchronous controls also acknowledge touch/mouse input immediately. Async
// controls keep the stronger .is-loading state above until completion.
function installGlobalButtonPressFeedback() {
    let pressedButton = null;
    const release = (button) => {
        if (!button) return;
        window.setTimeout(() => button.classList.remove('button-press-feedback'), 90);
    };
    document.addEventListener('pointerdown', (event) => {
        const button = event.target.closest?.('button');
        if (!button || button.disabled) return;
        if (pressedButton && pressedButton !== button) release(pressedButton);
        pressedButton = button;
        button.classList.add('button-press-feedback');
    }, { passive: true });
    const releasePressed = () => {
        release(pressedButton);
        pressedButton = null;
    };
    document.addEventListener('pointerup', releasePressed, { passive: true });
    document.addEventListener('pointercancel', releasePressed, { passive: true });
}

installGlobalButtonPressFeedback();

// ========== LOADING SCREEN ==========
const loadingTips = [
    "Нажмите на статус задачи, чтобы изменить его",
    "Используйте боковое меню для переключения проектов",
    "Исполнитель отмечает задачу, админ подтверждает",
    "К каждой задаче можно прикрепить до 2 файлов",
    "Переключайте тему в боковом меню",
    "Кнопка «Мои задачи» покажет все ваши задачи",
    "Админ может управлять доступом к проектам",
    "Следите за сроками — просроченные задачи выделяются",
    "Задачи автоматически сортируются по статусу",
    "Создавайте проекты для разных направлений работы"
];

let tipInterval = null;

function startLoadingTips() {
    const tipElement = document.getElementById('loading-tip');
    if (!tipElement) return;

    // Show first tip
    tipElement.textContent = loadingTips[Math.floor(Math.random() * loadingTips.length)];

    // Rotate tips every 2.5 seconds
    tipInterval = setInterval(() => {
        tipElement.textContent = loadingTips[Math.floor(Math.random() * loadingTips.length)];
    }, 2500);
}

function hideLoadingScreen() {
    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen && !loadingScreen.classList.contains('hidden')) {
        loadingScreen.classList.add('hidden');

        // Stop tip rotation
        if (tipInterval) {
            clearInterval(tipInterval);
            tipInterval = null;
        }

        // Remove from DOM after animation
        setTimeout(() => {
            loadingScreen.style.display = 'none';
        }, 400);
    }
}

// Fix mobile viewport height issues (Android address bar / 100vh bugs)
function setViewportHeightVar() {
    try {
        const vh = window.innerHeight * 0.01;
        document.documentElement.style.setProperty('--vh', `${vh}px`);
    } catch (e) {
        // no-op
    }
}

// Auto-fix broken cache on mobile - detects if CSS failed to load properly
function checkAndFixBrokenCache() {
    if (hasActiveTelegramBotLogin()) return;

    // Check if main app container has proper layout
    const appContainer = document.querySelector('.app-container');
    const sidebar = document.querySelector('.sidebar');

    if (appContainer && sidebar) {
        const appStyles = window.getComputedStyle(appContainer);
        const sidebarStyles = window.getComputedStyle(sidebar);

        // If flexbox isn't working or sidebar isn't properly styled on mobile
        const isMobile = window.innerWidth <= 768;
        if (isMobile) {
            const sidebarTransform = sidebarStyles.transform;
            const sidebarPosition = sidebarStyles.position;

            // If sidebar isn't properly hidden on mobile (no transform or not fixed)
            if (sidebarPosition !== 'fixed' ||
                (sidebarTransform === 'none' && !sidebar.classList.contains('active'))) {
                console.warn('Detected broken CSS state, attempting recovery...');

                // Force clear cache and reload
                if ('caches' in window) {
                    caches.keys().then(names => {
                        names.forEach(name => caches.delete(name));
                    }).then(() => {
                        if ('serviceWorker' in navigator) {
                            navigator.serviceWorker.getRegistrations().then(regs => {
                                regs.forEach(reg => reg.unregister());
                                // Reload after clearing
                                setTimeout(() => window.location.reload(true), 100);
                            });
                        } else {
                            window.location.reload(true);
                        }
                    });
                }
            }
        }
    }
}

// Start tips immediately and init PIN screen
document.addEventListener('DOMContentLoaded', () => {
    // Set viewport height CSS variable early (prevents broken layout on some Android devices)
    setViewportHeightVar();
    window.addEventListener('resize', setViewportHeightVar);
    window.addEventListener('orientationchange', setViewportHeightVar);

    // Capture invite code from URL immediately (before auth flow)
    captureInviteCodeFromUrl();

    startLoadingTips();

    // Check for broken cache after a short delay (after CSS should be applied)
    setTimeout(checkAndFixBrokenCache, 1500);

    // Disable double-tap zoom on mobile
    let lastTouchEnd = 0;
    document.addEventListener('touchend', (e) => {
        const now = Date.now();
        if (now - lastTouchEnd <= 300) {
            e.preventDefault();
        }
        lastTouchEnd = now;
    }, { passive: false });

    // Disable pinch zoom
    document.addEventListener('gesturestart', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('gesturechange', (e) => e.preventDefault(), { passive: false });
    document.addEventListener('gestureend', (e) => e.preventDefault(), { passive: false });

    // Short delay to ensure CSS is loaded, then start app
    setTimeout(() => {
        // Don't hide loading screen - it will hide when fully logged in
        proceedToApp();
    }, 500);
});

// ========== FILE ATTACHMENT FUNCTIONS ==========

// Get file type category
function getFileType(filename) {
    const ext = filename.split('.').pop().toLowerCase();
    if (['pdf'].includes(ext)) return 'pdf';
    if (['doc', 'docx'].includes(ext)) return 'word';
    if (['xls', 'xlsx'].includes(ext)) return 'excel';
    if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) return 'image';
    if (['zip', 'rar', '7z'].includes(ext)) return 'archive';
    return 'other';
}

// Get icon for file type
function getFileIcon(fileType) {
    const icons = {
        pdf: 'fa-file-pdf',
        word: 'fa-file-word',
        excel: 'fa-file-excel',
        image: 'fa-file-image',
        archive: 'fa-file-zipper',
        other: 'fa-file'
    };
    return icons[fileType] || 'fa-file';
}

// Format file size
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// Guard against attacker-controlled attachment URLs (e.g. a Firestore-sourced
// attachment.url set to "javascript:alert(1)") being used as an href/window.open
// target. Only allow http(s) and known-safe Cloudinary-style protocol-relative
// paths; anything else (javascript:, data:, vbscript:, etc.) is neutralized.
function sanitizeAttachmentUrl(url) {
    if (typeof url !== 'string') return '#';
    const trimmed = url.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (trimmed.startsWith('//')) return trimmed;
    if (trimmed.startsWith('/')) return trimmed;
    return '#';
}

// Upload file to Cloudinary
async function uploadToCloudinary(file) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', cloudinaryConfig.uploadPreset);
    // Folder is already defined in the Preset settings

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000); // 60 second timeout

    try {
        console.log('Starting upload to Cloudinary...', { fileName: file.name, fileSize: file.size });
        const startTime = Date.now();

        const response = await fetch(
            `https://api.cloudinary.com/v1_1/${cloudinaryConfig.cloudName}/auto/upload`,
            {
                method: 'POST',
                body: formData,
                mode: 'cors',
                signal: controller.signal
            }
        );

        clearTimeout(timeoutId);
        console.log('Upload response received in', Date.now() - startTime, 'ms');

        if (!response.ok) {
            let errorMsg = response.statusText;
            try {
                const errorData = await response.json();
                console.error('Cloudinary error:', errorData);
                errorMsg = errorData.error?.message || response.statusText;
            } catch (e) {
                console.error('Could not parse error response');
            }
            throw new Error(errorMsg);
        }

        const result = await response.json();
        console.log('Upload complete:', result.secure_url);
        return result;
    } catch (error) {
        clearTimeout(timeoutId);
        console.error('Upload fetch error:', error);

        // Handle different error types
        if (error.name === 'AbortError') {
            throw new Error('Загрузка слишком долгая. Проверьте интернет или попробуйте файл меньшего размера');
        }
        if (error.message === 'Failed to fetch' || error.message === 'Load failed') {
            throw new Error('Ошибка сети. Проверьте подключение к интернету');
        }
        throw error;
    }
}

// Handle file selection
async function handleFileSelect(event) {
    console.log('handleFileSelect called');
    const file = event.target.files[0];
    if (!file) {
        console.log('No file selected');
        return;
    }

    console.log('File selected:', file.name, file.size);

    // Reset input
    event.target.value = '';

    // Check file count
    if (pendingAttachments.length >= cloudinaryConfig.maxFiles) {
        alert(`Максимум ${cloudinaryConfig.maxFiles} файла на задачу`);
        return;
    }

    // Check file size
    if (file.size > cloudinaryConfig.maxFileSize) {
        alert(`Файл слишком большой. Максимум ${formatFileSize(cloudinaryConfig.maxFileSize)}`);
        return;
    }

    // Create temp attachment item
    const tempId = 'temp_' + Date.now();
    const fileType = getFileType(file.name);
    const tempAttachment = {
        id: tempId,
        name: file.name,
        size: file.size,
        type: fileType,
        uploading: true
    };

    pendingAttachments.push(tempAttachment);
    renderAttachmentsList();
    updateAddAttachmentBtn();

    try {
        console.log('Uploading to Cloudinary...');
        // Upload to Cloudinary
        const result = await uploadToCloudinary(file);
        console.log('Upload result:', result);

        // Update attachment with real data
        const index = pendingAttachments.findIndex(a => a.id === tempId);
        if (index !== -1) {
            pendingAttachments[index] = {
                name: file.name,
                url: result.secure_url,
                type: fileType,
                size: file.size,
                publicId: result.public_id,
                uploadedAt: new Date().toISOString()
            };
        }

        renderAttachmentsList();
        playClickSound();
    } catch (error) {
        console.error('Upload error:', error);
        alert('Ошибка при загрузке файла: ' + error.message);

        // Remove failed attachment
        pendingAttachments = pendingAttachments.filter(a => a.id !== tempId);
        renderAttachmentsList();
        updateAddAttachmentBtn();
    }
}

// Render attachments list in modal
function renderAttachmentsList() {
    const list = document.getElementById('attachments-list');
    if (!list) return;

    list.innerHTML = '';

    pendingAttachments.forEach((attachment, index) => {
        const item = document.createElement('div');
        item.className = 'attachment-item' + (attachment.uploading ? ' uploading' : '');

        const iconClass = getFileIcon(attachment.type);

        item.innerHTML = `
            <div class="attachment-icon ${attachment.type}">
                <i class="fa-solid ${iconClass}"></i>
            </div>
            <div class="attachment-info">
                <div class="attachment-name">${escapeHtml(attachment.name)}</div>
                <div class="attachment-size">${attachment.uploading ? 'Загрузка...' : formatFileSize(attachment.size)}</div>
            </div>
            ${!attachment.uploading ? `
                <button type="button" class="attachment-remove" data-index="${index}">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            ` : ''}
        `;

        list.appendChild(item);
    });

    // Add remove handlers
    list.querySelectorAll('.attachment-remove').forEach(btn => {
        btn.onclick = (e) => {
            e.preventDefault();
            const index = parseInt(btn.dataset.index);
            pendingAttachments.splice(index, 1);
            renderAttachmentsList();
            updateAddAttachmentBtn();
            playClickSound();
        };
    });
}

// Update add attachment button state
function updateAddAttachmentBtn() {
    const btn = document.getElementById('add-attachment-btn');
    if (!btn) return;

    if (pendingAttachments.length >= cloudinaryConfig.maxFiles) {
        btn.disabled = true;
        btn.innerHTML = '<i class="fa-solid fa-check"></i> Максимум файлов';
    } else {
        btn.disabled = false;
        btn.innerHTML = '<i class="fa-solid fa-plus"></i> Прикрепить файл';
    }
}

// Open file preview
function openFilePreview(attachment) {
    console.log('Opening file preview:', attachment);

    if (!attachment || !attachment.url) {
        console.error('Invalid attachment or missing URL:', attachment);
        alert('Ошибка: файл не найден');
        return;
    }

    const fileType = attachment.type || getFileType(attachment.name);
    console.log('File type:', fileType);
    console.log('File URL:', attachment.url);

    const safeUrl = sanitizeAttachmentUrl(attachment.url);

    // 1. OFFICE DOCUMENTS (Word, Excel) -> Download directly (most reliable)
    if (['word', 'excel'].includes(fileType)) {
        // Create download link
        const link = document.createElement('a');
        link.href = safeUrl;
        link.download = attachment.name || 'file';
        link.target = '_blank';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        playClickSound();
        return;
    }

    // 2. IMAGES & PDF -> Direct in new tab
    // 3. ARCHIVES/OTHERS -> Direct (will trigger download)

    // Try opening directly
    const newWindow = window.open(safeUrl, '_blank');

    if (!newWindow) {
        alert('Не удалось открыть файл. Возможно, заблокировано всплывающее окно.');
    }

    playClickSound();
}

// Show no preview available
function showNoPreview(container, attachment) {
    const fileType = attachment.type || getFileType(attachment.name);
    const iconClass = getFileIcon(fileType);
    const safeUrl = sanitizeAttachmentUrl(attachment.url);

    container.innerHTML = `
        <div class="no-preview">
            <i class="fa-solid ${iconClass}"></i>
            <p>Предпросмотр недоступен для этого типа файла</p>
            <a href="${escapeHtml(safeUrl)}" download="${escapeHtml(attachment.name)}" class="primary-btn">
                <i class="fa-solid fa-download"></i> Скачать файл
            </a>
        </div>
    `;
}

// Open files list modal for task
function openFilesListModal(attachments) {
    console.log('Opening files list modal:', attachments); // Debug

    const modal = document.getElementById('files-list-modal');
    const list = document.getElementById('files-modal-list');

    if (!modal || !list) {
        console.error('Files list modal elements not found');
        return;
    }

    if (!attachments || attachments.length === 0) {
        console.error('No attachments provided');
        return;
    }

    list.innerHTML = '';

    attachments.forEach(attachment => {
        const fileType = attachment.type || getFileType(attachment.name);
        const iconClass = getFileIcon(fileType);

        const item = document.createElement('div');
        item.className = 'file-list-item';
        // Force download URL (clean), guarding against non-http(s) schemes
        // (e.g. javascript:) in a Firestore-sourced attachment.url.
        let downloadUrl = sanitizeAttachmentUrl(attachment.url);

        // Google Docs Viewer URL for Office files
        let viewUrl = downloadUrl;
        let isViewable = true;

        if (['word', 'excel', 'ppt'].includes(fileType)) {
            viewUrl = `https://docs.google.com/viewer?url=${encodeURIComponent(downloadUrl)}&embedded=false`;
        } else if (!['pdf', 'image'].includes(fileType)) {
            // For archives etc, view acts same as download
            isViewable = false;
        }

        item.innerHTML = `
            <div class="attachment-icon ${fileType}">
                <i class="fa-solid ${iconClass}"></i>
            </div>
            <div class="attachment-info">
                <div class="attachment-name">${escapeHtml(attachment.name)}</div>
                <div class="attachment-size">${formatFileSize(attachment.size || 0)}</div>
            </div>
            <div class="file-actions" style="display: flex; gap: 10px; align-items: center;">
                ${isViewable ? `
                <div class="action-btn view-btn" title="Просмотреть">
                    <i class="fa-solid fa-eye"></i>
                </div>` : ''}
                <a href="${escapeHtml(downloadUrl)}" target="_blank" download="${escapeHtml(attachment.name)}" class="action-btn download-link" title="Скачать">
                    <i class="fa-solid fa-download"></i>
                </a>
            </div>
        `;

        // Click handler
        item.onclick = (e) => {
            // Handle download link click - stop propagation
            if (e.target.closest('.download-link')) {
                e.stopPropagation();
                return;
            }

            // Handle view click or row click (if viewable)
            if (isViewable) {
                e.stopPropagation();
                modal.classList.remove('active');
                window.open(viewUrl, '_blank');
                playClickSound();
            }
        };

        list.appendChild(item);
    });

    modal.classList.add('active');
    playClickSound();
}

// ========== END FILE ATTACHMENT FUNCTIONS ==========

// ========== ORGANIZATION FUNCTIONS ==========

// Call the server-side organization endpoint (api/org). Create / preview /
// regenerate-code all run server-side via the Admin SDK, so the `organizations`
// collection can stay non-listable on the client — closing the invite-code
// enumeration hole. Invite-code generation and uniqueness checks live there too.
async function callOrgApi(action, payload = {}) {
    const currentUser = firebase.auth().currentUser;
    if (!currentUser) throw new Error('Не авторизован');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('/api/org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ action, ...payload }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || 'Ошибка сервера');
    return result;
}

// Create organization (server-side: validates name uniqueness, generates a
// unique invite code, creates the org and makes the caller its owner).
async function createOrganization(name) {
    if (!state.currentUser) throw new Error('Не авторизован');
    orgSwitchInProgress = true;
    try {
        const result = await callOrgApi('create', { name: name.trim() });
        const org = result.organization;
        state.currentUser.organizationId = org.id;
        state.currentUser.orgRole = 'owner';
        state.currentUser.allowedProjects = [];
        state.orgRole = 'owner';
        return org;
    } finally {
        setTimeout(() => { orgSwitchInProgress = false; }, 0);
    }
}

// Join organization by invite code
async function joinOrganization(inviteCode) {
    if (!state.currentUser) throw new Error('Не авторизован');

    const code = inviteCode.toUpperCase().trim();

    // Joining is validated SERVER-SIDE (api/join-org) with the Admin SDK: the
    // invite code is checked there and membership is granted there. The client
    // can no longer self-assign organizationId (the Firestore rule that allowed
    // it was removed), which closes the "join any org without the code" hole.
    const currentUser = firebase.auth().currentUser;
    if (!currentUser) throw new Error('Не авторизован');
    const idToken = await currentUser.getIdToken();

    orgSwitchInProgress = true;
    try {
        const response = await fetch('/api/join-org', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ inviteCode: code }),
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result.error || 'Не удалось вступить в организацию');
        }

        const org = result.organization;
        const orgRole = result.orgRole || 'employee';

        // Reflect membership in local state
        state.currentUser.organizationId = org.id;
        state.currentUser.orgRole = orgRole;
        state.currentUser.allowedProjects = Array.isArray(result.allowedProjects) ? result.allowedProjects : [];
        state.orgRole = orgRole;

        return org;
    } finally {
        setTimeout(() => { orgSwitchInProgress = false; }, 0);
    }
}

// Leave organization (for non-owners)
async function leaveOrganization() {
    if (!state.currentUser || !state.organization) return;

    // Owner can't leave
    if (state.orgRole === 'owner') {
        throw new Error('Владелец не может покинуть организацию. Используйте "Удалить организацию".');
    }

    // Leaving is done SERVER-SIDE (api/org 'leave', Admin SDK): it atomically
    // clears organizationId/orgRole/allowedProjects and decrements membersCount.
    // The old client version cleared membership first and then the -1 counter
    // write failed the rules (no longer a member), leaving a stale count.
    await callOrgApi('leave');

    // Clear local state
    state.organization = null;
    state.orgRole = null;
    state.currentUser.organizationId = null;
    state.currentUser.orgRole = null;
    state.currentUser.allowedProjects = [];
}

// Delete organization (only for owner)
async function deleteOrganization() {
    if (!state.currentUser || !state.organization) return;

    if (state.orgRole !== 'owner') {
        throw new Error('Только владелец может удалить организацию');
    }

    // Server-side cascade (api/org 'deleteOrg', Admin SDK): deletes every
    // project + its tasks + its files, clears all members, then removes the org
    // doc. The old client-side batch orphaned projects/tasks/files (and couldn't
    // reach other projects' files subcollections). Reload for a clean state —
    // the server has cleared our own membership too.
    await callOrgApi('deleteOrg');
    window.location.reload();
}

// Regenerate invite code (invalidates old code). Done server-side (api/org):
// generating a unique code needs to query all orgs, which the client can no
// longer do; the endpoint also re-checks owner/admin rights.
async function regenerateInviteCode() {
    if (!state.organization) throw new Error('Нет организации');
    if (!hasPermission('regenerate_invite')) {
        throw new Error('Недостаточно прав');
    }

    const result = await callOrgApi('regenerateCode');
    state.organization.inviteCode = result.inviteCode;
    return result.inviteCode;
}

// Get organization by ID
async function getOrganization(orgId) {
    const result = await callOrgApi('current', { organizationId: orgId });
    return result.organization || null;
}

// Find organization by invite code (for the join preview card). Server-side
// (api/org preview): the client can no longer query organizations by code.
// Returns { id, name, membersCount } or null if the code matches nothing.
async function findOrganizationByCode(code) {
    try {
        const result = await callOrgApi('preview', { inviteCode: code });
        return result.organization || null;
    } catch (e) {
        return null; // unknown code / transient error → no preview
    }
}

async function loadMyOrganizations() {
    const result = await callOrgApi('list');
    state.organizations = Array.isArray(result.organizations) ? result.organizations : [];
    return state.organizations;
}

async function switchOrganization(organizationId) {
    orgSwitchInProgress = true;
    try {
        const result = await callOrgApi('switch', { organizationId });
        const org = result.organization;
        if (!org?.id) throw new Error('Организация не найдена');
        state.organization = org;
        state.orgRole = result.orgRole || 'employee';
        state.currentUser.organizationId = org.id;
        state.currentUser.orgRole = state.orgRole;
        state.currentUser.allowedProjects = Array.isArray(result.allowedProjects) ? result.allowedProjects : [];
        return org;
    } finally {
        setTimeout(() => { orgSwitchInProgress = false; }, 0);
    }
}

const ORG_ROLE_LABELS = {
    owner: 'Владелец',
    admin: 'Администратор',
    moderator: 'Модератор',
    employee: 'Исполнитель',
    reader: 'Исполнитель',
};

function orgRoleLabel(role) {
    return ORG_ROLE_LABELS[role] || 'Исполнитель';
}

function mergeOrganizationRosterUsers(legacyUsers = [], membershipUsers = []) {
    const byId = new Map();
    legacyUsers.forEach(user => {
        if (user?.id) byId.set(user.id, user);
    });
    membershipUsers.forEach(user => {
        if (!user?.id) return;
        byId.set(user.id, { ...(byId.get(user.id) || {}), ...user });
    });
    return Array.from(byId.values());
}

function setOrgListState(mode) {
    if (elements.orgListLoading) elements.orgListLoading.style.display = mode === 'loading' ? 'flex' : 'none';
    if (elements.orgListEmpty) elements.orgListEmpty.style.display = mode === 'empty' ? 'flex' : 'none';
    if (elements.orgTableWrap) elements.orgTableWrap.style.display = mode === 'table' ? 'block' : 'none';
}

function renderOrganizationList() {
    const body = elements.orgMembershipsBody;
    if (!body) return;
    body.innerHTML = '';

    const orgs = Array.isArray(state.organizations) ? state.organizations : [];
    if (orgs.length === 0) {
        setOrgListState('empty');
        return;
    }

    setOrgListState('table');
    orgs.forEach(org => {
        const row = document.createElement('tr');
        const isActive = org.id === state.currentUser?.organizationId || org.active;
        row.innerHTML = `
            <td>
                <div class="org-table-name">
                    <div class="org-table-icon"><i class="fa-solid fa-building"></i></div>
                    <div class="org-table-title">
                        <strong>${escapeHtml(org.name || 'Организация')}</strong>
                        ${isActive ? '<span class="org-active-label">Активная сейчас</span>' : ''}
                    </div>
                </div>
            </td>
            <td>${Number(org.projectsCount || 0)}</td>
            <td>${Number(org.membersCount || 0)}</td>
            <td><span class="org-role-pill">${escapeHtml(orgRoleLabel(org.role))}</span></td>
            <td>
                <button class="primary-btn org-enter-btn" data-org-id="${escapeHtml(org.id)}">
                    <i class="fa-solid fa-arrow-right-to-bracket"></i> Войти
                </button>
            </td>
        `;
        const enterBtn = row.querySelector('.org-enter-btn');
        if (enterBtn) {
            enterBtn.addEventListener('click', () => enterOrganization(org.id, enterBtn));
        }
        body.appendChild(row);
    });
}

async function refreshOrganizationList() {
    if (!state.currentUser) return;
    if (elements.orgListEmpty) {
        elements.orgListEmpty.innerHTML = '<i class="fa-regular fa-folder-open"></i><span>Вы пока не состоите ни в одной организации</span>';
    }
    setOrgListState('loading');
    if (elements.orgRefreshBtn) elements.orgRefreshBtn.disabled = true;
    try {
        await loadMyOrganizations();
        renderOrganizationList();
        // A task notification contains the task's organization id. Enter it
        // automatically only when the authenticated membership list confirms
        // access; api/org/switch performs the same check server-side again.
        const targetOrgId = pendingTaskLink?.organizationId;
        if (!pendingTaskOrgEntryInFlight
            && targetOrgId
            && state.organizations.some(org => org.id === targetOrgId)) {
            pendingTaskOrgEntryInFlight = true;
            try {
                await enterOrganization(targetOrgId);
            } finally {
                pendingTaskOrgEntryInFlight = false;
            }
        }
    } catch (error) {
        console.error('Error loading organizations:', error);
        state.organizations = [];
        renderOrganizationList();
        if (elements.orgListEmpty) {
            elements.orgListEmpty.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i><span>${escapeHtml(error.message || 'Не удалось загрузить организации')}</span>`;
        }
    } finally {
        if (elements.orgRefreshBtn) elements.orgRefreshBtn.disabled = false;
    }
}

function stopOrgWorkspaceSubscriptions() {
    if (projectsListenerUnsubscribe) {
        projectsListenerUnsubscribe();
        projectsListenerUnsubscribe = null;
    }
    if (usersListenerUnsubscribe) {
        usersListenerUnsubscribe();
        usersListenerUnsubscribe = null;
    }
    if (taskListenerUnsubscribe) {
        taskListenerUnsubscribe();
        taskListenerUnsubscribe = null;
    }
    if (projectFilesListenerUnsubscribe) {
        projectFilesListenerUnsubscribe();
        projectFilesListenerUnsubscribe = null;
    }
    unsubscribeFromMyTasks();
    unsubscribeFromAgentNotifications();
}

function resetWorkspaceState() {
    state.projects = [];
    state.tasks = [];
    state.users = [];
    state.activeProjectId = null;
    state.boardView = 'assigned';
    state.initialLoadDone = false;
    projectFiles = [];
    if (elements.projectList) elements.projectList.innerHTML = '';
    lastProjectListSignature = null; // DOM cleared — renderProjects must rebuild
    renderBoard();
    renderUsersList();
    renderProjectAccessTab();
}

async function enterOrganization(organizationId, button = null) {
    setButtonLoading(button, true, 'Входим…');
    try {
        resetAgentChatForOrganizationChange();
        stopOrgWorkspaceSubscriptions();
        resetWorkspaceState();
        await switchOrganization(organizationId);
        hideOrgSelectionScreen();
        enterApp();
    } catch (error) {
        console.error('Error entering organization:', error);
        alert(error.message || 'Не удалось войти в организацию');
        setButtonLoading(button, false);
    }
}

// Show organization selection screen
function showOrgSelectionScreen(clearOrg = false) {
    // Remove read-only class to enable buttons
    document.body.classList.remove('read-only');

    stopOrgWorkspaceSubscriptions();
    elements.authOverlay.style.display = 'none';
    elements.orgOverlay.style.display = 'flex';
    elements.orgChoiceScreen.style.display = 'block';
    elements.orgCreateScreen.style.display = 'none';
    elements.orgJoinScreen.style.display = 'none';
    document.getElementById('app-container').style.display = 'none';

    // Reset forms
    if (elements.orgNameInput) elements.orgNameInput.value = '';
    if (elements.orgInviteCodeInput) elements.orgInviteCodeInput.value = '';
    if (elements.orgCreateError) elements.orgCreateError.style.display = 'none';
    if (elements.orgJoinError) elements.orgJoinError.style.display = 'none';
    if (elements.orgJoinPreview) elements.orgJoinPreview.style.display = 'none';

    // Reset submit buttons
    const joinBtn = document.getElementById('org-join-submit-btn');
    if (joinBtn) {
        joinBtn.disabled = false;
        joinBtn.innerHTML = '<i class="fa-solid fa-right-to-bracket"></i> Присоединиться';
    }
    const createBtn = elements.orgCreateForm?.querySelector('button[type="submit"]');
    if (createBtn) {
        createBtn.disabled = false;
        createBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Создать организацию';
    }

    // Only clear organization from state if explicitly requested (user switching)
    if (clearOrg) {
        state.organization = null;
        state.orgRole = null;
        if (state.currentUser) {
            state.currentUser.organizationId = null;
            state.currentUser.orgRole = null;
            state.currentUser.allowedProjects = [];
        }
    }
    resetWorkspaceState();

    // Show welcome message
    if (state.currentUser) {
        const name = state.currentUser.firstName || state.currentUser.email;
        elements.orgWelcomeName.textContent = `Привет, ${name}!`;
    }

    refreshOrganizationList();

    // Apply pending invite code if exists (may auto-join and skip this screen)
    applyPendingInviteCode();

    // Hide loading screen after org screen is ready
    setTimeout(() => hideLoadingScreen(), 100);
}

// Check URL for invite code on page load (call early!)
function captureInviteCodeFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    const inviteCode = urlParams.get('invite');
    const taskId = urlParams.get('task');
    const projectId = urlParams.get('project');
    const organizationId = urlParams.get('org');

    if (inviteCode) {
        pendingInviteCode = inviteCode.toUpperCase();
        // Store in sessionStorage as backup
        sessionStorage.setItem('pendingInviteCode', pendingInviteCode);
    } else {
        // Check sessionStorage for pending code
        const stored = sessionStorage.getItem('pendingInviteCode');
        if (stored) {
            pendingInviteCode = stored;
        }
    }

    if (DEEP_LINK_ID_RE.test(String(taskId || ''))) {
        pendingTaskLink = {
            taskId: String(taskId),
            projectId: DEEP_LINK_ID_RE.test(String(projectId || '')) ? String(projectId) : null,
            organizationId: DEEP_LINK_ID_RE.test(String(organizationId || '')) ? String(organizationId) : null,
        };
        sessionStorage.setItem('pendingTaskLink', JSON.stringify(pendingTaskLink));
    } else {
        try {
            const stored = JSON.parse(sessionStorage.getItem('pendingTaskLink') || 'null');
            if (stored && DEEP_LINK_ID_RE.test(String(stored.taskId || ''))) {
                pendingTaskLink = {
                    taskId: String(stored.taskId),
                    projectId: DEEP_LINK_ID_RE.test(String(stored.projectId || '')) ? String(stored.projectId) : null,
                    organizationId: DEEP_LINK_ID_RE.test(String(stored.organizationId || '')) ? String(stored.organizationId) : null,
                };
            }
        } catch {
            sessionStorage.removeItem('pendingTaskLink');
        }
    }

    // Remove only ProjectMan routing params. Other query parameters may belong
    // to an auth provider and must survive until Firebase consumes them.
    if (inviteCode || taskId || projectId || organizationId) {
        const cleanUrl = new URL(window.location.href);
        ['invite', 'task', 'project', 'org'].forEach(key => cleanUrl.searchParams.delete(key));
        window.history.replaceState({}, document.title, `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
    }
}

function clearPendingTaskLink() {
    pendingTaskLink = null;
    sessionStorage.removeItem('pendingTaskLink');
}

// Resolve the task from Firestore only after the selected organization's
// project list is available. A URL never bypasses tenant/project permissions:
// Firestore rules and the accessible-project list remain authoritative.
async function applyPendingTaskLink() {
    if (pendingTaskLinkInFlight || !pendingTaskLink || !db || !state.currentUser || !state.organization) return;
    const link = pendingTaskLink;
    if (link.organizationId && link.organizationId !== getCurrentOrganizationId()) return;
    if (link.projectId && !state.projects.some(project => project.id === link.projectId)) return;

    pendingTaskLinkInFlight = true;
    try {
        const doc = await db.collection('tasks').doc(link.taskId).get();
        if (!doc.exists) {
            clearPendingTaskLink();
            return;
        }
        const task = { id: doc.id, ...doc.data() };
        const projectId = String(task.projectId || '');
        const accessibleProject = getFilteredProjects().some(project => project.id === projectId);
        if (!DEEP_LINK_ID_RE.test(projectId) || !accessibleProject) return;

        clearPendingTaskLink();
        navigateToTask(projectId, task.id, boardViewForTask(task));
    } catch (error) {
        // A denied/nonexistent task cannot become accessible by retrying in the
        // same organization. Network failures remain pending for the next live
        // projects snapshot/reload.
        if (error?.code === 'permission-denied' || error?.code === 'not-found') {
            clearPendingTaskLink();
        }
        console.warn('Task deep-link could not be opened:', error?.message || error);
    } finally {
        pendingTaskLinkInFlight = false;
    }
}

// Apply pending invite code - AUTO JOIN if code is valid
async function applyPendingInviteCode() {
    // Try to get from sessionStorage if not in memory
    if (!pendingInviteCode) {
        pendingInviteCode = sessionStorage.getItem('pendingInviteCode');
    }

    if (!pendingInviteCode) return;

    const code = pendingInviteCode;

    // Clear pending code
    pendingInviteCode = null;
    sessionStorage.removeItem('pendingInviteCode');

    // Try to auto-join the organization
    try {
        const org = await findOrganizationByCode(code);
        if (org) {
            // Auto join!
            const joinedOrg = await joinOrganization(code);
            state.organization = joinedOrg;
            state.currentUser.organizationId = joinedOrg.id;

            hideOrgSelectionScreen();
            enterApp();
            return; // Exit - we're done
        }
    } catch (e) {
        console.error('Auto-join failed:', e);
        // Fall through to show manual join screen
    }

    // If auto-join failed, show join screen with code filled in
    const codeInput = document.getElementById('org-invite-code');
    const choiceScreen = document.getElementById('org-choice-screen');
    const joinScreen = document.getElementById('org-join-screen');

    if (codeInput && joinScreen) {
        if (choiceScreen) choiceScreen.style.display = 'none';
        joinScreen.style.display = 'block';
        codeInput.value = code;
    }
}

// Hide organization selection screen
function hideOrgSelectionScreen() {
    elements.orgOverlay.style.display = 'none';
}

// Setup organization event listeners
function setupOrgEventListeners() {
    // Choice screen buttons
    if (elements.orgCreateBtn) {
        elements.orgCreateBtn.addEventListener('click', () => {
            elements.orgChoiceScreen.style.display = 'none';
            elements.orgCreateScreen.style.display = 'block';
            elements.orgNameInput.focus();
        });
    }

    if (elements.orgJoinBtn) {
        elements.orgJoinBtn.addEventListener('click', () => {
            elements.orgChoiceScreen.style.display = 'none';
            elements.orgJoinScreen.style.display = 'block';
            elements.orgInviteCodeInput.focus();
        });
    }

    if (elements.orgLogoutBtn) {
        elements.orgLogoutBtn.addEventListener('click', () => {
            logout();
        });
    }

    if (elements.orgRefreshBtn) {
        elements.orgRefreshBtn.addEventListener('click', () => {
            refreshOrganizationList();
        });
    }

    // Back buttons
    if (elements.orgCreateBack) {
        elements.orgCreateBack.addEventListener('click', () => {
            elements.orgCreateScreen.style.display = 'none';
            elements.orgChoiceScreen.style.display = 'block';
            elements.orgCreateError.style.display = 'none';
        });
    }

    if (elements.orgJoinBack) {
        elements.orgJoinBack.addEventListener('click', () => {
            elements.orgJoinScreen.style.display = 'none';
            elements.orgChoiceScreen.style.display = 'block';
            elements.orgJoinError.style.display = 'none';
            elements.orgJoinPreview.style.display = 'none';
        });
    }

    // Create organization form
    if (elements.orgCreateForm) {
        elements.orgCreateForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const name = elements.orgNameInput.value.trim();
            if (!name) return;

            const submitBtn = elements.orgCreateForm.querySelector('button[type="submit"]');
            setButtonLoading(submitBtn, true, 'Создаём…');
            elements.orgCreateError.style.display = 'none';

            try {
                const org = await createOrganization(name);
                state.organization = org;
                state.orgRole = 'owner';
                state.currentUser.organizationId = org.id;
                state.currentUser.orgRole = 'owner';

                hideOrgSelectionScreen();
                enterApp();
            } catch (error) {
                console.error('Error creating organization:', error);
                elements.orgCreateError.textContent = error.message;
                elements.orgCreateError.style.display = 'block';
            } finally {
                setButtonLoading(submitBtn, false);
            }
        });
    }

    // Join organization form
    if (elements.orgJoinForm) {
        elements.orgJoinForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const codeInput = document.getElementById('org-invite-code');
            const code = codeInput?.value.trim();
            if (!code) return;

            // Find visible submit button
            const allBtns = elements.orgJoinForm.querySelectorAll('button[type="submit"]');
            let submitBtn = null;
            allBtns.forEach(btn => {
                if (btn.offsetParent !== null) submitBtn = btn;
            });
            if (!submitBtn) submitBtn = allBtns[0];

            setButtonLoading(submitBtn, true, 'Присоединяем…');

            const joinError = document.getElementById('org-join-error');
            if (joinError) joinError.style.display = 'none';

            try {
                const org = await joinOrganization(code);
                state.organization = org;
                state.currentUser.organizationId = org.id;

                // Clear pending invite code
                sessionStorage.removeItem('pendingInviteCode');
                pendingInviteCode = null;

                hideOrgSelectionScreen();
                enterApp();
            } catch (error) {
                console.error('Error joining organization:', error);
                if (joinError) {
                    joinError.textContent = error.message;
                    joinError.style.display = 'block';
                }
                setButtonLoading(submitBtn, false);
            }
        });
    }

    // Preview organization when typing invite code
    if (elements.orgInviteCodeInput) {
        let debounceTimer;

        elements.orgInviteCodeInput.addEventListener('input', (e) => {
            const code = e.target.value.trim();
            elements.orgJoinError.style.display = 'none';

            clearTimeout(debounceTimer);
            if (code.length >= 4) {
                debounceTimer = setTimeout(async () => {
                    const org = await findOrganizationByCode(code);
                    if (org) {
                        elements.orgJoinName.textContent = org.name;
                        elements.orgJoinMembers.textContent = `${org.membersCount || 1} участник(ов)`;
                        elements.orgJoinPreview.style.display = 'block';
                    } else {
                        elements.orgJoinPreview.style.display = 'none';
                    }
                }, 500);
            } else {
                elements.orgJoinPreview.style.display = 'none';
            }
        });
    }

    // Organization menu in sidebar
    if (elements.orgMenuBtn) {
        elements.orgMenuBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isOpen = elements.orgDropdown.style.display === 'block';
            elements.orgDropdown.style.display = isOpen ? 'none' : 'block';
            elements.orgHeader.classList.toggle('open', !isOpen);
        });
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (elements.orgDropdown && !elements.orgHeader?.contains(e.target)) {
            elements.orgDropdown.style.display = 'none';
            elements.orgHeader?.classList.remove('open');
        }
    });

    // Copy invite code
    if (elements.orgCopyCode) {
        elements.orgCopyCode.addEventListener('click', async () => {
            const code = elements.orgInviteCodeDisplay.textContent;
            try {
                await navigator.clipboard.writeText(code);
                elements.orgCopyCode.innerHTML = '<i class="fa-solid fa-check"></i>';
                setTimeout(() => {
                    elements.orgCopyCode.innerHTML = '<i class="fa-solid fa-copy"></i>';
                }, 2000);
            } catch (err) {
                console.error('Failed to copy:', err);
            }
        });
    }

    // Share invite link
    if (elements.orgShareBtn) {
        elements.orgShareBtn.addEventListener('click', async () => {
            const code = state.organization?.inviteCode || '';
            const name = state.organization?.name || 'организации';
            const inviteUrl = `${window.location.origin}?invite=${code}`;
            const shareData = {
                title: 'Приглашение в ProjectMan',
                text: `Присоединяйтесь к "${name}" в ProjectMan!\nКод: ${code}`,
                url: inviteUrl
            };

            if (navigator.share) {
                try {
                    await navigator.share(shareData);
                } catch (err) {
                    if (err.name !== 'AbortError') {
                        console.error('Share failed:', err);
                    }
                }
            } else {
                // Fallback: copy to clipboard
                try {
                    await navigator.clipboard.writeText(inviteUrl);
                    alert('Ссылка скопирована в буфер обмена');
                } catch (err) {
                    console.error('Copy failed:', err);
                }
            }

            elements.orgDropdown.style.display = 'none';
            elements.orgHeader.classList.remove('open');
        });
    }

    // Leave organization (for non-owners)
    if (elements.orgSwitchMenuBtn) {
        elements.orgSwitchMenuBtn.addEventListener('click', () => {
            elements.orgDropdown.style.display = 'none';
            elements.orgHeader.classList.remove('open');
            showOrgSelectionScreen(false);
        });
    }

    if (elements.orgLeaveBtn) {
        elements.orgLeaveBtn.addEventListener('click', async () => {
            if (state.orgRole === 'owner') {
                alert('Владелец не может покинуть организацию. Используйте "Удалить организацию".');
                return;
            }

            if (!confirm('Вы уверены, что хотите покинуть организацию?\n\nВы потеряете доступ ко всем проектам и задачам.')) return;

            setButtonLoading(elements.orgLeaveBtn, true, 'Выходим…');
            try {
                await leaveOrganization();
                elements.orgDropdown.style.display = 'none';
                elements.orgHeader.classList.remove('open');
                showOrgSelectionScreen(true);
            } catch (error) {
                setButtonLoading(elements.orgLeaveBtn, false);
                alert(error.message);
            }
        });
    }

    // Delete organization (only for owner)
    if (elements.orgDeleteBtn) {
        elements.orgDeleteBtn.addEventListener('click', async () => {
            if (state.orgRole !== 'owner') {
                alert('Только владелец может удалить организацию.');
                return;
            }

            const orgName = state.organization?.name || 'организацию';
            if (!confirm(`ВНИМАНИЕ!\n\nВы уверены, что хотите удалить "${orgName}"?\n\nВсе сотрудники будут отключены от организации.\nЭто действие НЕОБРАТИМО!`)) return;

            // Double confirmation
            if (!confirm('Подтвердите удаление ещё раз.\n\nОрганизация будет удалена навсегда.')) return;

            try {
                const btn = elements.orgDeleteBtn;
                setButtonLoading(btn, true, 'Удаляем…');

                await deleteOrganization();

                elements.orgDropdown.style.display = 'none';
                elements.orgHeader.classList.remove('open');
                showOrgSelectionScreen(true);

                alert('Организация удалена.');
            } catch (error) {
                console.error('Error deleting organization:', error);
                alert('Ошибка: ' + error.message);
                setButtonLoading(elements.orgDeleteBtn, false);
            }
        });
    }

    // Regenerate invite code
    if (elements.orgRegenerateCode) {
        elements.orgRegenerateCode.addEventListener('click', async () => {
            if (!confirm('Сменить код приглашения?\n\nСтарый код перестанет работать.')) return;

            const btn = elements.orgRegenerateCode;
            setButtonLoading(btn, true, 'Меняем…');

            try {
                const newCode = await regenerateInviteCode();
                if (elements.orgInviteCodeDisplay) {
                    elements.orgInviteCodeDisplay.textContent = newCode;
                }
                setButtonLoading(btn, false);
                btn.innerHTML = '<i class="fa-solid fa-check"></i> Готово!';
                setTimeout(() => {
                    btn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Сменить код';
                    btn.disabled = false;
                }, 2000);
            } catch (error) {
                alert(error.message);
                setButtonLoading(btn, false);
            }
        });
    }
}

// Update organization UI in sidebar
function updateOrgUI() {
    if (!state.organization) {
        if (elements.orgHeader) elements.orgHeader.style.display = 'none';
        if (elements.brandLogo) elements.brandLogo.style.display = 'flex';
        return;
    }

    // Show org header, hide brand
    if (elements.orgHeader) elements.orgHeader.style.display = 'block';
    if (elements.brandLogo) elements.brandLogo.style.display = 'none';

    // Update org info
    if (elements.orgNameDisplay) elements.orgNameDisplay.textContent = state.organization.name;
    if (elements.orgDropdownName) elements.orgDropdownName.textContent = state.organization.name;

    // Role display
    const roleNames = {
        owner: 'Владелец',
        admin: 'Администратор',
        moderator: 'Модератор',
        employee: 'Исполнитель'
    };
    if (elements.orgDropdownRole) {
        elements.orgDropdownRole.textContent = roleNames[state.orgRole] || 'Исполнитель';
    }

    // Invite code (only for admin+)
    const canSeeCode = hasPermission('view_invite_code');
    const codeSection = elements.orgDropdown?.querySelector('.org-dropdown-section');
    if (codeSection) {
        codeSection.style.display = canSeeCode ? 'block' : 'none';
    }
    if (elements.orgInviteCodeDisplay && canSeeCode) {
        elements.orgInviteCodeDisplay.textContent = state.organization.inviteCode || '------';
    }

    // Show/hide leave and delete buttons based on role
    if (elements.orgLeaveBtn) {
        // Non-owners see "Leave" button
        elements.orgLeaveBtn.style.display = state.orgRole === 'owner' ? 'none' : 'flex';
    }
    if (elements.orgDeleteBtn) {
        // Only owner sees "Delete" button
        elements.orgDeleteBtn.style.display = state.orgRole === 'owner' ? 'flex' : 'none';
    }
}

// Get role name in Russian
function getRoleName(role) {
    const names = {
        owner: 'Владелец',
        admin: 'Администратор',
        moderator: 'Модератор',
        employee: 'Исполнитель',
        reader: 'Исполнитель'
    };
    return names[role] || 'Исполнитель';
}

// Permission system
// Owner: can do everything
// Admin: everything except delete org and change owner's role
// Moderator: create/edit/delete/assign tasks only
// Reader/employee: view, accept assigned tasks, and submit them for review

function hasPermission(permission) {
    const role = state.orgRole || 'employee';

    // Owner can do everything
    if (role === 'owner') return true;

    const permissions = {
        admin: [
            'admin_panel',        // Access admin panel
            'manage_users',       // Add/remove users, change roles (except owner)
            'manage_projects',    // Create/edit/delete projects
            'create_tasks',       // Create tasks
            'edit_tasks',         // Edit any task
            'delete_tasks',       // Delete any task
            'assign_tasks',       // Assign users to tasks
            'complete_tasks',     // Complete any task
            'view_invite_code',   // View invite code
            'regenerate_invite'   // Change invite code
        ],
        moderator: [
            'create_tasks',       // Create tasks
            'edit_tasks',         // Edit any task
            'delete_tasks',       // Delete any task
            'assign_tasks',       // Assign users to tasks
            'complete_tasks'      // Complete any task
        ],
        employee: [
            'view',               // View projects and tasks
            'complete_own_tasks'  // Complete only assigned tasks
        ],
        reader: [
            'view',
            'complete_own_tasks'
        ]
    };

    const rolePerms = permissions[role] || permissions.employee;
    return rolePerms.includes(permission);
}

// Helper functions for common permission checks
function canManageProjects() {
    return ['owner', 'admin'].includes(state.orgRole);
}

function canManageTasks() {
    return ['owner', 'admin', 'moderator'].includes(state.orgRole);
}

function canAccessAdmin() {
    return ['owner', 'admin'].includes(state.orgRole);
}

function getCurrentOrganizationId() {
    return state.organization?.id || state.currentUser?.organizationId || null;
}

function getFirestoreDateMs(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    if (typeof value === 'object' && typeof value.seconds === 'number') {
        return (value.seconds * 1000) + (typeof value.nanoseconds === 'number' ? value.nanoseconds / 1e6 : 0);
    }
    const parsed = new Date(value).getTime();
    return Number.isNaN(parsed) ? 0 : parsed;
}

function canChangeUserRole(targetRole) {
    // Owner can change anyone's role (except owner - that's themselves)
    if (state.orgRole === 'owner') {
        return targetRole !== 'owner';
    }
    // Admin can ONLY change employee ↔ moderator (NOT admin roles)
    if (state.orgRole === 'admin') {
        return ['employee', 'reader', 'moderator'].includes(targetRole);
    }
    return false;
}

function canRemoveUserFromOrg(targetRole) {
    // Owner can remove anyone except themselves (handled separately)
    if (state.orgRole === 'owner') {
        return targetRole !== 'owner';
    }
    // Admin can only remove employees and moderators (NOT other admins)
    if (state.orgRole === 'admin') {
        return ['employee', 'reader', 'moderator'].includes(targetRole);
    }
    return false;
}

// Enter app after organization is set
function enterApp() {
    sessionStorage.removeItem('swControllerReloaded');
    hideOrgSelectionScreen();
    hideAuthScreen();
    hideLoadingScreen(); // Hide loading ONLY when fully entering app

    const appContainer = document.getElementById('app-container');
    if (appContainer) {
        appContainer.style.display = 'flex';
    }

    updateOrgUI();
    applyRoleRestrictions();
    setupRealtimeListeners();
    subscribeToMyTasks();
    subscribeToAgentNotifications();
    subscribeToOwnUserDoc();


    // Start presence tracking (used for admin "who is online" / last seen)
    startPresenceHeartbeat();
}

// Apply role-based UI restrictions
function applyRoleRestrictions() {
    const role = state.orgRole || 'employee';

    // Remove all role classes first
    document.body.classList.remove('read-only', 'role-owner', 'role-admin', 'role-moderator', 'role-employee', 'role-reader');

    // Add current role class
    document.body.classList.add(`role-${role}`);

    // read-only for employees (can only view and complete own tasks)
    if (role === 'employee' || role === 'reader') {
        document.body.classList.add('read-only');
    }

    // ИИ-агент — только от модератора и выше (экономия OpenRouter-кредитов).
    // Кнопка остаётся видимой, но не кликабельной; сервер дублирует запрет.
    const agentBtn = elements.agentChatBtn || document.getElementById('agent-chat-btn');
    if (agentBtn) {
        const agentAllowed = canManageTasks();
        agentBtn.classList.toggle('agent-btn-locked', !agentAllowed);
        agentBtn.title = agentAllowed ? '' : 'ИИ-агент доступен ролям от модератора и выше';
        agentBtn.setAttribute('aria-disabled', agentAllowed ? 'false' : 'true');
    }

    // Admin panel button - visible for all, but disabled for non-admins
    const adminPanelBtn = document.getElementById('admin-panel-btn');
    const adminPanelDesc = document.getElementById('admin-panel-desc');
    if (adminPanelBtn) {
        adminPanelBtn.style.display = 'flex'; // Always visible
        if (canAccessAdmin()) {
            adminPanelBtn.classList.remove('disabled');
            if (adminPanelDesc) adminPanelDesc.textContent = 'Управление пользователями';
        } else {
            adminPanelBtn.classList.add('disabled');
            if (adminPanelDesc) adminPanelDesc.textContent = 'Доступ только для администраторов';
        }
    }

    // Show/hide add project button (owner, admin only)
    const addProjectBtn = document.getElementById('add-project-btn');
    if (addProjectBtn) {
        addProjectBtn.style.display = canManageProjects() ? 'flex' : 'none';
    }

    // Show/hide add task button (owner, admin, moderator)
    const addTaskBtn = document.getElementById('add-task-btn');
    if (addTaskBtn) {
        addTaskBtn.style.display = canManageTasks() ? 'flex' : 'none';
    }

    // Show/hide delete project button (owner, admin only)
    const deleteProjectBtn = document.getElementById('delete-project-btn');
    if (deleteProjectBtn) {
        deleteProjectBtn.style.display = canManageProjects() ? 'block' : 'none';
    }

    updateAgentChatAttachVisibility();
}

// ========== END ORGANIZATION FUNCTIONS ==========

// Initialize Firebase when ready
let db;
let auth;
let firebaseInitAttempts = 0;
let isFirebaseInitialized = false;
let taskListenerUnsubscribe = null; // To manage real-time listener for tasks
let myTasksListenerUnsubscribe = null; // To manage real-time listener for my tasks count
let myTasksChunkUnsubs = [];           // per-project-chunk listeners (scoped My Tasks badge)
let myTasksByChunk = [];               // latest tasks per chunk, merged for the count
let projectFilesListenerUnsubscribe = null; // To manage real-time listener for project files
let projectFiles = []; // Files for the currently selected project (projects/{projectId}/files)

function initFirebase() {
    if (isFirebaseInitialized) return; // Prevent double init

    if (typeof firebase !== 'undefined' && firebase.app) {
        // Check if already initialized
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }

        isFirebaseInitialized = true;
        db = firebase.firestore();
        auth = firebase.auth();

        // Enable Offline Persistence (Critical for slow networks)
        db.enablePersistence({ synchronizeTabs: true })
            .catch((err) => {
                if (err.code == 'failed-precondition') {
                    console.warn('Persistence failed: Multiple tabs open');
                } else if (err.code == 'unimplemented') {
                    console.warn('Persistence failed: Browser not supported');
                }
            });

        // Enable Auth persistence
        auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
            .then(() => {
                auth.getRedirectResult().catch(handleFederatedAuthError);
                auth.onAuthStateChanged(onAuthStateChanged);
            })
            .catch((error) => {
                console.error("Persistence error:", error);
                auth.getRedirectResult().catch(handleFederatedAuthError);
                auth.onAuthStateChanged(onAuthStateChanged);
            });

        setupRealtimeListeners();

    } else {
        // Retry
        firebaseInitAttempts++;
        if (firebaseInitAttempts < 50) {
            setTimeout(initFirebase, 200);
        } else {
            console.error("Firebase failed to load.");
            const loader = document.getElementById('loading-overlay');
            if (loader) {
                loader.innerHTML = '<p style="color:white;text-align:center;padding:20px">Ошибка загрузки. Обновите страницу.</p>';
            }
        }
    }
}

// State
let state = {
    projects: [],
    tasks: [],
    users: [], // All users (for admin panel)

    activeProjectId: null,
    boardView: 'assigned', // Mobile-only active column: assigned | in-progress | review
    projectView: 'kanban', // 'kanban' | 'gantt' — main-area view for the active project
    ganttYear: null, // Selected Gantt year; null = current year on first render
    ganttMonth: null, // null = whole year (month columns), 0-11 = that month (day columns)
    role: 'guest', // Legacy role, now use orgRole
    orgRole: 'employee', // owner / admin / moderator / employee
    initialLoadDone: false, // To prevent selecting first project on every update
    currentUser: null, // { uid, email, firstName, lastName, role, allowedProjects, organizationId, orgRole }
    organization: null, // { id, name, inviteCode, ownerId, ... }
    organizations: [], // Organizations where the current user has membership
};

// DOM Elements
const elements = {
    projectList: document.getElementById('project-list'),
    boardContainer: document.getElementById('board-container'),
    ganttContainer: document.getElementById('gantt-container'),
    ganttScroll: document.getElementById('gantt-scroll'),
    ganttYearSelect: document.getElementById('gantt-year-select'),
    ganttBackYear: document.getElementById('gantt-back-year'),
    ganttPeriodLabel: document.getElementById('gantt-period-label'),
    ganttPrevYear: document.getElementById('gantt-prev-year'),
    ganttNextYear: document.getElementById('gantt-next-year'),
    ganttNoDeadlineNote: document.getElementById('gantt-no-deadline-note'),
    emptyState: document.getElementById('empty-state'),
    projectTitle: document.getElementById('project-title'),
    projectDesc: document.getElementById('project-desc'),
    editProjectBtn: document.getElementById('edit-project-btn'),
    addTaskBtn: document.getElementById('add-task-btn'),
    deleteProjectBtn: document.getElementById('delete-project-btn'),

    // Columns
    listAssigned: document.getElementById('list-assigned'),
    listInProgress: document.getElementById('list-in-progress'),
    listReview: document.getElementById('list-review'),

    // Counts
    countAssigned: document.getElementById('count-assigned'),
    countInProgress: document.getElementById('count-in-progress'),
    countReview: document.getElementById('count-review'),

    // Board selector (mobile)
    categoryPicker: document.getElementById('category-picker'),
    categoryBtn: document.getElementById('category-btn'),
    categoryBtnText: document.getElementById('category-btn-text'),
    categoryModal: document.getElementById('category-modal'),

    // Modals
    projectModal: document.getElementById('project-modal'),
    taskModal: document.getElementById('task-modal'),
    helpModal: document.getElementById('help-modal'),
    projectFilesModal: document.getElementById('project-files-modal'),
    projectFilesBtn: document.getElementById('project-files-btn'),
    projectFilesList: document.getElementById('project-files-list'),
    projectFileInput: document.getElementById('project-file-input'),
    addProjectFileBtn: document.getElementById('add-project-file-btn'),
    taskArchiveModal: document.getElementById('task-archive-modal'),
    taskArchiveBtn: document.getElementById('task-archive-btn'),
    taskArchiveCount: document.getElementById('task-archive-count'),
    taskArchiveList: document.getElementById('task-archive-list'),
    taskArchiveSubtitle: document.getElementById('task-archive-subtitle'),



    // Forms
    projectForm: document.getElementById('project-form'),
    taskForm: document.getElementById('task-form'),

    // Buttons
    addProjectBtn: document.getElementById('add-project-btn'),
    helpBtn: document.getElementById('help-btn'),
    closeModalBtns: document.querySelectorAll('.close-modal'),

    // Auth
    authOverlay: document.getElementById('auth-overlay'),
    authScreen: document.getElementById('auth-screen'),
    roleScreen: document.getElementById('role-screen'),
    loginError: document.getElementById('login-error'),
    telegramBotLoginBtn: document.getElementById('telegram-bot-login-btn'),
    userEmailDisplay: document.getElementById('user-email-display'),

    // Mobile
    mobileMenuBtn: document.getElementById('mobile-menu-btn'),
    sidebar: document.querySelector('.sidebar'),

    // Admin Panel
    adminPanelBtn: document.getElementById('admin-panel-btn'),
    adminPanelModal: document.getElementById('admin-panel-modal'),
    usersList: document.getElementById('users-list'),
    usersCount: document.getElementById('users-count'),
    projectAccessList: document.getElementById('project-access-list'),

    // Admin Panel - Logins / Online
    loginUsersList: document.getElementById('login-users-list'),
    onlineUsersCount: document.getElementById('online-users-count'),
    totalUsersCount: document.getElementById('total-users-count'),
    adminUsersStatsList: document.getElementById('admin-users-stats-list'),

    // My Tasks
    myTasksBtn: document.getElementById('my-tasks-btn'),
    myTasksModal: document.getElementById('my-tasks-modal'),
    myTasksList: document.getElementById('my-tasks-list'),
    myTasksCount: document.getElementById('my-tasks-count'),

    // Organization
    orgOverlay: document.getElementById('org-overlay'),
    orgChoiceScreen: document.getElementById('org-choice-screen'),
    orgCreateScreen: document.getElementById('org-create-screen'),
    orgJoinScreen: document.getElementById('org-join-screen'),
    orgCreateBtn: document.getElementById('org-create-btn'),
    orgJoinBtn: document.getElementById('org-join-btn'),
    orgLogoutBtn: document.getElementById('org-logout-btn'),
    orgCreateBack: document.getElementById('org-create-back'),
    orgJoinBack: document.getElementById('org-join-back'),
    orgCreateForm: document.getElementById('org-create-form'),
    orgJoinForm: document.getElementById('org-join-form'),
    orgNameInput: document.getElementById('org-name'),
    orgInviteCodeInput: document.getElementById('org-invite-code'),
    orgCreateError: document.getElementById('org-create-error'),
    orgJoinError: document.getElementById('org-join-error'),
    orgJoinPreview: document.getElementById('org-join-preview'),
    orgJoinName: document.getElementById('org-join-name'),
    orgJoinMembers: document.getElementById('org-join-members'),
    orgRefreshBtn: document.getElementById('org-refresh-btn'),
    orgListLoading: document.getElementById('org-list-loading'),
    orgListEmpty: document.getElementById('org-list-empty'),
    orgTableWrap: document.getElementById('org-table-wrap'),
    orgMembershipsBody: document.getElementById('org-memberships-body'),
    orgWelcomeName: document.getElementById('org-welcome-name'),
    orgHeader: document.getElementById('org-header'),
    orgMenuBtn: document.getElementById('org-menu-btn'),
    orgDropdown: document.getElementById('org-dropdown'),
    orgNameDisplay: document.getElementById('org-name-display'),
    orgDropdownName: document.getElementById('org-dropdown-name'),
    orgDropdownRole: document.getElementById('org-dropdown-role'),
    orgInviteCodeDisplay: document.getElementById('org-invite-code-display'),
    orgCopyCode: document.getElementById('org-copy-code'),
    orgShareBtn: document.getElementById('org-share-btn'),
    orgSwitchMenuBtn: document.getElementById('org-switch-menu-btn'),
    orgLeaveBtn: document.getElementById('org-leave-btn'),
    orgDeleteBtn: document.getElementById('org-delete-btn'),
    orgRegenerateCode: document.getElementById('org-regenerate-code'),
    brandLogo: document.getElementById('brand-logo'),

    // Global AI agent chat
    agentChatBtn: document.getElementById('agent-chat-btn'),
    agentChatModal: document.getElementById('agent-chat-modal'),
    agentChatMessages: document.getElementById('agent-chat-messages'),
    agentChatForm: document.getElementById('agent-chat-form'),
    agentChatInput: document.getElementById('agent-chat-input'),
    agentChatSendBtn: document.getElementById('agent-chat-send-btn'),
    agentChatAttachBtn: document.getElementById('agent-chat-attach-btn'),
    agentChatFileInput: document.getElementById('agent-chat-file-input'),
    agentChatFileChip: document.getElementById('agent-chat-file-chip'),
    agentChatRateHint: document.getElementById('agent-chat-rate-hint'),
};

// Init
function init() {
    loadTheme();

    // Create sidebar overlay
    const overlay = document.createElement('div');
    overlay.className = 'sidebar-overlay';
    document.body.appendChild(overlay);
    elements.sidebarOverlay = overlay;

    setupEventListeners();

    // Initialize Firebase and listen for real-time updates
    initFirebase();

    // Register Service Worker for PWA and offline support
    if ('serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./sw.js')
                .then(registration => {
                    console.log('ServiceWorker registration successful with scope: ', registration.scope);

                    // Check for updates
                    registration.addEventListener('updatefound', () => {
                        const newWorker = registration.installing;
                        newWorker.addEventListener('statechange', () => {
                            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                // New content available, show notification
                                showUpdateNotification();
                            }
                        });
                    });

                    // Periodic update check (every hour). MUST be inside this
                    // .then so `registration` is in scope — the old version ran
                    // registration.update() from an outer setInterval where
                    // `registration` was undefined, throwing a ReferenceError,
                    // so the hourly auto-update never actually worked.
                    setInterval(() => { registration.update(); }, 60 * 60 * 1000);
                })
                .catch(err => {
                    console.log('ServiceWorker registration failed: ', err);
                });

            // Reload when controller changes (new SW activated)
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                if (hasActiveTelegramBotLogin()) return;
                if (sessionStorage.getItem('swControllerReloaded')) return;
                sessionStorage.setItem('swControllerReloaded', '1');
                window.location.reload();
            });
        });
    }
}

// Aggressive Update Check
function checkForUpdates() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function (registrations) {
            for (let registration of registrations) {
                registration.update();
            }
        });
    }
}

// Force clear cache for users with old version
window.addEventListener('load', () => {
    // Check if we need to force clear cache (version bump)
    const CURRENT_VERSION = '6.19'; // My Tasks fullscreen mini-board
    const storedVersion = localStorage.getItem('app_version');

    if (storedVersion !== CURRENT_VERSION) {
        console.log('New version detected. Clearing cache...');

        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations().then(function (registrations) {
                for (let registration of registrations) {
                    registration.unregister();
                }
            });
        }

        if ('caches' in window) {
            caches.keys().then((names) => {
                names.forEach((name) => {
                    caches.delete(name);
                });
            });
        }

        localStorage.setItem('app_version', CURRENT_VERSION);
    }
});

function showUpdateNotification() {
    const notification = document.createElement('div');
    notification.className = 'update-notification';
    notification.innerHTML = `
        <div style="display: flex; align-items: center; gap: 1rem;">
            <i class="fa-solid fa-sync fa-spin"></i>
            <span>Доступна новая версия!</span>
        </div>
        <button onclick="forceUpdate()" style="background: white; color: #4f46e5; border: none; padding: 6px 12px; border-radius: 4px; cursor: pointer; font-weight: bold;">Обновить</button>
    `;

    // Style directly to ensure it shows up regardless of CSS version
    Object.assign(notification.style, {
        position: 'fixed',
        bottom: '20px',
        left: '50%',
        transform: 'translateX(-50%)',
        background: '#4f46e5',
        color: 'white',
        padding: '12px 20px',
        borderRadius: '8px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
        zIndex: '10000',
        display: 'flex',
        alignItems: 'center',
        gap: '20px',
        fontFamily: 'sans-serif'
    });

    const btn = notification.querySelector('button');
    Object.assign(btn.style, {
        background: 'white',
        color: '#4f46e5',
        border: 'none',
        padding: '6px 12px',
        borderRadius: '4px',
        cursor: 'pointer',
        fontWeight: 'bold'
    });

    document.body.appendChild(notification);
}

// Persistence - NOW FIREBASE
let projectsListenerUnsubscribe = null;
let usersListenerUnsubscribe = null;
let ownUserDocListenerUnsubscribe = null;
let orgSwitchInProgress = false;

// Live listener on the current user's OWN doc. Catches being removed from the
// organization (kicked, or org deleted) or an orgRole change and applies it
// immediately, instead of leaving a stale, still-privileged session until the
// next reload. The org-filtered users listener can't see this: when a user is
// removed, their doc drops out of that org-scoped query.
function subscribeToOwnUserDoc() {
    if (ownUserDocListenerUnsubscribe) {
        ownUserDocListenerUnsubscribe();
        ownUserDocListenerUnsubscribe = null;
    }
    if (!state.currentUser) return;
    const uid = state.currentUser.uid;

    ownUserDocListenerUnsubscribe = db.collection('users').doc(uid).onSnapshot(doc => {
        if (!doc.exists || !state.currentUser) return;
        const data = doc.data();

        // Removed from / moved out of the organization we're currently in.
        if (state.organization && data.organizationId !== state.organization.id) {
            if (orgSwitchInProgress) return;
            // Right after an org switch this listener is re-subscribed and its
            // FIRST snapshot comes from the IndexedDB cache, where the doc
            // still holds the PREVIOUS organizationId (orgSwitchInProgress is
            // already false by then — it's cleared on a 0-ms timer). That
            // stale cached snapshot must not be treated as a revoked access:
            // it caused an endless "доступ изменился" alert+reload loop on
            // every org switch. A real kick arrives as a server snapshot.
            if (doc.metadata.fromCache) return;
            if (ownUserDocListenerUnsubscribe) {
                ownUserDocListenerUnsubscribe();
                ownUserDocListenerUnsubscribe = null;
            }
            alert('Ваш доступ к организации изменился. Страница будет перезагружена.');
            window.location.reload();
            return;
        }

        // Live role refresh (demotion/promotion) without a re-login.
        const newOrgRole = data.orgRole || 'employee';
        const newRole = data.role || state.role;
        if (newOrgRole !== state.orgRole || newRole !== state.role) {
            state.orgRole = newOrgRole;
            state.role = newRole;
            state.currentUser.orgRole = newOrgRole;
            state.currentUser.role = newRole;
            state.currentUser.allowedProjects = data.allowedProjects || [];
            applyRoleRestrictions();
            renderBoard();
        }
    }, err => console.error('Own user doc listener error:', err));
}


function setupRealtimeListeners() {
    // Unsubscribe from previous listeners
    if (projectsListenerUnsubscribe) projectsListenerUnsubscribe();
    if (usersListenerUnsubscribe) usersListenerUnsubscribe();


    const orgId = getCurrentOrganizationId();
    // Firebase is initialized before auth/org selection completes. Starting
    // collection-wide listeners in that gap only produces permission errors
    // and would be unsafe if rules were ever loosened. Real listeners start
    // from enterApp() after a concrete current organization is selected.
    if (!db || !state.currentUser || !orgId) {
        state.projects = [];
        state.users = [];
        renderProjects();
        renderBoard();
        return;
    }
    const projectsQuery = db.collection('projects').where('organizationId', '==', orgId);

    projectsListenerUnsubscribe = projectsQuery.onSnapshot(snapshot => {
        const projects = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            projects.push({ id: doc.id, ...data });
        });
        projects.sort((a, b) => getFirestoreDateMs(a.createdAt) - getFirestoreDateMs(b.createdAt));
        state.projects = projects;

        // If active project was deleted, deselect it
        if (state.activeProjectId && !state.projects.find(p => p.id === state.activeProjectId)) {
            state.activeProjectId = null;
            // Also unsubscribe from tasks if project is gone
            if (taskListenerUnsubscribe) {
                taskListenerUnsubscribe();
                taskListenerUnsubscribe = null;
            }
            state.tasks = [];
            // Also unsubscribe from project files if project is gone
            if (projectFilesListenerUnsubscribe) {
                projectFilesListenerUnsubscribe();
                projectFilesListenerUnsubscribe = null;
            }
            projectFiles = [];
        }

        renderProjects();
        renderBoard();
        void applyPendingTaskLink();

        // Re-scope the "My Tasks" badge to the now-loaded/updated accessible
        // projects (its listeners query by projectId, so they need the project
        // list). Cheap: unsubscribes+resubscribes; projects change rarely.
        if (state.currentUser) subscribeToMyTasks();
    }, error => {
        console.error("Error listening to projects:", error);
    });

    const publishUsers = (users) => {
        state.users = users;
        console.log('Users loaded:', users.length, 'for org:', orgId); // Debug

        // Live-apply role/access changes to the CURRENT user without a re-login:
        // if an owner/admin changed our orgRole or allowedProjects via the
        // control panel, refresh state and re-apply UI permissions immediately.
        if (state.currentUser) {
            const me = users.find(u => u.id === state.currentUser.uid);
            if (me) {
                const newOrgRole = me.orgRole || 'employee';
                const newRole = me.role || 'reader';
                const changed = newOrgRole !== state.orgRole
                    || newRole !== state.currentUser.role
                    || JSON.stringify(me.allowedProjects || []) !== JSON.stringify(state.currentUser.allowedProjects || []);
                state.orgRole = newOrgRole;
                state.role = newRole;
                state.currentUser.orgRole = newOrgRole;
                state.currentUser.role = newRole;
                state.currentUser.allowedProjects = me.allowedProjects || [];
                if (changed) {
                    applyRoleRestrictions();
                    renderBoard();
                }
            }
        }

        // Re-render projects and admin panel if user's access changes
        renderProjects();
        renderUsersList(); // Update admin panel - users list
        renderProjectAccessTab(); // Update admin panel - project access (by project)
        renderLoginHistoryTab(); // Update admin panel - logins/online
        renderAdminUsersStatsPanel(); // Update admin panel - users stats
    };

    // Listen for users from BOTH sources during the multi-org migration:
    // 1) organizationMemberships is the durable multi-org roster.
    // 2) users.where(organizationId) is the legacy roster and a safe fallback
    // while existing orgs are being backfilled server-side.
    if (orgId) {
        let membershipUsers = [];
        let legacyUsers = [];
        const mergeAndPublishUsers = () => {
            publishUsers(mergeOrganizationRosterUsers(legacyUsers, membershipUsers));
        };

        const membershipUnsub = db.collection('organizationMemberships')
            .where('organizationId', '==', orgId)
            .onSnapshot(snapshot => {
                const users = [];
                const seenIds = new Set();
                snapshot.forEach(doc => {
                    const data = doc.data();
                    const userId = data.userId || '';
                    if (!userId || seenIds.has(userId) || data.organizationId !== orgId) return;
                    seenIds.add(userId);
                    users.push({ id: userId, ...data });
                });
                membershipUsers = users;
                mergeAndPublishUsers();
            }, error => {
                console.error("Error listening to organization memberships:", error);
                membershipUsers = [];
                mergeAndPublishUsers();
            });

        const legacyUsersUnsub = db.collection('users')
            .where('organizationId', '==', orgId)
            .onSnapshot(snapshot => {
                const users = [];
                snapshot.forEach(doc => {
                    const data = doc.data();
                    if (data.organizationId === orgId) users.push({ id: doc.id, ...data });
                });
                legacyUsers = users;
                mergeAndPublishUsers();
            }, error => {
                console.error("Error listening to legacy org users:", error);
                legacyUsers = [];
                mergeAndPublishUsers();
            });

        usersListenerUnsubscribe = () => {
            membershipUnsub();
            legacyUsersUnsub();
        };
    }


}

function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

function selectProject(id) {
    state.activeProjectId = id;
    state.boardView = 'assigned'; // Always open "Assigned" first
    state.ganttMonth = null; // Gantt always opens on the whole year
    renderProjects(); // To update active class
    subscribeToProjectTasks(id); // Fetch tasks for this project only
    subscribeToProjectFiles(id); // Fetch project-level files (distinct from task attachments)

    // Close sidebar on mobile
    if (window.innerWidth <= 768) {
        elements.sidebar.classList.remove('active');
        if (elements.sidebarOverlay) elements.sidebarOverlay.classList.remove('active');
    }
}

function subscribeToProjectTasks(projectId) {
    // Unsubscribe from previous listener if exists
    if (taskListenerUnsubscribe) {
        taskListenerUnsubscribe();
        taskListenerUnsubscribe = null;
    }

    // Show loading state in board (optional, but good for UX)
    if (elements.listAssigned) elements.listAssigned.innerHTML = '<div class="spinner" style="margin: 2rem auto;"></div>';
    elements.listInProgress.innerHTML = '<div class="spinner" style="margin: 2rem auto;"></div>';
    if (elements.listReview) elements.listReview.innerHTML = '';

    // Subscribe to new project tasks
    taskListenerUnsubscribe = db.collection('tasks')
        .where('projectId', '==', projectId)
        .onSnapshot(snapshot => {
            const tasks = [];
            snapshot.forEach(doc => {
                tasks.push({ id: doc.id, ...doc.data() });
            });
            state.tasks = tasks;
            renderBoard();
        }, error => {
            console.error("Error fetching tasks:", error);
            const errHtml = '<p style="color: var(--text-secondary); text-align: center;">Ошибка загрузки задач</p>';
            if (elements.listAssigned) elements.listAssigned.innerHTML = errHtml;
            elements.listInProgress.innerHTML = errHtml;
            if (elements.listReview) elements.listReview.innerHTML = '';
        });
}

// ========== PROJECT FILES (distinct from per-task attachments above) ==========
// Live Firestore listener on projects/{projectId}/files, matching the pattern
// used for tasks/users elsewhere in this file (setupRealtimeListeners,
// subscribeToProjectTasks).
function subscribeToProjectFiles(projectId) {
    if (projectFilesListenerUnsubscribe) {
        projectFilesListenerUnsubscribe();
        projectFilesListenerUnsubscribe = null;
    }

    projectFilesListenerUnsubscribe = db.collection('projects').doc(projectId).collection('files')
        .orderBy('uploadedAt', 'desc')
        .onSnapshot(snapshot => {
            projectFiles = [];
            snapshot.forEach(doc => {
                projectFiles.push({ id: doc.id, ...doc.data() });
            });
            renderProjectFilesList();
        }, error => {
            console.error("Error listening to project files:", error);
            if (elements.projectFilesList) {
                elements.projectFilesList.textContent = 'Ошибка загрузки файлов проекта';
            }
        });
}

function extractionStatusLabel(status) {
    if (status === 'done') return { text: 'Готово', className: 'done' };
    if (status === 'error') return { text: 'Ошибка', className: 'error' };
    return { text: 'Обработка...', className: 'pending' };
}

// Builds each file row via safe DOM methods (textContent) rather than
// innerHTML, since filename/status come from Firestore and should not be
// interpolated into HTML strings.
function renderProjectFilesList() {
    const list = elements.projectFilesList;
    if (!list) return;
    if (elements.addProjectFileBtn) {
        elements.addProjectFileBtn.style.display = canManageTasks() ? 'inline-flex' : 'none';
    }

    list.innerHTML = '';

    if (!projectFiles.length) {
        const empty = document.createElement('p');
        empty.style.cssText = 'color: var(--text-secondary); text-align: center; padding: 1rem 0;';
        empty.textContent = 'Файлы проекта ещё не загружены';
        list.appendChild(empty);
        return;
    }

    projectFiles.forEach(file => {
        const fileType = getFileType(file.filename || '');
        const iconClass = getFileIcon(fileType);
        const status = extractionStatusLabel(file.extractionStatus);

        const item = document.createElement('div');
        item.className = 'file-list-item';
        if (file.url) {
            item.style.cursor = 'pointer';
            item.onclick = () => {
                const safeUrl = sanitizeAttachmentUrl(file.url);
                if (safeUrl) window.open(safeUrl, '_blank', 'noopener');
            };
        }

        const iconWrap = document.createElement('div');
        iconWrap.className = `attachment-icon ${fileType}`;
        const icon = document.createElement('i');
        icon.className = `fa-solid ${iconClass}`;
        iconWrap.appendChild(icon);

        const info = document.createElement('div');
        info.className = 'attachment-info';

        const nameEl = document.createElement('div');
        nameEl.className = 'attachment-name';
        nameEl.textContent = file.filename || 'Файл';

        const sizeEl = document.createElement('div');
        sizeEl.className = 'attachment-size';
        sizeEl.textContent = `${formatFileSize(file.sizeBytes || 0)} · `;
        const statusEl = document.createElement('span');
        statusEl.className = `extraction-status extraction-status-${status.className}`;
        statusEl.textContent = status.text;
        sizeEl.appendChild(statusEl);

        info.appendChild(nameEl);
        info.appendChild(sizeEl);

        item.appendChild(iconWrap);
        item.appendChild(info);

        if (canManageTasks()) {
            // Delete button — lets a project manager remove a file uploaded by
            // mistake so the AI agent no longer reads its content.
            const deleteBtn = document.createElement('button');
            deleteBtn.type = 'button';
            deleteBtn.className = 'file-delete-btn';
            deleteBtn.title = 'Удалить файл';
            deleteBtn.setAttribute('aria-label', `Удалить файл ${file.filename || ''}`);
            const trashIcon = document.createElement('i');
            trashIcon.className = 'fa-solid fa-trash';
            deleteBtn.appendChild(trashIcon);
            deleteBtn.onclick = (e) => {
                e.stopPropagation();
                deleteProjectFile(file.id, file.filename || 'Файл');
            };
            item.appendChild(deleteBtn);
        }

        list.appendChild(item);
    });
}

// Deletes a project file via the server (DELETE /api/project-files). The server
// removes the Firestore doc under projects/{projectId}/files/{fileId}; the live
// onSnapshot listener then refreshes the list automatically.
async function deleteProjectFile(fileId, filename) {
    if (!fileId) return;
    const projectId = state.activeProjectId;
    if (!projectId) return;
    if (!canManageTasks()) {
        alert('Недостаточно прав для удаления файлов проекта');
        return;
    }

    if (!confirm(`Удалить файл «${filename}»? Агент перестанет использовать его содержимое.`)) {
        return;
    }

    try {
        const currentUser = firebase.auth().currentUser;
        if (!currentUser) throw new Error('Вы не авторизованы');
        const idToken = await currentUser.getIdToken();

        // Pass ids as query params, NOT a request body: mobile Safari and some
        // proxies drop the body of a fetch DELETE, which made deletion fail on
        // phones ("Ошибка") while working on desktop. Query params always arrive.
        const url = `/api/project-files?projectId=${encodeURIComponent(projectId)}&fileId=${encodeURIComponent(fileId)}`;
        const response = await fetch(url, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${idToken}` },
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result.error || `Не удалось удалить файл (код ${response.status})`);
        }

        playClickSound();
    } catch (error) {
        console.error('Project file delete error:', error);
        alert('Ошибка при удалении файла: ' + error.message);
    }
}

// Upload a project-level document to Cloudinary as a raw resource (not the
// per-task attachment picker), then register it via POST /api/project-files
// so the server can create the Firestore doc and run background text
// extraction. Kept separate from uploadToCloudinary()/handleFileSelect()
// (which power task attachments) since project files use resource_type=raw
// and a different set of allowed extensions.
const PROJECT_FILE_MAX_BYTES = 10 * 1024 * 1024;
const PROJECT_FILE_ALLOWED_EXTENSIONS = ['md', 'xlsx', 'xlsm', 'pdf', 'docx'];

async function uploadProjectFileToCloudinary(file) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('upload_preset', cloudinaryConfig.uploadPreset);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 60000);

    try {
        const response = await fetch(
            `https://api.cloudinary.com/v1_1/${cloudinaryConfig.cloudName}/raw/upload`,
            {
                method: 'POST',
                body: formData,
                mode: 'cors',
                signal: controller.signal
            }
        );
        clearTimeout(timeoutId);

        if (!response.ok) {
            let errorMsg = response.statusText;
            try {
                const errorData = await response.json();
                errorMsg = errorData.error?.message || response.statusText;
            } catch (e) { /* ignore parse failure */ }
            throw new Error(errorMsg);
        }

        return await response.json();
    } catch (error) {
        clearTimeout(timeoutId);
        if (error.name === 'AbortError') {
            throw new Error('Загрузка слишком долгая. Проверьте интернет или попробуйте файл меньшего размера');
        }
        if (error.message === 'Failed to fetch' || error.message === 'Load failed') {
            throw new Error('Ошибка сети. Проверьте подключение к интернету');
        }
        throw error;
    }
}

async function handleProjectFileSelect(event) {
    const file = event.target.files[0];
    event.target.value = ''; // Reset input so selecting the same file again re-triggers change
    if (!file) return;
    if (!canManageTasks()) {
        alert('Загружать файлы проекта может владелец, админ или модератор.');
        return;
    }

    const projectId = state.activeProjectId;
    if (!projectId) {
        alert('Сначала выберите проект');
        return;
    }

    const ext = file.name.toLowerCase().split('.').pop();
    if (!PROJECT_FILE_ALLOWED_EXTENSIONS.includes(ext)) {
        alert(`Неподдерживаемый тип файла: .${ext}. Разрешены: ${PROJECT_FILE_ALLOWED_EXTENSIONS.join(', ')}`);
        return;
    }
    if (file.size > PROJECT_FILE_MAX_BYTES) {
        alert(`Файл слишком большой. Максимум ${formatFileSize(PROJECT_FILE_MAX_BYTES)}`);
        return;
    }

    const btn = elements.addProjectFileBtn;
    setButtonLoading(btn, true, 'Загружаем…');

    try {
        const currentUser = firebase.auth().currentUser;
        if (!currentUser) {
            throw new Error('Вы не авторизованы');
        }
        const idToken = await currentUser.getIdToken();

        const uploadResult = await uploadProjectFileToCloudinary(file);

        const response = await fetch('/api/project-files', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({
                projectId,
                filename: file.name,
                url: uploadResult.secure_url,
                mimeType: file.type || null,
                sizeBytes: file.size,
                uploadedBy: state.currentUser?.uid || null,
            }),
        });

        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result.error || 'Не удалось сохранить файл');
        }

        playClickSound();
    } catch (error) {
        console.error('Project file upload error:', error);
        alert('Ошибка при загрузке файла: ' + error.message);
    } finally {
        setButtonLoading(btn, false);
    }
}

async function deleteTask(id) {
    // Check permission - owner, admin, or moderator can delete tasks
    if (!canManageTasks()) {
        alert('Недостаточно прав для удаления задачи');
        return;
    }
    if (!confirm('Вы уверены, что хотите удалить эту задачу?')) return;
    try {
        await db.collection('tasks').doc(id).delete();
        await refreshMyTasksModalIfOpen();
    } catch (error) {
        console.error('Error deleting task:', error);
        alert('Ошибка при удалении задачи: ' + error.message);
    }
}

async function deleteProject(id) {
    // Check permission - only owner or admin can delete projects
    if (!canManageProjects()) {
        alert('Недостаточно прав для удаления проекта');
        return;
    }

    if (!confirm('Вы уверены? Все задачи этого проекта будут удалены.')) return;

    try {
        // Delete project tasks first while the project still exists for org-role rule checks.
        const tasksSnapshot = await db.collection('tasks').where('projectId', '==', id).get();
        const batch = db.batch();
        tasksSnapshot.forEach(doc => {
            batch.delete(doc.ref);
        });
        batch.delete(db.collection('projects').doc(id));
        await batch.commit();

        if (state.activeProjectId === id) {
            state.activeProjectId = null;
            state.tasks = [];
            renderBoard();
        }
    } catch (error) {
        console.error('Error deleting project:', error);
        alert('Ошибка при удалении проекта: ' + error.message);
    }
}

// Switch the (shared) project modal between "create" and "edit" appearance.
function setProjectModalMode(mode) {
    const modal = elements.projectModal;
    if (!modal) return;
    const title = modal.querySelector('.project-modal-title');
    const subtitle = modal.querySelector('.project-modal-subtitle');
    const icon = modal.querySelector('.project-modal-icon i');
    const submitBtn = modal.querySelector('button[type="submit"]');
    const isEdit = mode === 'edit';

    if (title) title.textContent = isEdit ? 'Редактировать проект' : 'Новый проект';
    if (subtitle) subtitle.textContent = isEdit
        ? 'Измените название, описание или срок'
        : 'Создайте проект для организации задач';
    if (icon) icon.className = isEdit ? 'fa-solid fa-pen' : 'fa-solid fa-folder-plus';
    if (submitBtn) {
        submitBtn.textContent = '';
        const ic = document.createElement('i');
        ic.className = isEdit ? 'fa-solid fa-check' : 'fa-solid fa-plus';
        submitBtn.appendChild(ic);
        submitBtn.appendChild(document.createTextNode(isEdit ? ' Сохранить' : ' Создать проект'));
    }
}

// Open the project modal pre-filled to EDIT an existing project.
function openEditProjectModal(project) {
    if (!project) return;
    document.getElementById('p-id').value = project.id;
    document.getElementById('p-name').value = project.name || '';
    document.getElementById('p-desc').value = project.description || '';

    const hasDeadlineCb = document.getElementById('p-has-deadline');
    const deadlineGroup = document.getElementById('p-deadline-group');
    const deadlineInput = document.getElementById('p-deadline');
    if (project.deadline) {
        if (hasDeadlineCb) hasDeadlineCb.checked = true;
        if (deadlineGroup) deadlineGroup.classList.add('active');
        if (deadlineInput) deadlineInput.value = String(project.deadline).slice(0, 10);
    } else {
        if (hasDeadlineCb) hasDeadlineCb.checked = false;
        if (deadlineGroup) deadlineGroup.classList.remove('active');
        if (deadlineInput) deadlineInput.value = '';
    }

    setProjectModalMode('edit');
    elements.projectModal.classList.add('active');
    closeSidebarOnMobile();
}

// Update an existing project (name/description/deadline). Owner/admin only —
// the Firestore rule allows the update as long as organizationId is unchanged.
function updateProject(id, { name, description, deadline }) {
    if (!canManageProjects()) {
        return Promise.reject(new Error('Недостаточно прав для редактирования проекта'));
    }
    return db.collection('projects').doc(id).update({
        name: name,
        description: description || '',
        deadline: deadline || null,
    });
}

function updateTask(id, data) {
    // Check permission - owner, admin, or moderator can update tasks
    if (!canManageTasks()) {
        alert('Недостаточно прав для редактирования задачи');
        return Promise.resolve();
    }

    // Show loading state (button may be outside form)
    const submitBtn = document.querySelector('button[form="task-form"]') ||
        elements.taskForm.querySelector('button[type="submit"]');
    if (submitBtn) setButtonLoading(submitBtn, true, 'Сохранить');

    return db.collection('tasks').doc(id).update(data)
        .then(async () => {
            console.log("✅ Задача успешно обновлена!");
            elements.taskModal.classList.remove('active');
            elements.taskForm.reset();
            await refreshMyTasksModalIfOpen();
            if (submitBtn) setButtonLoading(submitBtn, false, 'Сохранить');
        })
        .catch((error) => {
            console.error("Error updating task:", error);
            alert("❌ Ошибка при обновлении задачи:\n\n" + error.message);
            if (submitBtn) setButtonLoading(submitBtn, false, 'Сохранить');
        });
}

function sortedIdList(ids) {
    return (Array.isArray(ids) ? ids : []).filter(Boolean).slice().sort();
}

function sameIdList(a, b) {
    return JSON.stringify(sortedIdList(a)) === JSON.stringify(sortedIdList(b));
}

function openEditTaskModal(task) {
    elements.taskForm.reset();

    // Set hidden ID
    document.getElementById('t-id').value = task.id;
    document.getElementById('t-status').value = task.status;

    // Set fields
    document.getElementById('t-title').value = task.title;
    document.getElementById('t-description').value = task.description || '';
    document.getElementById('t-deadline').value = task.deadline;

    // Update modal title
    elements.taskModal.querySelector('h2').textContent = 'Редактировать задачу';

    // Populate assignees picker and load existing assignees
    populateAssigneeDropdown();
    populateCoCreatorDropdown();

    // Set selected assignees from task (rebuilds from assigneeIds — see helper)
    setSelectedAssignees(task);
    setSelectedCoCreators(task);

    // Load existing attachments
    pendingAttachments = task.attachments ? [...task.attachments] : [];
    renderAttachmentsList();
    updateAddAttachmentBtn();

    elements.taskModal.classList.add('active');
}

// Rendering
// The users listener re-renders on EVERY snapshot (presence heartbeats fire
// them constantly), which used to rebuild this list each time — the view
// switcher under the active project replayed its enter-animation and visibly
// flickered. Skip the rebuild when nothing the list shows has changed.
let lastProjectListSignature = null;
function renderProjects() {
    const filteredProjects = getFilteredProjects();
    const signature = JSON.stringify([
        state.activeProjectId,
        state.projectView,
        filteredProjects.map(p => [p.id, p.name, p.deadline || null]),
    ]);
    // Skip only when the list is actually rendered: resetWorkspaceState()
    // clears the DOM directly, and skipping after that left the sidebar
    // EMPTY on re-entering an org whose data hadn't changed (prod bug).
    if (signature === lastProjectListSignature
        && elements.projectList.children.length === filteredProjects.length
        && filteredProjects.length > 0) return;
    lastProjectListSignature = signature;

    elements.projectList.innerHTML = '';

    filteredProjects.forEach(project => {
        const li = document.createElement('li');
        li.className = `project-item ${project.id === state.activeProjectId ? 'active' : ''}`;
        li.dataset.id = project.id;

        // Build deadline info if exists
        let deadlineHtml = '';
        if (project.deadline) {
            const deadlineDate = new Date(project.deadline);
            const now = new Date();
            const daysLeft = Math.ceil((deadlineDate - now) / (1000 * 60 * 60 * 24));

            let deadlineClass = 'project-deadline';
            if (daysLeft < 0) {
                deadlineClass += ' overdue';
            } else if (daysLeft <= 7) {
                deadlineClass += ' soon';
            }

            const formattedDate = formatDate(project.deadline);

            deadlineHtml = `<span class="${deadlineClass}"><i class="fa-regular fa-clock"></i> ${formattedDate}</span>`;
        }

        li.innerHTML = `
            <div class="project-item-content">
                <div class="project-item-main">
            <i class="fa-solid fa-folder"></i>
                    <span class="project-item-name">${escapeHtml(project.name)}</span>
                </div>
                ${deadlineHtml}
            </div>
        `;
        // Kanban/Gantt view switcher appears only under the ACTIVE project.
        // Built with DOM methods (static labels, no user data).
        if (project.id === state.activeProjectId) {
            const switchWrap = document.createElement('div');
            switchWrap.className = 'project-view-switch';
            [
                { view: 'kanban', icon: 'fa-table-columns', label: 'Канбан' },
                { view: 'gantt', icon: 'fa-chart-gantt', label: 'Гант' },
                { view: 'calendar', icon: 'fa-calendar-days', label: 'Календарь' }
            ].forEach(({ view, icon, label }) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'view-switch-btn' + (state.projectView === view ? ' active' : '');
                btn.dataset.pview = view;
                const iconEl = document.createElement('i');
                iconEl.className = `fa-solid ${icon}`;
                btn.appendChild(iconEl);
                btn.appendChild(document.createTextNode(' ' + label));
                switchWrap.appendChild(btn);
            });
            li.querySelector('.project-item-content')?.appendChild(switchWrap);
        }

        li.onclick = (e) => {
            const viewBtn = e.target.closest('.view-switch-btn');
            if (viewBtn) {
                playClickSound();
                setProjectView(viewBtn.dataset.pview);
                closeSidebarOnMobile();
                return;
            }
            playClickSound();
            selectProject(project.id);
            closeSidebarOnMobile();
        };
        elements.projectList.appendChild(li);
    });
}

function renderBoard() {
    const activeProject = state.projects.find(p => p.id === state.activeProjectId);

    if (!activeProject) {
        elements.boardContainer.classList.remove('active');
        if (elements.ganttContainer) elements.ganttContainer.classList.remove('active');
        calElements.container?.classList.remove('active');
        elements.emptyState.style.display = 'flex';
        elements.projectTitle.textContent = 'Выберите проект';
        elements.projectDesc.textContent = 'или создайте новый';
        elements.addTaskBtn.disabled = true;
        elements.deleteProjectBtn.style.display = 'none';
        if (elements.editProjectBtn) elements.editProjectBtn.style.display = 'none';
        if (elements.projectFilesBtn) elements.projectFilesBtn.style.display = 'none';
        if (elements.taskArchiveBtn) elements.taskArchiveBtn.style.display = 'none';
        elements.taskArchiveModal?.classList.remove('active');
        return;
    }

    // Only one of the three views is visible; the kanban lists below are still
    // (re)built even in Gantt/Calendar mode so counts and columns stay fresh
    // on switch.
    const isGanttView = state.projectView === 'gantt';
    const isCalendarView = state.projectView === 'calendar';
    elements.boardContainer.classList.toggle('active', !isGanttView && !isCalendarView);
    if (elements.ganttContainer) elements.ganttContainer.classList.toggle('active', isGanttView);
    calElements.container?.classList.toggle('active', isCalendarView);
    elements.emptyState.style.display = 'none';
    elements.projectTitle.textContent = activeProject.name;

    // Show deadline in description if exists
    let descText = activeProject.description || '';
    if (activeProject.deadline) {
        const deadlineDate = new Date(activeProject.deadline);
        const now = new Date();
        const daysLeft = Math.ceil((deadlineDate - now) / (1000 * 60 * 60 * 24));
        const formattedDate = formatDate(activeProject.deadline);

        let deadlineText = `<i class="fa-regular fa-calendar"></i> Срок: ${formattedDate}`;
        if (daysLeft < 0) {
            deadlineText += ' (просрочено!)';
        } else if (daysLeft === 0) {
            deadlineText += ' (сегодня!)';
        } else if (daysLeft === 1) {
            deadlineText += ' (завтра)';
        } else if (daysLeft <= 7) {
            deadlineText += ` (${daysLeft} дн.)`;
        }

        descText = descText ? `${escapeHtml(descText)} • ${deadlineText}` : deadlineText;
        elements.projectDesc.innerHTML = descText;
    } else {
        elements.projectDesc.textContent = descText;
    }

    elements.addTaskBtn.disabled = !canManageTasks();
    elements.deleteProjectBtn.style.display = canManageProjects() ? 'flex' : 'none';
    elements.deleteProjectBtn.onclick = canManageProjects() ? () => {
        playClickSound();
        deleteProject(activeProject.id);
    } : null;
    if (elements.editProjectBtn) {
        elements.editProjectBtn.style.display = canManageProjects() ? 'inline-flex' : 'none';
        elements.editProjectBtn.onclick = canManageProjects() ? () => {
            playClickSound();
            openEditProjectModal(activeProject);
        } : null;
    }
    if (elements.projectFilesBtn) elements.projectFilesBtn.style.display = 'inline-flex';
    if (elements.taskArchiveBtn) elements.taskArchiveBtn.style.display = 'inline-flex';

    // Clear lists
    if (elements.listAssigned) elements.listAssigned.innerHTML = '';
    elements.listInProgress.innerHTML = '';
    if (elements.listReview) elements.listReview.innerHTML = '';

    const projectTasks = state.tasks.filter(t => t.projectId === activeProject.id);

    // Sort: In-progress tasks by deadline (closest first)
    projectTasks.sort((a, b) => {
        if (a.status === 'in-progress' && b.status === 'in-progress') {
            return new Date(a.deadline) - new Date(b.deadline);
        }
        return 0;
    });

    const getTaskSubStatusForBoard = (task) => {
        // Migration logic for old tasks without subStatus
        let currentSubStatus = task.subStatus || 'assigned';
        if (!task.subStatus) {
            if (task.assigneeCompleted) currentSubStatus = 'completed';
            else currentSubStatus = 'assigned';
        }
        // Archived tasks are "done"
        if (task.status === 'done') currentSubStatus = 'done';
        return currentSubStatus;
    };

    const assignedTasks = projectTasks.filter(t => t.status === 'in-progress' && getTaskSubStatusForBoard(t) === 'assigned');
    const inProgressTasks = projectTasks.filter(t => t.status === 'in-progress' && getTaskSubStatusForBoard(t) === 'in_work');
    const reviewTasks = projectTasks.filter(t => t.status === 'in-progress' && getTaskSubStatusForBoard(t) === 'completed');
    const doneTasks = projectTasks.filter(t => t.status === 'done');

    // Update counts
    if (elements.countAssigned) elements.countAssigned.textContent = String(assignedTasks.length);
    if (elements.countInProgress) elements.countInProgress.textContent = String(inProgressTasks.length);
    if (elements.countReview) elements.countReview.textContent = String(reviewTasks.length);
    if (elements.taskArchiveCount) elements.taskArchiveCount.textContent = String(doneTasks.length);

    const renderColumn = (list, tasks) => {
        if (!list) return;
        list.innerHTML = '';
        if (!tasks.length) {
            const empty = document.createElement('div');
            empty.className = 'kanban-column-empty';
            empty.textContent = 'Нет задач';
            list.appendChild(empty);
            return;
        }
        tasks.forEach(task => list.appendChild(createTaskCard(task)));
    };

    renderColumn(elements.listAssigned, assignedTasks);
    renderColumn(elements.listInProgress, inProgressTasks);
    renderColumn(elements.listReview, reviewTasks);

    // Desktop keeps all active columns visible; mobile keeps one selected column.
    setBoardView(state.boardView || 'assigned');

    // Keep an already-open archive live when task status changes in Firestore.
    if (elements.taskArchiveModal?.classList.contains('active')) renderTaskArchive();

    // Gantt/Calendar render from the same tasks snapshot, so they live-update too
    if (isGanttView) renderGantt();
    if (isCalendarView) renderCalendar();
}

let pendingArchiveTaskId = null;

function taskTimestampMs(value) {
    if (!value) return 0;
    if (typeof value.toMillis === 'function') return value.toMillis();
    if (typeof value.toDate === 'function') return value.toDate().getTime();
    const parsed = new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : 0;
}

function renderTaskArchive() {
    const list = elements.taskArchiveList;
    if (!list) return;

    const activeProject = state.projects.find(project => project.id === state.activeProjectId);
    if (elements.taskArchiveSubtitle) {
        elements.taskArchiveSubtitle.textContent = activeProject
            ? `Завершённые задачи проекта «${activeProject.name}»`
            : 'Завершённые задачи проекта';
    }

    const archivedTasks = state.tasks
        .filter(task => task.projectId === state.activeProjectId && task.status === 'done')
        .sort((a, b) => {
            const timeA = taskTimestampMs(a.archivedAt || a.completedAt || a.updatedAt || a.createdAt);
            const timeB = taskTimestampMs(b.archivedAt || b.completedAt || b.updatedAt || b.createdAt);
            return timeB - timeA;
        });

    if (elements.taskArchiveCount) elements.taskArchiveCount.textContent = String(archivedTasks.length);
    list.innerHTML = '';

    if (!archivedTasks.length) {
        const empty = document.createElement('div');
        empty.className = 'task-archive-empty';
        empty.innerHTML = '<i class="fa-solid fa-box-open"></i><p>В архиве пока нет завершённых задач</p>';
        list.appendChild(empty);
        return;
    }

    archivedTasks.forEach(task => list.appendChild(createTaskCard(task)));

    if (pendingArchiveTaskId) {
        const targetId = pendingArchiveTaskId;
        requestAnimationFrame(() => {
            const card = Array.from(list.querySelectorAll('.task-card'))
                .find(item => item.dataset.taskId === targetId);
            if (!card) return;
            card.scrollIntoView({ behavior: 'smooth', block: 'center' });
            card.classList.add('highlight-task');
            setTimeout(() => card.classList.remove('highlight-task'), 2000);
            pendingArchiveTaskId = null;
        });
    }
}

function openTaskArchiveModal(taskId = null) {
    if (!elements.taskArchiveModal || !state.activeProjectId) return;
    pendingArchiveTaskId = taskId || null;
    renderTaskArchive();
    elements.taskArchiveModal.classList.add('active');
}

// --- NEW TASK CARD WITH STATUS BADGES ---
// ========== GLOBAL STATUS MENU - ANIMATED ==========
let globalStatusMenu = null;
let globalStatusOverlay = null;
let statusMenuTouchStartY = 0;
let statusMenuTouchCurrentY = 0;
let statusMenuIsDragging = false;

function createGlobalStatusMenu() {
    if (globalStatusMenu) return;

    // Create overlay
    globalStatusOverlay = document.createElement('div');
    globalStatusOverlay.className = 'status-menu-overlay';
    document.body.appendChild(globalStatusOverlay);

    // Create menu
    globalStatusMenu = document.createElement('div');
    globalStatusMenu.className = 'status-dropdown';
    document.body.appendChild(globalStatusMenu);

    // Close on overlay click
    globalStatusOverlay.addEventListener('click', closeGlobalStatusMenu);

    // Close on outside click (PC)
    document.addEventListener('click', (e) => {
        if (globalStatusMenu?.classList.contains('active') &&
            !globalStatusMenu.contains(e.target) &&
            !e.target.closest('.status-badge')) {
            closeGlobalStatusMenu();
        }
    });

    // Close on Escape
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeGlobalStatusMenu();
    });

    // Swipe down to close (mobile)
    globalStatusMenu.addEventListener('touchstart', handleStatusMenuTouchStart, { passive: true });
    globalStatusMenu.addEventListener('touchmove', handleStatusMenuTouchMove, { passive: false });
    globalStatusMenu.addEventListener('touchend', handleStatusMenuTouchEnd, { passive: true });
}

function handleStatusMenuTouchStart(e) {
    if (window.innerWidth > 768) return;
    statusMenuTouchStartY = e.touches[0].clientY;
    statusMenuTouchCurrentY = statusMenuTouchStartY;
    statusMenuIsDragging = true;
    globalStatusMenu.style.transition = 'none';
}

function handleStatusMenuTouchMove(e) {
    if (!statusMenuIsDragging || window.innerWidth > 768) return;

    statusMenuTouchCurrentY = e.touches[0].clientY;
    const deltaY = statusMenuTouchCurrentY - statusMenuTouchStartY;

    // Only allow dragging down
    if (deltaY > 0) {
        e.preventDefault();
        globalStatusMenu.style.transform = `translateY(${deltaY}px)`;

        // Fade overlay based on drag distance
        const opacity = Math.max(0, 1 - deltaY / 200);
        globalStatusOverlay.style.opacity = opacity;
    }
}

function handleStatusMenuTouchEnd() {
    if (!statusMenuIsDragging || window.innerWidth > 768) return;

    statusMenuIsDragging = false;
    const deltaY = statusMenuTouchCurrentY - statusMenuTouchStartY;

    // Restore transition
    globalStatusMenu.style.transition = '';
    globalStatusOverlay.style.transition = '';
    globalStatusOverlay.style.opacity = '';

    // If dragged more than 80px down, close the menu
    if (deltaY > 80) {
        closeGlobalStatusMenu();
    } else {
        // Snap back
        globalStatusMenu.style.transform = '';
    }
}

function closeGlobalStatusMenu() {
    if (globalStatusMenu) {
        globalStatusMenu.style.transform = '';
        globalStatusMenu.classList.remove('active');
    }
    if (globalStatusOverlay) {
        globalStatusOverlay.style.opacity = '';
        globalStatusOverlay.classList.remove('active');
    }
    setTimeout(() => {
        if (globalStatusMenu) globalStatusMenu.innerHTML = '';
    }, 300);
}

// The status menu is appended directly to <body> and is shared by the Kanban
// board and «Мои задачи». Keep its children in one vertical column inline:
// this prevents legacy/adaptive stylesheet rules (and a cached CSS bundle)
// from turning the header and the executor action into a horizontal row.
function enforceVerticalStatusMenuLayout() {
    if (!globalStatusMenu) return;
    globalStatusMenu.style.setProperty('display', 'flex', 'important');
    globalStatusMenu.style.setProperty('flex-direction', 'column', 'important');
    globalStatusMenu.style.setProperty('align-items', 'stretch', 'important');
    globalStatusMenu.style.setProperty('gap', '4px', 'important');
    globalStatusMenu.style.setProperty('box-sizing', 'border-box', 'important');

    Array.from(globalStatusMenu.children).forEach((child) => {
        child.style.setProperty('display', 'flex', 'important');
        child.style.setProperty('width', '100%', 'important');
        child.style.setProperty('max-width', '100%', 'important');
        child.style.setProperty('flex', '0 0 auto', 'important');
        child.style.setProperty('box-sizing', 'border-box', 'important');
    });
}

// Determines whether the signed-in user is an assignee of the task.
// Primary match is by uid (task.assigneeIds vs currentUser.uid) — this is the
// only reliable key for Telegram-login users, who have no email. Falls back to
// email and then full-name matching for legacy tasks created before assigneeIds
// was stored. Without the uid check, a self-assigned task never showed the
// "Взять в работу" action for Telegram users (empty email → no match).
function isCurrentUserAssignee(task) {
    const user = state.currentUser;
    if (!user || !task) return false;

    if (user.uid && Array.isArray(task.assigneeIds) && task.assigneeIds.includes(user.uid)) {
        return true;
    }
    if (user.email && task.assigneeEmail) {
        const emails = task.assigneeEmail.toLowerCase().split(',').map(e => e.trim());
        if (emails.includes(user.email.toLowerCase())) return true;
    }
    if (task.assignee) {
        const name = user.fullName || `${user.firstName || ''} ${user.lastName || ''}`.trim();
        if (name && task.assignee.split(',').map(n => n.trim()).includes(name)) return true;
    }
    return false;
}

function openStatusMenu(event, task, currentSubStatus) {
    event.stopPropagation();
    playClickSound();
    createGlobalStatusMenu();

    globalStatusMenu.innerHTML = '';
    globalStatusMenu.classList.toggle('status-dropdown-executor', isCurrentUserAssignee(task));

    // Постановщик = менеджер проекта ИЛИ доп. постановщик этой задачи
    const canManage = canActAsTaskCreator(task);
    const isMobile = window.innerWidth <= 768;

    // Check if user is assignee
    const isAssignee = isCurrentUserAssignee(task);

    // Add header
    const header = document.createElement('div');
    header.className = 'status-dropdown-header';
    header.innerHTML = '<span>Выберите действие</span>';
    globalStatusMenu.appendChild(header);

    // Option builder
    const addOption = (label, desc, icon, iconType, newStatus, requiresProof = false, requiresRevision = false) => {
        const opt = document.createElement('div');
        opt.className = 'status-option';
        opt.style.setProperty('--glow-color', getGlowColor(iconType));
        opt.innerHTML = `
            <div class="status-option-icon ${iconType}">
                <i class="fa-solid ${icon}"></i>
            </div>
            <div class="status-option-text">
                <div class="status-option-label">${label}</div>
                <div class="status-option-desc">${desc}</div>
            </div>
        `;

        opt.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeGlobalStatusMenu();
            playClickSound();

            setTimeout(() => {
                if (requiresProof) {
                    openCompletionProofModal(task.id);
                } else if (requiresRevision) {
                    openRevisionReasonModal(task.id);
                } else {
                    updateTaskSubStatus(task.id, newStatus);
                }
            }, 150);
        });

        globalStatusMenu.appendChild(opt);
    };

    function getGlowColor(type) {
        const colors = {
            'work': 'rgba(251, 191, 36, 0.15)',
            'complete': 'rgba(34, 197, 94, 0.15)',
            'done': 'rgba(99, 102, 241, 0.15)',
            'revision': 'rgba(251, 146, 60, 0.15)'
        };
        return colors[type] || colors.work;
    }

    // Build options based on status
    if (currentSubStatus !== 'done') {
        if (isAssignee) {
            if (currentSubStatus === 'assigned') {
                addOption('Взять в работу', 'Начать выполнение', 'fa-play', 'work', 'in_work');
            } else if (currentSubStatus === 'in_work') {
                addOption('Завершить', 'Отправить на проверку', 'fa-check', 'complete', 'completed', true);
            }
        }

        if (canManage && currentSubStatus === 'completed') {
            addOption('Подтвердить', 'Отправить в архив', 'fa-check', 'done', 'done');
            addOption('На доработку', 'Вернуть исполнителю', 'fa-rotate-left', 'revision', 'in_work', false, true);
        }
    }

    // Position menu
    if (isMobile) {
        // Mobile: bottom sheet
        globalStatusOverlay.classList.add('active');
        globalStatusMenu.removeAttribute('style');
        enforceVerticalStatusMenuLayout();
    } else {
        // Desktop: keep the common action popover inside the horizontal
        // bounds of its task card (Kanban and «Мои задачи» use the same code).
        // If there is no room below, place it above instead of clipping it.
        const badge = event.target.closest('.status-badge');
        if (!badge) return;

        const rect = badge.getBoundingClientRect();
        const cardRect = badge.closest('.task-card')?.getBoundingClientRect();
        const gap = 6;
        const cardWidth = cardRect ? cardRect.width - 16 : 240;
        const menuWidth = Math.max(190, Math.min(240, cardWidth, window.innerWidth - 32));
        let left = rect.left;
        if (cardRect) {
            left = Math.max(cardRect.left + 8, Math.min(left, cardRect.right - menuWidth - 8));
        }
        left = Math.max(16, Math.min(left, window.innerWidth - menuWidth - 16));

        globalStatusMenu.setAttribute('style', `
            position: fixed !important;
            display: flex !important;
            flex-direction: column !important;
            align-items: stretch !important;
            gap: 4px !important;
            box-sizing: border-box !important;
            top: 0 !important;
            left: ${left}px !important;
            right: auto !important;
            bottom: auto !important;
            width: ${menuWidth}px !important;
            min-width: 0 !important;
            max-width: ${menuWidth}px !important;
            transform: translateY(0) !important;
            -webkit-transform: translateY(0) !important;
        `);
        const menuHeight = Math.max(1, globalStatusMenu.scrollHeight);
        const belowTop = rect.bottom + gap;
        const aboveTop = rect.top - menuHeight - gap;
        const top = belowTop + menuHeight <= window.innerHeight - 16
            ? belowTop
            : Math.max(16, aboveTop);
        globalStatusMenu.style.setProperty('top', `${top}px`, 'important');
        globalStatusMenu.style.setProperty('max-height', `${window.innerHeight - top - 16}px`, 'important');
        globalStatusMenu.style.setProperty('overflow-y', 'auto', 'important');
    }

    // Apply after positioning as setAttribute/removeAttribute above replaces
    // the previous inline declaration block.
    enforceVerticalStatusMenuLayout();

    // Animate in
    requestAnimationFrame(() => {
        globalStatusMenu.classList.add('active');
    });
}

function createTaskCard(task) {
    const div = document.createElement('div');
    div.className = 'task-card';
    if (task.status === 'done') {
        div.classList.add('completed');
    } else if (task.status === 'in-progress') {
        div.classList.add('in-progress');
    }
    div.dataset.id = task.id;
    div.dataset.taskId = task.id; // For My Tasks navigation

    // --- Status Badge System ---
    const actionsDiv = document.createElement('div');
    actionsDiv.className = 'task-actions';

    // Determine current subStatus
    let currentSubStatus = task.subStatus || 'assigned';

    // Get assignees list for avatars later
    const assignees = (task.assignee || '').split(',').map(name => name.trim()).filter(name => name.length > 0);

    // Migration logic
    if (!task.subStatus) {
        if (task.assigneeCompleted) currentSubStatus = 'completed';
        else currentSubStatus = 'assigned';
    }

    // Override if global status is done
    if (task.status === 'done') {
        currentSubStatus = 'done';
    }

    // Badge configuration
    const badge = document.createElement('div');
    badge.className = 'status-badge';

    let badgeText = '';
    let badgeIcon = '';
    let badgeClass = '';

    switch (currentSubStatus) {
        case 'assigned':
            badgeText = 'Задача поставлена';
            badgeIcon = '<i class="fa-solid fa-circle-exclamation"></i>';
            badgeClass = 'status-assigned';
            break;
        case 'in_work':
            badgeText = 'В работе';
            badgeIcon = '<i class="fa-solid fa-person-digging"></i>';
            badgeClass = 'status-in-work';
            break;
        case 'completed':
            badgeText = 'На проверке';
            badgeIcon = '<i class="fa-solid fa-clock"></i>';
            badgeClass = 'status-review';
            break;
        case 'done':
            badgeText = 'Готово (Архив)';
            badgeIcon = '<i class="fa-solid fa-check"></i>';
            badgeClass = 'status-done';
            break;
        default:
            badgeText = 'Задача поставлена';
            badgeIcon = '<i class="fa-solid fa-circle-exclamation"></i>';
            badgeClass = 'status-assigned';
    }

    badge.classList.add(badgeClass);
    badge.innerHTML = `${badgeIcon} <span>${badgeText}</span>`;

    // Dropdown Container (now just a wrapper for badge)
    const dropdownContainer = document.createElement('div');
    dropdownContainer.className = 'status-dropdown-container';
    dropdownContainer.appendChild(badge);

    // Check interactions for badge cursor style
    let canInteract = false;
    const canManage = canManageTasks(); // owner, admin, moderator

    // Check assignee logic for interactivity check (uid-first; see helper)
    const isAssignee = isCurrentUserAssignee(task);

    // Permission check for cursor style
    // Tasks in 'done' (archive) cannot be modified - they are final
    if (currentSubStatus !== 'done') {
        // Assignee can interact with assigned/in_work tasks
        if (isAssignee) {
            if (currentSubStatus === 'assigned' || currentSubStatus === 'in_work') canInteract = true;
        }
        // Managers (owner, admin, moderator) can interact with completed tasks
        if (canManage && currentSubStatus === 'completed') canInteract = true;
    }
    // Done tasks are archived and final - no interaction allowed

    if (canInteract) {
        badge.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            openStatusMenu(e, task, currentSubStatus);
        });
    } else {
        badge.style.cursor = 'default';
        badge.style.opacity = '0.9';
    }

    // Create delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-task';
    const deleteIcon = document.createElement('i');
    deleteIcon.className = 'fa-solid fa-trash';
    deleteBtn.appendChild(deleteIcon);
    deleteBtn.onclick = (e) => {
        e.stopPropagation();
        closeGlobalStatusMenu();
        playClickSound();
        deleteTask(task.id);
    };

    // Create edit button
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-task';
    editBtn.style.background = 'none';
    editBtn.style.border = 'none';
    editBtn.style.color = 'var(--text-secondary)';
    editBtn.style.cursor = 'pointer';
    editBtn.style.padding = '0.2rem';
    editBtn.style.marginRight = '0.5rem';
    editBtn.style.transition = 'color 0.2s';

    editBtn.onmouseover = () => editBtn.style.color = 'var(--primary)';
    editBtn.onmouseout = () => editBtn.style.color = 'var(--text-secondary)';

    const editIcon = document.createElement('i');
    editIcon.className = 'fa-solid fa-pen';
    editBtn.appendChild(editIcon);
    editBtn.onclick = (e) => {
        e.stopPropagation();
        closeGlobalStatusMenu();
        playClickSound();
        openEditTaskModal(task);
    };

    // Create task content
    const taskTitle = document.createElement('div');
    taskTitle.className = 'task-title';
    taskTitle.textContent = task.title;

    const taskMeta = document.createElement('div');
    taskMeta.className = 'task-meta';

    const assigneeDiv = document.createElement('div');
    assigneeDiv.className = 'assignee';

    // Create avatars for each assignee
    assignees.forEach((assignee, index) => {
        const initials = assignee.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);

        // Find user by name to get profile photo
        const assigneeUser = state.users.find(u => {
            const fullName = `${u.firstName || ''} ${u.lastName || ''}`.trim();
            return fullName === assignee || u.email?.split('@')[0] === assignee;
        });

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.title = assignee;

        if (assigneeUser?.profilePhotoUrl) {
            avatar.style.overflow = 'hidden';
            avatar.innerHTML = `<img src="${escapeHtml(sanitizeAttachmentUrl(assigneeUser.profilePhotoUrl))}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;">`;
        } else {
            avatar.textContent = initials;
        }

        if (index > 0) {
            avatar.style.marginLeft = '-8px';
        }

        assigneeDiv.appendChild(avatar);
    });

    const assigneeName = document.createElement('span');
    assigneeName.textContent = assignees.join(', ');
    assigneeDiv.appendChild(assigneeName);

    const deadlineDiv = document.createElement('div');
    deadlineDiv.className = 'deadline';

    const now = new Date();
    const deadlineDate = new Date(task.deadline);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const targetDate = new Date(task.deadline);
    targetDate.setHours(0, 0, 0, 0);

    const diffTime = targetDate - today;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    // Badges: can show "На проверке" + ("В срок" OR "Просрочено") together
    const tagsWrap = document.createElement('div');
    tagsWrap.className = 'deadline-tags';
    const addTag = (text, variantClass) => {
        const tag = document.createElement('span');
        tag.className = `deadline-tag ${variantClass || ''}`.trim();
        tag.textContent = text;
        tagsWrap.appendChild(tag);
    };

    let completionOnTime = null;
    if (currentSubStatus === 'completed') {
        addTag('На проверке', 'tag-review');
        completionOnTime = getTaskWasCompletedOnTime(task);
        if (completionOnTime === true) addTag('В срок', 'tag-ontime');
        else if (completionOnTime === false) addTag('Просрочено', 'tag-overdue');
    } else if (currentSubStatus !== 'done' && task.deadline) {
        // Только при реальном сроке: new Date(null) даёт 1970 год, и задача
        // БЕЗ срока (создание через агента разрешает deadline: null) ложно
        // помечалась «Просрочено».
        if (diffDays < 0) addTag('Просрочено', 'tag-overdue');
        else if (diffDays === 0) addTag('Сегодня', 'tag-today');
        else addTag(`${diffDays} дн.`, 'tag-days');
    }

    if (tagsWrap.childNodes.length > 0) {
        deadlineDiv.appendChild(tagsWrap);
    }

    const timeLeft = deadlineDate - now;
    if (task.status !== 'done' && task.deadline) {
        // For active tasks we keep the legacy coloring (deadline-red/green).
        // For "completed / on review" we DO NOT color by "now" (admin may check late) —
        // the tags already communicate "В срок/Просрочено".
        if (currentSubStatus !== 'completed') {
            if (timeLeft < 0) {
                deadlineDiv.classList.add('deadline-red');
            } else {
                deadlineDiv.classList.add('deadline-green');
            }
        }
    }

    const clockIcon = document.createElement('i');
    clockIcon.className = 'fa-regular fa-clock';

    const deadlineText = document.createElement('span');
    deadlineText.textContent = task.deadline ? formatDate(task.deadline) : 'Без срока';

    deadlineDiv.appendChild(clockIcon);
    deadlineDiv.appendChild(deadlineText);

    taskMeta.appendChild(assigneeDiv);
    taskMeta.appendChild(deadlineDiv);

    // === CREATE TOOLBAR ROW ===
    const toolbar = document.createElement('div');
    toolbar.className = 'task-toolbar';

    // Left side: Status badge
    const toolbarLeft = document.createElement('div');
    toolbarLeft.className = 'toolbar-left';
    toolbarLeft.appendChild(dropdownContainer);

    // Info button (right next to status badge)
    const infoBtn = document.createElement('button');
    infoBtn.className = 'info-task';
    infoBtn.title = 'Информация о задаче';
    const infoIcon = document.createElement('i');
    infoIcon.className = 'fa-solid fa-circle-info';
    infoBtn.appendChild(infoIcon);
    infoBtn.onclick = (e) => {
        e.stopPropagation();
        closeGlobalStatusMenu();
        playClickSound();
        openTaskDetailsModal(task);
    };
    toolbarLeft.appendChild(infoBtn);

    // Add attachment badge if task has files
    if (task.attachments && task.attachments.length > 0) {
        const attachBadge = document.createElement('span');
        attachBadge.className = 'task-attachment-badge';
        attachBadge.innerHTML = `<i class="fa-solid fa-paperclip"></i> ${task.attachments.length}`;
        attachBadge.title = 'Прикрепленные файлы';
        attachBadge.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            console.log('Attachment badge clicked!', task.attachments);
            playClickSound();
            openFilesListModal(task.attachments);
        };
        attachBadge.ontouchend = (e) => {
            e.stopPropagation();
            e.preventDefault();
            console.log('Attachment badge touched!', task.attachments);
            playClickSound();
            openFilesListModal(task.attachments);
        };
        toolbarLeft.appendChild(attachBadge);
    }

    // Right side: Edit & Delete buttons (owner/admin/moderator)
    const toolbarRight = document.createElement('div');
    toolbarRight.className = 'toolbar-right';

    if (isAssignee && task.status !== 'done' && task.deadline && !task.deadlineChangeRequest?.id) {
        const deadlineRequestBtn = document.createElement('button');
        deadlineRequestBtn.type = 'button';
        deadlineRequestBtn.className = 'deadline-request-task';
        deadlineRequestBtn.title = 'Запросить перенос срока';
        deadlineRequestBtn.setAttribute('aria-label', 'Запросить перенос срока');
        const deadlineRequestIcon = document.createElement('i');
        deadlineRequestIcon.className = 'fa-regular fa-calendar-plus';
        deadlineRequestBtn.appendChild(deadlineRequestIcon);
        deadlineRequestBtn.onclick = (event) => {
            event.stopPropagation();
            openDeadlineChangeModal(task);
        };
        toolbarRight.appendChild(deadlineRequestBtn);
    }

    if (canManageTasks()) {
        toolbarRight.appendChild(editBtn);
        toolbarRight.appendChild(deleteBtn);
    }

    toolbar.appendChild(toolbarLeft);
    toolbar.appendChild(toolbarRight);

    // === BUILD CARD STRUCTURE ===
    div.appendChild(toolbar);

    // Separator line
    const separator = document.createElement('div');
    separator.className = 'task-separator';
    div.appendChild(separator);

    // Task content
    div.appendChild(taskTitle);
    div.appendChild(taskMeta);

    // Add Description
    if (task.description) {
        const extrasDiv = document.createElement('div');
        extrasDiv.className = 'task-extras';
        extrasDiv.style.marginTop = '0.75rem';
        extrasDiv.style.borderTop = '1px solid var(--border)';
        extrasDiv.style.paddingTop = '0.5rem';

        const descBtn = document.createElement('button');
        descBtn.className = 'text-btn';
        descBtn.innerHTML = '<i class="fa-solid fa-align-left"></i> Показать описание';
        descBtn.style.fontSize = '0.8rem';
        descBtn.style.color = 'var(--text-secondary)';
        descBtn.style.background = 'none';
        descBtn.style.border = 'none';
        descBtn.style.cursor = 'pointer';
        descBtn.style.textAlign = 'left';
        descBtn.style.padding = '0';

        const descText = document.createElement('div');
        descText.className = 'task-description';
        descText.textContent = task.description;
        descText.style.display = 'none';
        descText.style.fontSize = '0.85rem';
        descText.style.color = 'var(--text-secondary)';
        descText.style.marginTop = '0.25rem';
        descText.style.whiteSpace = 'pre-wrap';

        descBtn.onclick = (e) => {
            e.stopPropagation();
            if (descText.style.display === 'none') {
                descText.style.display = 'block';
                descBtn.innerHTML = '<i class="fa-solid fa-chevron-up"></i> Скрыть описание';
            } else {
                descText.style.display = 'none';
                descBtn.innerHTML = '<i class="fa-solid fa-align-left"></i> Показать описание';
            }
        };

        extrasDiv.appendChild(descBtn);
        extrasDiv.appendChild(descText);
        div.appendChild(extrasDiv);
    }

    return div;
}

// Update SubStatus Function
function updateTaskSubStatus(taskId, newSubStatus, completionData = null, revisionData = null) {
    const updates = {
        subStatus: newSubStatus
    };

    // Get current user name
    const currentUserName = state.currentUser ?
        `${state.currentUser.firstName || ''} ${state.currentUser.lastName || ''}`.trim() || state.currentUser.email : '';

    if (newSubStatus === 'done') {
        updates.status = 'done';
        updates.subStatus = 'completed'; // Keep visual state but move to done list
        updates.archivedAt = new Date().toISOString();
        updates.archivedBy = currentUserName;
        updates.completedOnTime = false; // Will be set below
        updates.xpAwarded = true; // Mark that XP was awarded
    } else {
        updates.status = 'in-progress';
    }

    // Save timestamps for status changes
    if (newSubStatus === 'in_work') {
        updates.takenToWorkAt = new Date().toISOString();
        updates.takenToWorkBy = currentUserName;

        // Clear completion data when returning to work
        updates.completedAt = null;
        updates.completionComment = null;
        updates.completionProof = null;
        updates.completionProofs = null;
        updates.completedBy = null;
        updates.archivedAt = null;
        updates.archivedBy = null;

        // Add revision data if this is a return for revision
        if (revisionData) {
            updates.revisionReason = revisionData.reason;
            updates.revisionReturnedBy = revisionData.returnedBy;
            updates.revisionReturnedAt = revisionData.returnedAt;
            updates.wasReturned = true; // Mark that task was returned for revision (affects XP)
        }
    }

    // Sync legacy fields for backward compatibility if needed, 
    // but new UI relies on subStatus mostly.
    if (newSubStatus === 'completed') {
        updates.assigneeCompleted = true;
        // Server timestamp (not client Date) so the completion time can't be
        // backdated via a direct SDK write — the rules enforce
        // completedAt == request.time for the reader carve-out. All readers of
        // completedAt (formatDateTime, parseDateValue, on-time calc) already
        // handle Firestore Timestamps, so this is a transparent type change.
        updates.completedAt = firebase.firestore.FieldValue.serverTimestamp();

        const completedByName = state.currentUser ?
            `${state.currentUser.firstName || ''} ${state.currentUser.lastName || ''}`.trim() || state.currentUser.email : 'Исполнитель';

        // Add completion proof data if provided
        if (completionData) {
            updates.completionComment = completionData.comment;
            updates.completionProofs = completionData.proofs; // Array of files
            updates.completionProof = null; // Clear old single-file field for backward compatibility
            updates.completedBy = completedByName;
        }

        // Clear revision data when task is completed again
        updates.revisionReason = null;
        updates.revisionReturnedBy = null;
        updates.revisionReturnedAt = null;

        // Send notification to task creator about completion (async, don't wait)
        (async () => {
            try {
                const taskDoc = await db.collection('tasks').doc(taskId).get();
                if (taskDoc.exists) {
                    const taskData = taskDoc.data();
                    const project = state.projects.find(p => p.id === taskData.projectId);
                    const projectName = project?.name || 'Проект';
                    const message = `📤 <b>Задача на проверке</b>

<b>Проект:</b> ${escapeHtmlForTelegram(projectName)}
<b>Задача:</b> ${escapeHtmlForTelegram(taskData.title)}
<b>Исполнитель:</b> ${escapeHtmlForTelegram(completedByName)}

Пожалуйста, проверьте выполнение задачи.`;
                    const completionEvent = { type: 'task_completed', taskId, projectId: taskData.projectId || null };
                    // Все постановщики: создатель + доп. постановщики (дедуп по uid)
                    const creatorUids = [...new Set([
                        taskData.createdByUid,
                        ...(Array.isArray(taskData.coCreatorIds) ? taskData.coCreatorIds : [])
                    ].filter(Boolean))];
                    if (creatorUids.length > 0) {
                        // uid-путь: Telegram (если привязан) + push + email Google + лента
                        await Promise.all(creatorUids.map(uid => sendTaskEventToUid(uid, message, completionEvent)));
                    } else {
                        // Легаси-задача без createdByUid: старый путь по chatId
                        const chatId = resolveAssigneeChatId({ email: taskData.createdByEmail });
                        if (chatId) await sendTelegramNotification(chatId, message, completionEvent);
                    }
                }
            } catch (err) {
                console.error('Error sending completion notification:', err);
            }
        })();
    } else {
        updates.assigneeCompleted = false;
    }

    db.collection('tasks').doc(taskId).update(updates).then(async () => {
        playClickSound();
        console.log("Status updated to:", newSubStatus);

        // Award XP when the task is approved/archived. XP + per-user stats are
        // credited SERVER-SIDE (api/award-xp): the Admin SDK writes the now
        // rule-locked stats fields, the award is transactional + idempotent
        // (task.xpProcessed), and wasOnTime is computed on the server from the
        // task's server-set completedAt so it can't be forged. (Previously this
        // ran on the manager's client, which let any client self-credit XP.)
        if (newSubStatus === 'done') {
            try {
                const currentUser = firebase.auth().currentUser;
                const idToken = currentUser ? await currentUser.getIdToken() : null;
                if (idToken) {
                    const res = await fetch('/api/award-xp', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
                        body: JSON.stringify({ taskId })
                    });
                    if (!res.ok) {
                        const err = await res.json().catch(() => ({}));
                        console.error('award-xp failed:', res.status, err);
                    }
                }
            } catch (error) {
                console.error('Error awarding XP (server):', error);
            }

            // Уведомление исполнителям: задача принята в «Готово» (Telegram
            // при наличии + push + email Google + лента — сервер решает доставку по uid)
            try {
                const doneTask = findLoadedTask(taskId);
                if (doneTask && Array.isArray(doneTask.assigneeIds) && doneTask.assigneeIds.length > 0) {
                    const project = state.projects.find(p => p.id === doneTask.projectId);
                    const doneMessage = `✅ <b>Задача принята!</b>

<b>Проект:</b> ${escapeHtmlForTelegram(project?.name || 'Проект')}
<b>Задача:</b> ${escapeHtmlForTelegram(doneTask.title)}

Постановщик принял выполнение. Отличная работа!`;
                    const doneEvent = { type: 'task_done', taskId, projectId: doneTask.projectId || null };
                    doneTask.assigneeIds.forEach(uid => sendTaskEventToUid(uid, doneMessage, doneEvent));
                }
            } catch (error) {
                console.error('Error sending task-done notification:', error);
            }
        }
        await refreshMyTasksModalIfOpen();
    }).catch(error => {
        console.error("Error updating status:", error);
        alert("Ошибка: " + error.message);
    });
}

// ========== COMPLETION PROOF MODAL ==========
let completionProofAttachments = [];
const MAX_COMPLETION_FILES = 3;

function openCompletionProofModal(taskId) {
    const modal = document.getElementById('completion-proof-modal');
    document.getElementById('completion-task-id').value = taskId;
    document.getElementById('completion-comment').value = '';
    completionProofAttachments = [];
    renderCompletionAttachments();
    modal.classList.add('active');
}

function renderCompletionAttachments() {
    const list = document.getElementById('completion-attachments-list');
    const btn = document.getElementById('add-completion-file-btn');

    if (!list) return;
    list.innerHTML = '';

    completionProofAttachments.forEach((attachment, index) => {
        const item = document.createElement('div');
        item.className = 'attachment-item' + (attachment.uploading ? ' uploading' : '');

        const iconClass = getFileIcon(attachment.type || 'other');

        item.innerHTML = `
            <div class="attachment-icon ${attachment.type || 'other'}">
                <i class="fa-solid ${iconClass}"></i>
            </div>
            <div class="attachment-info">
                <div class="attachment-name">${escapeHtml(attachment.name)}</div>
                <div class="attachment-size">${attachment.uploading ? 'Загрузка...' : formatFileSize(attachment.size)}</div>
            </div>
            ${!attachment.uploading ? `
                <button type="button" class="attachment-remove" onclick="removeCompletionAttachment(${index})">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            ` : ''}
        `;

        list.appendChild(item);
    });

    // Show add button if less than max files and no files are uploading
    const isUploading = completionProofAttachments.some(a => a.uploading);
    if (completionProofAttachments.length < MAX_COMPLETION_FILES && !isUploading) {
        btn.style.display = 'flex';
    } else {
        btn.style.display = 'none';
    }
}

function removeCompletionAttachment(index) {
    completionProofAttachments.splice(index, 1);
    renderCompletionAttachments();
}

async function handleCompletionFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    event.target.value = '';

    if (completionProofAttachments.length >= MAX_COMPLETION_FILES) {
        alert(`Можно прикрепить максимум ${MAX_COMPLETION_FILES} файла`);
        return;
    }

    if (file.size > cloudinaryConfig.maxFileSize) {
        alert(`Файл слишком большой. Максимум ${formatFileSize(cloudinaryConfig.maxFileSize)}`);
        return;
    }

    const fileType = getFileType(file.name);
    const tempIndex = completionProofAttachments.length;

    completionProofAttachments.push({
        name: file.name,
        size: file.size,
        type: fileType,
        uploading: true
    });

    renderCompletionAttachments();

    try {
        const result = await uploadToCloudinary(file);

        completionProofAttachments[tempIndex] = {
            name: file.name,
            url: result.secure_url,
            type: fileType,
            size: file.size,
            publicId: result.public_id,
            uploadedAt: new Date().toISOString()
        };

        renderCompletionAttachments();
        playClickSound();
    } catch (error) {
        console.error('Upload error:', error);
        alert('Ошибка при загрузке файла: ' + error.message);
        completionProofAttachments.splice(tempIndex, 1);
        renderCompletionAttachments();
    }
}

function submitCompletionProof(e) {
    e.preventDefault();

    const taskId = document.getElementById('completion-task-id').value;
    const comment = document.getElementById('completion-comment').value.trim();

    if (!comment) {
        alert('Пожалуйста, добавьте комментарий о выполнении');
        return;
    }

    // Check that at least one file is uploaded and all files are done uploading
    const uploadedFiles = completionProofAttachments.filter(a => a.url && !a.uploading);
    const isUploading = completionProofAttachments.some(a => a.uploading);

    if (isUploading) {
        alert('Пожалуйста, дождитесь завершения загрузки файлов');
        return;
    }

    if (uploadedFiles.length === 0) {
        alert('Пожалуйста, прикрепите хотя бы один файл-подтверждение');
        return;
    }

    const completionData = {
        comment: comment,
        proofs: uploadedFiles
    };

    updateTaskSubStatus(taskId, 'completed', completionData);

    // Close modal
    document.getElementById('completion-proof-modal').classList.remove('active');
    completionProofAttachments = [];
}

// ========== REVISION REASON MODAL ==========
function openRevisionReasonModal(taskId) {
    const modal = document.getElementById('revision-reason-modal');
    document.getElementById('revision-task-id').value = taskId;
    document.getElementById('revision-reason').value = '';
    modal.classList.add('active');
}

function submitRevisionReason(e) {
    e.preventDefault();

    const taskId = document.getElementById('revision-task-id').value;
    const reason = document.getElementById('revision-reason').value.trim();

    if (!reason) {
        alert('Пожалуйста, укажите причину возврата');
        return;
    }

    const returnedBy = state.currentUser ?
        `${state.currentUser.firstName || ''} ${state.currentUser.lastName || ''}`.trim() || state.currentUser.email : 'Администратор';

    const revisionData = {
        reason: reason,
        returnedBy: returnedBy,
        returnedAt: new Date().toISOString()
    };

    // Уведомление исполнителям о возврате — по uid (Telegram при наличии +
    // push + email Google + лента); для легаси-задач без assigneeIds — старый путь по chatId.
    const task = findLoadedTask(taskId);
    if (task) {
        const revisionEvent = { type: 'task_revision', taskId, projectId: task.projectId || null };
        const revisionMessage = `🔄 <b>Задача возвращена на доработку</b>

<b>Задача:</b> ${escapeHtmlForTelegram(task.title)}

<b>Причина:</b>
${escapeHtmlForTelegram(reason)}

<b>Вернул:</b> ${escapeHtmlForTelegram(returnedBy)}`;
        if (Array.isArray(task.assigneeIds) && task.assigneeIds.length > 0) {
            task.assigneeIds.forEach(uid => sendTaskEventToUid(uid, revisionMessage, revisionEvent));
        } else {
            taskAssigneeChatIds(task).forEach(chatId => {
                sendTelegramRevisionNotification(chatId, task.title, reason, returnedBy);
            });
        }
    }

    updateTaskSubStatus(taskId, 'in_work', null, revisionData);

    // Close modal
    document.getElementById('revision-reason-modal').classList.remove('active');
}

// ========== TASK DETAILS MODAL ==========
function openTaskDetailsModal(task) {
    const modal = document.getElementById('task-details-modal');
    const content = document.getElementById('task-details-content');

    // Format dates (handles ISO strings, Firebase Timestamps, and Date objects)
    const formatDateTime = (dateValue) => {
        // Debug log
        console.log('formatDateTime input:', dateValue, typeof dateValue);

        if (!dateValue) return null;

        let date;

        try {
            // Handle Firebase Timestamp (has toDate method)
            if (dateValue.toDate && typeof dateValue.toDate === 'function') {
                date = dateValue.toDate();
            }
            // Handle Firebase Timestamp (has seconds property)
            else if (typeof dateValue === 'object' && dateValue.seconds !== undefined) {
                date = new Date(dateValue.seconds * 1000);
            }
            // Handle milliseconds timestamp (number)
            else if (typeof dateValue === 'number') {
                date = new Date(dateValue);
            }
            // Handle ISO string or Date object
            else if (typeof dateValue === 'string') {
                date = new Date(dateValue);
            }
            else if (dateValue instanceof Date) {
                date = dateValue;
            }
            // Unknown format - can't parse
            else {
                console.log('Unknown date format:', JSON.stringify(dateValue));
                return null;
            }

            // Check if date is valid
            if (!date || isNaN(date.getTime())) {
                console.log('Invalid date after parsing:', date);
                return null;
            }

            const result = date.toLocaleDateString('ru-RU', {
                day: 'numeric',
                month: 'long',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });

            // Extra check for "Invalid Date" string
            if (result.includes('Invalid')) {
                return null;
            }

            return result;
        } catch (e) {
            console.error('Error formatting date:', e, dateValue);
            return null;
        }
    };

    const createdAt = formatDateTime(task.createdAt);
    const takenToWorkAt = formatDateTime(task.takenToWorkAt);
    const completedAt = formatDateTime(task.completedAt);
    const archivedAt = formatDateTime(task.archivedAt);
    const deadline = task.deadline ? formatDate(task.deadline) : 'Не указан';

    // Build timeline HTML
    let timelineHTML = `
        <div class="timeline-item">
            <div class="timeline-icon created"><i class="fa-solid fa-plus"></i></div>
            <div class="timeline-content">
                <div class="timeline-label">Задача создана${task.createdBy ? ' <span class="timeline-user">| ' + escapeHtml(task.createdBy) + '</span>' : ''}</div>
                <div class="timeline-date">${createdAt || 'Дата не сохранена'}</div>
            </div>
        </div>
    `;

    if (takenToWorkAt) {
        timelineHTML += `
            <div class="timeline-item">
                <div class="timeline-icon in-work"><i class="fa-solid fa-person-digging"></i></div>
                <div class="timeline-content">
                    <div class="timeline-label">Взята в работу${task.takenToWorkBy ? ' <span class="timeline-user">| ' + escapeHtml(task.takenToWorkBy) + '</span>' : ''}</div>
                    <div class="timeline-date">${takenToWorkAt}</div>
                </div>
            </div>
        `;
    } else if (task.subStatus === 'assigned') {
        timelineHTML += `
            <div class="timeline-item pending">
                <div class="timeline-icon in-work"><i class="fa-solid fa-person-digging"></i></div>
                <div class="timeline-content">
                    <div class="timeline-label">Ожидает принятия в работу</div>
                    <div class="timeline-date">—</div>
                </div>
            </div>
        `;
    }

    if (completedAt) {
        timelineHTML += `
            <div class="timeline-item">
                <div class="timeline-icon completed"><i class="fa-solid fa-clock"></i></div>
                <div class="timeline-content">
                    <div class="timeline-label">Отправлена на проверку${task.completedBy ? ' <span class="timeline-user">| ' + escapeHtml(task.completedBy) + '</span>' : ''}</div>
                    <div class="timeline-date">${completedAt}</div>
                </div>
            </div>
        `;
    } else if (task.subStatus === 'in_work') {
        timelineHTML += `
            <div class="timeline-item pending">
                <div class="timeline-icon completed"><i class="fa-solid fa-clock"></i></div>
                <div class="timeline-content">
                    <div class="timeline-label">Ожидает завершения</div>
                    <div class="timeline-date">—</div>
                </div>
            </div>
        `;
    }

    if (archivedAt) {
        timelineHTML += `
            <div class="timeline-item">
                <div class="timeline-icon archived"><i class="fa-solid fa-check"></i></div>
                <div class="timeline-content">
                    <div class="timeline-label">В архиве${task.archivedBy ? ' <span class="timeline-user">| ' + escapeHtml(task.archivedBy) + '</span>' : ''}</div>
                    <div class="timeline-date">${archivedAt}</div>
                </div>
            </div>
        `;
    }

    // Completion proof section
    let proofHTML = '';
    // Support both old single-file format (completionProof) and new multi-file format (completionProofs)
    const completionProofs = task.completionProofs || (task.completionProof ? [task.completionProof] : []);

    if (task.completionComment || completionProofs.length > 0) {
        let filesHTML = '';
        completionProofs.forEach(proof => {
            if (proof && proof.url) {
                filesHTML += `
                    <div class="completion-proof-file" data-proof="${escapeHtml(JSON.stringify(proof))}">
                        <i class="fa-solid ${getFileIcon(proof.type || 'other')}"></i>
                        <div class="completion-proof-file-info">
                            <div class="completion-proof-file-name">${escapeHtml(proof.name)}</div>
                            <div class="completion-proof-file-size">${formatFileSize(proof.size || 0)}</div>
                        </div>
                        <i class="fa-solid fa-external-link" style="color: var(--text-secondary);"></i>
                    </div>
                `;
            }
        });

        proofHTML = `
            <div class="task-details-section">
                <h3><i class="fa-solid fa-clipboard-check"></i> Подтверждение выполнения</h3>
                <div class="completion-proof-box">
                    <div class="completion-proof-header">
                        <i class="fa-solid fa-user-check"></i> Отчёт исполнителя
                    </div>
                    ${task.completionComment ? `
                        <div class="completion-proof-comment">${escapeHtml(task.completionComment)}</div>
                    ` : ''}
                    ${filesHTML}
                </div>
            </div>
        `;
    } else if (task.subStatus === 'completed' || task.status === 'done') {
        proofHTML = `
            <div class="task-details-section">
                <h3><i class="fa-solid fa-clipboard-check"></i> Подтверждение выполнения</h3>
                <div class="no-proof-yet">
                    <i class="fa-solid fa-file-circle-question"></i>
                    <p>Подтверждение не было добавлено<br><small>(задача была завершена до введения этой функции)</small></p>
                </div>
            </div>
        `;
    }

    // Revision reason section (if task was returned for revision)
    let revisionHTML = '';
    if (task.revisionReason) {
        const revisionDate = task.revisionReturnedAt ? formatDateTime(task.revisionReturnedAt) : null;
        revisionHTML = `
            <div class="task-details-section">
                <h3><i class="fa-solid fa-rotate-left" style="color: #f59e0b;"></i> Возвращено на доработку</h3>
                <div class="revision-reason-box">
                    <div class="revision-reason-header">
                        <i class="fa-solid fa-comment-dots"></i> Комментарий постановщика
                    </div>
                    <div class="revision-reason-text">${escapeHtml(task.revisionReason)}</div>
                    <div class="revision-reason-meta">
                        <span><i class="fa-solid fa-user"></i> ${escapeHtml(task.revisionReturnedBy || 'Администратор')}</span>
                        ${revisionDate ? `<span><i class="fa-regular fa-clock"></i> ${revisionDate}</span>` : ''}
                    </div>
                </div>
            </div>
        `;
    }

    let deadlineRequestHTML = '';
    const deadlineRequest = task.deadlineChangeRequest;
    if (deadlineRequest?.id) {
        const isCreator = deadlineRequest.createdByUid === state.currentUser?.uid || isCurrentUserCoCreator(task);
        deadlineRequestHTML = `
            <div class="task-details-section">
                <h3><i class="fa-regular fa-calendar-plus"></i> Запрос переноса срока</h3>
                <div class="deadline-request-box">
                    <div><strong>${escapeHtml(deadlineRequest.requestedByName || 'Исполнитель')}</strong> просит изменить срок</div>
                    <div>Текущий: <strong>${escapeHtml(formatDate(deadlineRequest.currentDeadline) || '—')}</strong> → желаемый: <strong>${escapeHtml(formatDate(deadlineRequest.requestedDeadline) || '—')}</strong></div>
                    <div class="deadline-request-comment">${escapeHtml(deadlineRequest.comment || '')}</div>
                    ${isCreator ? `<div class="deadline-request-actions">
                        <button type="button" class="primary-btn" data-deadline-decision="approve" data-request-id="${escapeHtml(deadlineRequest.id)}">Подтвердить перенос</button>
                        <button type="button" class="secondary-btn" data-deadline-decision="reject" data-request-id="${escapeHtml(deadlineRequest.id)}">Оставить текущий срок</button>
                    </div>` : '<div style="color:var(--text-secondary);">Ожидает решения постановщика</div>'}
                </div>
            </div>`;
    }

    // Assignees
    const assignees = task.assignee ? task.assignee.split(',').map(n => n.trim()).filter(n => n) : [];
    const assigneesHTML = assignees.length > 0
        ? assignees.map(name => `<span style="background: rgba(99, 102, 241, 0.1); padding: 0.25rem 0.75rem; border-radius: 20px; font-size: 0.85rem;">${escapeHtml(name)}</span>`).join(' ')
        : '<span style="color: var(--text-secondary);">Не назначены</span>';

    // Текущий статус + кнопки жизненного цикла по ролям (как в iOS):
    // исполнитель — «Взять в работу»/«Завершить», постановщик (owner/admin/
    // moderator) — «Принять»/«На доработку». Та же логика, что и в меню
    // статуса на карточке Канбана.
    let currentSubStatus = task.subStatus || (task.assigneeCompleted ? 'completed' : 'assigned');
    if (task.status === 'done') currentSubStatus = 'done';
    const statusMeta = ({
        assigned: { label: 'Задача поставлена', icon: 'fa-circle-exclamation', cls: 'status-assigned' },
        in_work: { label: 'В работе', icon: 'fa-person-digging', cls: 'status-in-work' },
        completed: { label: 'На проверке', icon: 'fa-clock', cls: 'status-review' },
        done: { label: 'Готово (Архив)', icon: 'fa-check', cls: 'status-done' }
    })[currentSubStatus] || { label: 'Задача поставлена', icon: 'fa-circle-exclamation', cls: 'status-assigned' };

    const lifecycleButtons = [];
    if (currentSubStatus !== 'done') {
        if (isCurrentUserAssignee(task)) {
            if (currentSubStatus === 'assigned') {
                lifecycleButtons.push({ action: 'take', label: 'Взять в работу', icon: 'fa-play', primary: true });
            } else if (currentSubStatus === 'in_work') {
                lifecycleButtons.push({ action: 'complete', label: 'Завершить', icon: 'fa-clock', primary: true });
            }
        }
        if (canActAsTaskCreator(task) && currentSubStatus === 'completed') {
            lifecycleButtons.push({ action: 'accept', label: 'Принять', icon: 'fa-check', primary: true });
            lifecycleButtons.push({ action: 'revision', label: 'На доработку', icon: 'fa-rotate-left', primary: false });
        }
    }
    const statusHTML = `
        <div class="task-details-section">
            <h3><i class="fa-solid fa-flag"></i> Статус</h3>
            <div class="task-details-status-row">
                <div class="status-badge ${statusMeta.cls}" style="cursor: default;"><i class="fa-solid ${statusMeta.icon}"></i> <span>${statusMeta.label}</span></div>
                ${lifecycleButtons.map((btn) => `
                    <button type="button" class="${btn.primary ? 'primary-btn' : 'secondary-btn'} task-details-status-btn" data-lifecycle-action="${btn.action}">
                        <i class="fa-solid ${btn.icon}"></i> ${btn.label}
                    </button>`).join('')}
            </div>
        </div>
    `;

    content.innerHTML = `
        <div class="task-details-section">
            <div class="task-details-title">${escapeHtml(task.title)}</div>
            ${task.description ? `<div class="task-details-description">${escapeHtml(task.description)}</div>` : ''}
            <div style="display: flex; flex-wrap: wrap; gap: 1rem; margin-top: 1rem;">
                <div>
                    <span style="color: var(--text-secondary); font-size: 0.85rem;">Исполнители:</span><br>
                    ${assigneesHTML}
                </div>
                <div>
                    <span style="color: var(--text-secondary); font-size: 0.85rem;">Срок:</span><br>
                    <span><i class="fa-regular fa-calendar"></i> ${deadline}</span>
                </div>
                <div>
                    <span style="color: var(--text-secondary); font-size: 0.85rem;">Постановщики:</span><br>
                    ${[task.createdBy, ...(task.coCreators || '').split(',').map(n => n.trim()).filter(Boolean)]
                        .filter(Boolean)
                        .map(name => `<span style="background: rgba(34, 197, 94, 0.1); padding: 0.25rem 0.75rem; border-radius: 20px; font-size: 0.85rem;">${escapeHtml(name)}</span>`)
                        .join(' ') || '<span style="color: var(--text-secondary);">—</span>'}
                </div>
            </div>
        </div>

        ${statusHTML}

        <div class="task-details-section">
            <h3><i class="fa-solid fa-clock-rotate-left"></i> История задачи</h3>
            <div class="task-timeline">
                ${timelineHTML}
            </div>
        </div>

        ${deadlineRequestHTML}

        ${revisionHTML}

        ${proofHTML}
    `;

    // Кнопки жизненного цикла: закрываем модалку и запускаем тот же поток,
    // что и меню статуса на карточке (доказательства выполнения / причина
    // доработки открываются своими модалками).
    content.querySelectorAll('[data-lifecycle-action]').forEach((button) => {
        button.addEventListener('click', () => {
            const action = button.dataset.lifecycleAction;
            playClickSound();
            modal.classList.remove('active');
            if (action === 'take') {
                updateTaskSubStatus(task.id, 'in_work');
            } else if (action === 'complete') {
                openCompletionProofModal(task.id);
            } else if (action === 'accept') {
                updateTaskSubStatus(task.id, 'done');
            } else if (action === 'revision') {
                openRevisionReasonModal(task.id);
            }
        });
    });

    // Add click handler for proof files (supports multiple)
    const proofFileEls = content.querySelectorAll('.completion-proof-file');
    proofFileEls.forEach(proofFileEl => {
        proofFileEl.addEventListener('click', () => {
            try {
                const proofData = JSON.parse(proofFileEl.dataset.proof);
                openFilePreview(proofData);
            } catch (e) {
                console.error('Error parsing proof data:', e);
            }
        });
    });

    content.querySelectorAll('[data-deadline-decision]').forEach(button => {
        button.addEventListener('click', async () => {
            const decision = button.dataset.deadlineDecision;
            const requestId = button.dataset.requestId;
            setButtonLoading(button, true, 'Обрабатываем…');
            try {
                await callDeadlineChangeApi({ action: 'decide', requestId, decision });
                modal.classList.remove('active');
                await refreshMyTasksModalIfOpen();
            } catch (error) {
                setButtonLoading(button, false);
                alert(error.message || 'Не удалось обработать запрос');
            }
        });
    });

    modal.classList.add('active');
}

async function callDeadlineChangeApi(payload) {
    const currentUser = firebase.auth().currentUser;
    if (!currentUser) throw new Error('Требуется авторизация');
    const idToken = await currentUser.getIdToken();
    const response = await fetch('/api/notify-telegram?operation=deadline', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify(payload)
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw new Error(data.error || 'Ошибка сервера');
    return data;
}

function openDeadlineChangeModal(task) {
    if (!task?.id || !task.deadline) return;
    const modal = document.getElementById('deadline-change-modal');
    document.getElementById('deadline-change-task-id').value = task.id;
    document.getElementById('deadline-change-current').textContent = formatDate(task.deadline);
    const dateInput = document.getElementById('deadline-change-date');
    const next = new Date(`${String(task.deadline).slice(0, 10)}T12:00:00`);
    next.setDate(next.getDate() + 1);
    const minimum = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}-${String(next.getDate()).padStart(2, '0')}`;
    dateInput.min = minimum;
    dateInput.value = minimum;
    document.getElementById('deadline-change-comment').value = '';
    modal.classList.add('active');
}

// Helper function to escape HTML (safe for both text-node content and quoted
// HTML attribute values, e.g. href="${escapeHtml(...)}")
function escapeHtml(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function formatDate(dateString) {
    const value = String(dateString || '').slice(0, 10);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (match) return `${match[3]}.${match[2]}.${match[1]}`;
    const date = new Date(dateString);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatIsoDatesInText(text) {
    return String(text || '').replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, '$3.$2.$1');
}

// Parse various date formats (ISO string, Date, Firestore Timestamp) into a Date object
function parseDateValue(dateValue) {
    if (!dateValue) return null;
    try {
        // Firestore Timestamp (has toDate)
        if (dateValue.toDate && typeof dateValue.toDate === 'function') {
            const d = dateValue.toDate();
            return d && !isNaN(d.getTime()) ? d : null;
        }
        // Firestore Timestamp-like object with seconds
        if (typeof dateValue === 'object' && dateValue.seconds !== undefined) {
            const d = new Date(dateValue.seconds * 1000);
            return !isNaN(d.getTime()) ? d : null;
        }
        // Number (ms)
        if (typeof dateValue === 'number') {
            const d = new Date(dateValue);
            return !isNaN(d.getTime()) ? d : null;
        }
        // ISO string
        if (typeof dateValue === 'string') {
            const d = new Date(dateValue);
            return !isNaN(d.getTime()) ? d : null;
        }
        // Date
        if (dateValue instanceof Date) {
            return !isNaN(dateValue.getTime()) ? dateValue : null;
        }
    } catch (e) {
        console.error('parseDateValue error:', e, dateValue);
    }
    return null;
}

function getDeadlineEndOfDay(deadlineValue) {
    if (!deadlineValue) return null;
    const d = new Date(deadlineValue);
    if (isNaN(d.getTime())) return null;
    d.setHours(23, 59, 59, 999);
    return d;
}

function getTaskWasCompletedOnTime(task) {
    const deadlineEnd = getDeadlineEndOfDay(task?.deadline);
    const completedDate = parseDateValue(task?.completedAt);
    if (!deadlineEnd || !completedDate) return null; // unknown
    return completedDate <= deadlineEnd;
}

function formatDateTimeRu(dateValue) {
    const d = parseDateValue(dateValue);
    if (!d) return null;
    try {
        return d.toLocaleString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
    } catch (e) {
        return d.toISOString();
    }
}

// ========== USER PRESENCE / LAST SEEN ==========
let presenceIntervalId = null;
const PRESENCE_HEARTBEAT_MS = 30 * 1000;
const ONLINE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes

async function updateMyPresence() {
    if (!db || !state.currentUser?.uid) return;
    // Avoid unnecessary writes when tab is not visible
    if (document.visibilityState && document.visibilityState !== 'visible') return;
    try {
        await db.collection('users').doc(state.currentUser.uid).set({
            lastSeenAt: firebase.firestore.FieldValue.serverTimestamp(),
            lastSeenClientAt: new Date().toISOString()
        }, { merge: true });
    } catch (e) {
        console.warn('updateMyPresence failed:', e?.message || e);
    }
}

// Named so stopPresenceHeartbeat can remove them — anonymous listeners couldn't
// be removed, so each start/stop/start cycle used to pile up duplicate handlers.
function onPresenceVisibilityChange() {
    if (document.visibilityState === 'visible') updateMyPresence();
}

function startPresenceHeartbeat() {
    if (presenceIntervalId) return; // already running — don't double-add
    // Do an immediate update, then keep alive
    updateMyPresence();
    presenceIntervalId = setInterval(updateMyPresence, PRESENCE_HEARTBEAT_MS);
    document.addEventListener('visibilitychange', onPresenceVisibilityChange);
    window.addEventListener('focus', updateMyPresence);
}

function stopPresenceHeartbeat() {
    if (presenceIntervalId) {
        clearInterval(presenceIntervalId);
        presenceIntervalId = null;
    }
    document.removeEventListener('visibilitychange', onPresenceVisibilityChange);
    window.removeEventListener('focus', updateMyPresence);
}

// Drag and Drop - DISABLED
let draggedTaskId = null;

function handleDragStart(e) {
    // Disabled
    e.preventDefault();
}

function setupDragAndDrop() {
    // Disabled - Empty function to prevent errors if called
}

// Theme
function loadTheme() {
    const theme = localStorage.getItem('theme');
    const isLight = theme === 'light';
    if (isLight) {
        document.body.classList.add('light-mode');
    }
    // Delay UI update to ensure DOM is ready
    setTimeout(() => updateThemeUI(isLight), 100);
}

function toggleTheme() {
    const isLight = document.body.classList.toggle('light-mode');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    updateThemeUI(isLight);
}

function setTheme(isLight) {
    if (isLight) {
        document.body.classList.add('light-mode');
    } else {
        document.body.classList.remove('light-mode');
    }
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    updateThemeUI(isLight);
}

// Close sidebar on mobile devices
function closeSidebarOnMobile() {
    if (window.innerWidth <= 768) {
        elements.sidebar.classList.remove('active');
        if (elements.sidebarOverlay) {
            elements.sidebarOverlay.classList.remove('active');
        }
    }
}

function setBoardView(view) {
    const allowed = new Set(['assigned', 'in-progress', 'review']);
    const next = allowed.has(view) ? view : 'assigned';
    state.boardView = next;

    // Update category button label (mobile)
    if (elements.categoryBtnText) {
        const labelMap = {
            'assigned': 'Назначенные',
            'in-progress': 'В работе',
            'review': 'На проверке'
        };
        elements.categoryBtnText.textContent = labelMap[next] || 'Назначенные';
    }

    // Desktop shows the complete three-column workflow. On mobile the compact
    // selector keeps a single column visible so cards remain readable.
    const isMobile = window.innerWidth <= 768;
    document.querySelectorAll('.kanban-columns .column').forEach(col => {
        col.classList.toggle('active', !isMobile || col.dataset.view === next);
    });

    // Keyboard navigation column sync (if enabled)
    if (keyboardNav?.mode === 'tasks') {
        keyboardNav.taskColumn = next;
        keyboardNav.focusIndex = -1;
        clearKeyboardFocus();
    }
}

// Board selector now opens modal on mobile

// ===== Project view: kanban <-> gantt <-> calendar =====
function setProjectView(view) {
    const next = ['gantt', 'calendar'].includes(view) ? view : 'kanban';
    if (state.projectView === next) return;
    state.projectView = next;
    if (next === 'gantt') state.ganttMonth = null; // always start from the year
    if (next === 'calendar') calendarState.currentDate = new Date(); // open on the current month
    renderProjects(); // refresh switcher active state under the project
    renderBoard();    // toggles containers; renders gantt/calendar if needed
}

// ===== Gantt chart =====
const GANTT_DAY_MS = 24 * 60 * 60 * 1000;
const GANTT_MONTH_NAMES = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
    'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
let ganttUiWired = false;
let ganttLastScrollKey = null; // "projectId:year" of the last render — keeps
// scroll position across live task-snapshot re-renders
let ganttEnterAnim = null; // enter-animation class for the NEXT renderGantt (zoom transitions)

// Year <-> month drill-down with a zoom transition: the current table zooms
// toward the clicked month (or shrinks back) and fades, then the re-rendered
// view animates in from the opposite scale. nextMonth null = back to the year.
function ganttSwitchPeriod(nextMonth, originX) {
    const zoomingIn = nextMonth !== null;
    ganttEnterAnim = zoomingIn ? 'gantt-enter-in' : 'gantt-enter-out';
    const apply = () => {
        state.ganttMonth = nextMonth;
        renderGantt();
    };
    const table = elements.ganttScroll ? elements.ganttScroll.querySelector('.gantt-table') : null;
    if (!table) {
        apply();
        return;
    }
    const scrollEl = elements.ganttScroll;
    const defaultOrigin = scrollEl.scrollLeft + scrollEl.clientWidth / 2;
    table.style.transformOrigin = `${originX != null ? originX : defaultOrigin}px center`;
    table.classList.add(zoomingIn ? 'gantt-leave-in' : 'gantt-leave-out');
    setTimeout(apply, 170); // matches the .17s leave transition in style.css
}

// task.deadline is a YYYY-MM-DD string from <input type=date>; parse it in the
// LOCAL timezone (new Date('YYYY-MM-DD') gives UTC midnight and can shift the
// bar a day for western timezones). Other shapes go through getFirestoreDateMs.
function parseDateOnlyMs(value) {
    if (!value) return 0;
    if (typeof value === 'string') {
        const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
    }
    return getFirestoreDateMs(value);
}

function wireGanttControls() {
    if (ganttUiWired) return;
    ganttUiWired = true;

    if (elements.ganttYearSelect) {
        elements.ganttYearSelect.addEventListener('change', () => {
            playClickSound();
            const y = parseInt(elements.ganttYearSelect.value, 10);
            if (!Number.isNaN(y)) {
                state.ganttYear = y;
                renderGantt();
            }
        });
    }
    if (elements.ganttPrevYear) {
        elements.ganttPrevYear.addEventListener('click', () => {
            playClickSound();
            state.ganttYear = (state.ganttYear || new Date().getFullYear()) - 1;
            renderGantt();
        });
    }
    if (elements.ganttNextYear) {
        elements.ganttNextYear.addEventListener('click', () => {
            playClickSound();
            state.ganttYear = (state.ganttYear || new Date().getFullYear()) + 1;
            renderGantt();
        });
    }
    if (elements.ganttBackYear) {
        elements.ganttBackYear.addEventListener('click', () => {
            playClickSound();
            ganttSwitchPeriod(null);
        });
    }
    // Column widths derive from the window width — re-render on resize
    let ganttResizeTimer = null;
    window.addEventListener('resize', () => {
        if (!elements.ganttContainer?.classList.contains('active')) return;
        clearTimeout(ganttResizeTimer);
        ganttResizeTimer = setTimeout(renderGantt, 150);
    });
    if (elements.ganttScroll) {
        // One delegated handler: a month header cell drills into that month,
        // a row label or its bar opens the task
        elements.ganttScroll.addEventListener('click', (e) => {
            const monthCell = e.target.closest('.gantt-month[data-month]');
            if (monthCell) {
                playClickSound();
                // offsetLeft is relative to .gantt-table (position: relative),
                // so the zoom originates from the clicked month column
                ganttSwitchPeriod(
                    parseInt(monthCell.dataset.month, 10),
                    monthCell.offsetLeft + monthCell.offsetWidth / 2
                );
                return;
            }
            const row = e.target.closest('[data-gantt-task]');
            if (!row) return;
            const task = state.tasks.find(t => t.id === row.dataset.ganttTask);
            if (task) {
                playClickSound();
                openTaskDetailsModal(task);
            }
        });
    }
}

function renderGantt() {
    if (!elements.ganttContainer || !elements.ganttScroll) return;
    wireGanttControls();

    const scrollEl = elements.ganttScroll;

    // --- collect chart items: bar = createdAt .. deadline ---
    const projectTasks = state.tasks.filter(t => t.projectId === state.activeProjectId);
    const items = [];
    let noDeadlineCount = 0;
    projectTasks.forEach(task => {
        const endMs = parseDateOnlyMs(task.deadline);
        if (!endMs) {
            noDeadlineCount++; // tasks without a deadline are not charted
            return;
        }
        let startMs = getFirestoreDateMs(task.createdAt) || getFirestoreDateMs(task.assignedAt) || endMs;
        const s = new Date(startMs);
        startMs = new Date(s.getFullYear(), s.getMonth(), s.getDate()).getTime(); // local midnight
        if (startMs > endMs) startMs = endMs; // created after its own deadline
        items.push({ task, startMs, endMs });
    });

    // --- year selector: years covered by tasks + current + selected ---
    const currentYear = new Date().getFullYear();
    if (!state.ganttYear) state.ganttYear = currentYear;
    const year = state.ganttYear;
    const yearsSet = new Set([currentYear, year]);
    items.forEach(it => {
        yearsSet.add(new Date(it.startMs).getFullYear());
        yearsSet.add(new Date(it.endMs).getFullYear());
    });
    if (elements.ganttYearSelect) {
        elements.ganttYearSelect.textContent = '';
        [...yearsSet].sort((a, b) => a - b).forEach(y => {
            const opt = document.createElement('option');
            opt.value = String(y);
            opt.textContent = String(y);
            if (y === year) opt.selected = true;
            elements.ganttYearSelect.appendChild(opt);
        });
    }
    // Drill-down state: whole year by default; a month opens by clicking its
    // name in the chart header, the «Весь год» button goes back
    const monthMode = Number.isInteger(state.ganttMonth);
    if (elements.ganttBackYear) {
        elements.ganttBackYear.style.display = monthMode ? 'inline-flex' : 'none';
    }
    if (elements.ganttPeriodLabel) {
        elements.ganttPeriodLabel.style.display = monthMode ? 'inline' : 'none';
        if (monthMode) elements.ganttPeriodLabel.textContent = GANTT_MONTH_NAMES[state.ganttMonth];
    }
    if (elements.ganttNoDeadlineNote) {
        elements.ganttNoDeadlineNote.textContent = noDeadlineCount
            ? `Без срока: ${noDeadlineCount} — не на диаграмме`
            : '';
    }

    // --- visible range: the whole year (month columns) or one month (day columns) ---
    const rangeStart = monthMode
        ? new Date(year, state.ganttMonth, 1).getTime()
        : new Date(year, 0, 1).getTime();
    const rangeEnd = monthMode
        ? new Date(year, state.ganttMonth + 1, 1).getTime()
        : new Date(year + 1, 0, 1).getTime(); // exclusive

    const visible = items
        .filter(it => it.endMs >= rangeStart && it.startMs < rangeEnd)
        .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

    // --- fit-to-window geometry: the timeline fills the available width ---
    const labelW = parseInt(getComputedStyle(elements.ganttContainer).getPropertyValue('--gantt-label-w'), 10) || 220;
    const availW = Math.max(scrollEl.clientWidth - labelW - 1, 0);
    const daysInRange = Math.round((rangeEnd - rangeStart) / GANTT_DAY_MS);
    // Min column widths keep tiny screens readable (horizontal scroll kicks in)
    const colW = monthMode
        ? Math.max(availW / daysInRange, 18)
        : Math.max(availW / 12, 45);
    const totalW = monthMode ? colW * daysInRange : colW * 12;

    const now = new Date();
    const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const todayInRange = todayMidnight >= rangeStart && todayMidnight < rangeEnd;

    // px offset of a moment inside the visible range.
    // Month mode: linear over the month's days. Year mode: 12 EQUAL month
    // columns, position = month index + day fraction within that month
    // (calendar-true column edges; days map fractionally inside each month).
    const daysInMonthOf = (y, m) => new Date(y, m + 1, 0).getDate();
    const posX = (ms, dayEdge) => { // dayEdge: 0 = start of the day, 1 = end of the day
        if (ms <= rangeStart) return 0;
        if (ms >= rangeEnd) return totalW;
        const d = new Date(ms);
        if (monthMode) {
            const dayIdx = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - rangeStart) / GANTT_DAY_MS);
            return (dayIdx + dayEdge) * colW;
        }
        const frac = (d.getDate() - 1 + dayEdge) / daysInMonthOf(d.getFullYear(), d.getMonth());
        return (d.getMonth() + frac) * colW;
    };

    const prevTop = scrollEl.scrollTop;
    const prevLeft = scrollEl.scrollLeft;

    const table = document.createElement('div');
    table.className = 'gantt-table' + (monthMode ? '' : ' year-mode');
    table.style.setProperty('--gantt-day', colW + 'px');
    if (monthMode) {
        // Weekend band phase: first Saturday relative to the month's 1st day
        // (-1 when the 1st is a Sunday — the band starts a day "before")
        const firstDow = new Date(year, state.ganttMonth, 1).getDay(); // 0=Sun..6=Sat
        let weekendOffsetDays = (6 - firstDow + 7) % 7;
        if (weekendOffsetDays === 6) weekendOffsetDays = -1;
        table.style.setProperty('--gantt-weekend-offset', (weekendOffsetDays * colW) + 'px');
    }

    // --- header: month columns (year mode) or day columns (month mode) ---
    const head = document.createElement('div');
    head.className = 'gantt-head';
    const headLeft = document.createElement('div');
    headLeft.className = 'gantt-head-left';
    headLeft.textContent = `Задачи (${visible.length})`;
    head.appendChild(headLeft);

    const headRight = document.createElement('div');
    headRight.className = 'gantt-head-right';
    headRight.style.width = totalW + 'px';
    const unitsRow = document.createElement('div');
    unitsRow.className = monthMode ? 'gantt-days-row' : 'gantt-months-row';
    if (monthMode) {
        for (let d = 1; d <= daysInRange; d++) {
            const dow = new Date(year, state.ganttMonth, d).getDay();
            const isToday = todayInRange && now.getDate() === d;
            const dCell = document.createElement('span');
            dCell.className = 'gantt-day'
                + (dow === 0 || dow === 6 ? ' weekend' : '')
                + (isToday ? ' today' : '');
            dCell.style.width = colW + 'px';
            dCell.textContent = String(d);
            unitsRow.appendChild(dCell);
        }
    } else {
        for (let m = 0; m < 12; m++) {
            const mCell = document.createElement('div');
            mCell.className = 'gantt-month'
                + (year === now.getFullYear() && m === now.getMonth() ? ' today' : '');
            mCell.dataset.month = String(m); // clickable: drills into this month
            mCell.title = `Открыть ${GANTT_MONTH_NAMES[m].toLowerCase()} по дням`;
            mCell.style.width = colW + 'px';
            mCell.textContent = colW < 70 ? GANTT_MONTH_NAMES[m].slice(0, 3) : GANTT_MONTH_NAMES[m];
            unitsRow.appendChild(mCell);
        }
    }
    headRight.appendChild(unitsRow);
    head.appendChild(headRight);
    table.appendChild(head);

    // --- body: a row per task, bar colored by the task's status ---
    const body = document.createElement('div');
    body.className = 'gantt-body';
    const fmtDay = ms => new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
    const fmtFull = ms => new Date(ms).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    const statusLabels = { assigned: 'Назначена', 'in-progress': 'В работе', review: 'На проверке', done: 'Готово' };

    const makeTrack = () => {
        const track = document.createElement('div');
        track.className = 'gantt-row-track';
        track.style.width = totalW + 'px';
        return track;
    };

    visible.forEach(({ task, startMs, endMs }) => {
        const row = document.createElement('div');
        row.className = 'gantt-row';
        row.dataset.ganttTask = task.id;

        const label = document.createElement('div');
        label.className = 'gantt-row-label';
        const titleEl = document.createElement('div');
        titleEl.className = 'gantt-row-title';
        titleEl.textContent = task.title || 'Без названия';
        const metaEl = document.createElement('div');
        metaEl.className = 'gantt-row-meta';
        metaEl.textContent = `${fmtDay(startMs)} – ${fmtDay(endMs)}`
            + (task.assignee && task.assignee !== 'Не назначен' ? ` • ${task.assignee}` : '');
        label.appendChild(titleEl);
        label.appendChild(metaEl);
        row.appendChild(label);

        const track = makeTrack();

        const left = posX(startMs, 0);
        const right = Math.max(posX(endMs, 1), left + 6); // deadline day inclusive, ≥6px

        // Same status->color mapping as the kanban tabs (boardViewForTask)
        const status = boardViewForTask(task);
        const isOverdue = task.status !== 'done' && endMs + GANTT_DAY_MS <= Date.now();

        const bar = document.createElement('div');
        bar.className = `gantt-bar status-${status}`
            + (isOverdue ? ' overdue' : '')
            + (startMs < rangeStart ? ' clip-left' : '')
            + (endMs + GANTT_DAY_MS > rangeEnd ? ' clip-right' : '');
        bar.style.left = left + 'px';
        bar.style.width = (right - left) + 'px';
        bar.title = `${task.title || 'Без названия'}\n${statusLabels[status] || status}`
            + `${isOverdue ? ' • просрочена' : ''}\n${fmtFull(startMs)} – ${fmtFull(endMs)}`;
        if (right - left >= 88) {
            bar.textContent = `${fmtDay(startMs)} – ${fmtDay(endMs)}`;
        }
        track.appendChild(bar);
        row.appendChild(track);
        body.appendChild(row);
    });

    // No tasks in this range: say so in the first row (the grid still renders)
    if (!visible.length) {
        const row = document.createElement('div');
        row.className = 'gantt-row gantt-row-filler';
        const label = document.createElement('div');
        label.className = 'gantt-row-label gantt-row-note';
        label.textContent = items.length
            ? 'Нет задач со сроками в этом периоде'
            : 'В проекте нет задач со сроками';
        row.appendChild(label);
        row.appendChild(makeTrack());
        body.appendChild(row);
    }

    // "Today" line spans the whole body (offset after the sticky label column)
    if (todayInRange) {
        const line = document.createElement('div');
        line.className = 'gantt-today-line';
        line.style.left = `calc(var(--gantt-label-w) + ${posX(todayMidnight, 0.5)}px)`;
        line.title = 'Сегодня';
        body.appendChild(line);
    }
    table.appendChild(body);

    scrollEl.textContent = '';
    scrollEl.appendChild(table);

    // Zoom-transition entrance (set by ganttSwitchPeriod)
    if (ganttEnterAnim) {
        table.classList.add(ganttEnterAnim);
        table.addEventListener('animationend', () => {
            table.classList.remove('gantt-enter-in', 'gantt-enter-out');
        }, { once: true });
        ganttEnterAnim = null;
    }

    // --- filler rows: the grid covers the whole canvas, dashes instead of tasks ---
    const usedH = table.offsetHeight;
    const freeH = scrollEl.clientHeight - usedH;
    if (freeH > 4) {
        const sampleRow = body.querySelector('.gantt-row');
        const rowH = Math.max(sampleRow ? sampleRow.offsetHeight : 46, 24);
        const fillerCount = Math.ceil(freeH / rowH);
        for (let i = 0; i < fillerCount; i++) {
            const row = document.createElement('div');
            row.className = 'gantt-row gantt-row-filler';
            row.style.height = rowH + 'px';
            const label = document.createElement('div');
            label.className = 'gantt-row-label';
            label.textContent = '—';
            row.appendChild(label);
            row.appendChild(makeTrack());
            body.appendChild(row);
        }
    }

    // Keep scroll across live re-renders of the same view; on first open,
    // bring "today" into view when the timeline overflows (narrow screens)
    const key = `${state.activeProjectId}:${year}:${monthMode ? state.ganttMonth : 'y'}`;
    if (ganttLastScrollKey === key) {
        scrollEl.scrollTop = prevTop;
        scrollEl.scrollLeft = prevLeft;
    } else {
        ganttLastScrollKey = key;
        scrollEl.scrollTop = 0;
        scrollEl.scrollLeft = (todayInRange && totalW > availW)
            ? Math.max(0, posX(todayMidnight, 0.5) - availW / 3)
            : 0;
    }
}

function updateThemeUI(isLight) {
    // Update theme icon in settings
    const themeIcon = document.querySelector('.settings-option-icon.theme i');
    const themeText = document.getElementById('current-theme-text');
    const themeCheckbox = document.getElementById('theme-checkbox');

    if (themeIcon) {
        themeIcon.className = isLight ? 'fa-regular fa-moon' : 'fa-regular fa-sun';
    }
    if (themeText) {
        themeText.textContent = isLight ? 'Светлая тема' : 'Тёмная тема';
    }
    if (themeCheckbox) {
        themeCheckbox.checked = isLight;
    }
}

// Shared modal-close helper. All three ways a modal can be dismissed
// (.close-modal button, clicking the dimmed backdrop, pressing Escape — see
// setupEventListeners() and handleKeyboardNavigation() below) route through
// here so any modal-specific close side effects stay in one place. Right now
// the only such side effect is the agent-chat generation-counter bump: see
// agentChatState.generation for what that guards against.
function closeModalElement(modal) {
    if (!modal) return;
    modal.classList.remove('active');
    if (elements.agentChatModal && modal === elements.agentChatModal) {
        agentChatState.generation += 1;
        clearAgentChatFileSelection();
    }
    if (calElements.dayTasksModal && modal === calElements.dayTasksModal) {
        calendarState.openDayDate = null;
    }
    if (elements.taskArchiveModal && modal === elements.taskArchiveModal) {
        pendingArchiveTaskId = null;
    }
}

// Event Listeners
function setupEventListeners() {
    // Organization event listeners
    setupOrgEventListeners();

    // Name-setup (post-registration) screen
    const nameSetupForm = document.getElementById('name-setup-form');
    if (nameSetupForm) nameSetupForm.addEventListener('submit', handleNameSetupSubmit);
    const nameSetupLogout = document.getElementById('name-setup-logout');
    if (nameSetupLogout) nameSetupLogout.addEventListener('click', () => {
        const overlay = document.getElementById('name-setup-overlay');
        if (overlay) overlay.style.display = 'none';
        logout();
    });

    // Telegram login button -> reliable bot deep-link flow (opens the bot,
    // user taps Start, site finishes login by polling). Replaces the fragile
    // oauth.telegram.org phone-confirmation flow.
    const telegramLoginBtn = document.getElementById('telegram-login-btn');
    if (telegramLoginBtn) {
        telegramLoginBtn.addEventListener('click', () => {
            playClickSound();
            window.startTelegramBotLogin();
        });
    }
    document.getElementById('google-login-btn')?.addEventListener('click', () => startFederatedLogin('google.com'));
    document.getElementById('apple-login-btn')?.addEventListener('click', () => startFederatedLogin('apple.com'));
    document.getElementById('email-auth-form')?.addEventListener('submit', handleEmailAuthSubmit);
    document.getElementById('auth-mode-toggle')?.addEventListener('click', () => {
        setEmailAuthMode(emailAuthMode === 'login' ? 'register' : 'login');
    });
    document.getElementById('auth-password-reset')?.addEventListener('click', async () => {
        const emailInput = document.getElementById('auth-email');
        const email = emailInput?.value.trim().toLowerCase() || '';
        if (!emailInput?.checkValidity()) {
            setLoginErrorMessage('Введите почту, для которой нужно восстановить пароль.');
            emailInput?.focus();
            return;
        }
        const button = document.getElementById('auth-password-reset');
        setButtonLoading(button, true, 'Отправляем…');
        try {
            await auth.sendPasswordResetEmail(email);
            setLoginErrorMessage('Письмо для восстановления пароля отправлено.', 'success');
        } catch (error) {
            setLoginErrorMessage(emailAuthErrorMessage(error));
        } finally {
            setButtonLoading(button, false);
        }
    });
    document.getElementById('email-verification-check')?.addEventListener('click', () => checkEmailVerification());
    document.getElementById('email-verification-resend')?.addEventListener('click', resendEmailVerification);
    document.getElementById('email-verification-logout')?.addEventListener('click', async () => {
        await auth?.signOut().catch(() => {});
        emailAuthMode = 'login';
        showEmailAuthContent();
    });
    window.addEventListener('focus', () => {
        const user = auth?.currentUser;
        if (user && isPasswordAuthUser(user) && !user.emailVerified) {
            checkEmailVerification({ silent: true });
        }
    });
    if (elements.telegramBotLoginBtn) {
        elements.telegramBotLoginBtn.addEventListener('click', () => {
            playClickSound();
            window.startTelegramBotLogin();
        });
    }

    const deadlineChangeForm = document.getElementById('deadline-change-form');
    if (deadlineChangeForm) {
        deadlineChangeForm.addEventListener('submit', async (event) => {
            event.preventDefault();
            const taskId = document.getElementById('deadline-change-task-id')?.value || '';
            const requestedDeadline = document.getElementById('deadline-change-date')?.value || '';
            const comment = document.getElementById('deadline-change-comment')?.value.trim() || '';
            if (!taskId || !requestedDeadline || !comment) return;
            const submit = document.getElementById('deadline-change-submit');
            setButtonLoading(submit, true, 'Отправляем…');
            try {
                await callDeadlineChangeApi({ action: 'request', taskId, requestedDeadline, comment });
                closeModalElement(document.getElementById('deadline-change-modal'));
                await refreshMyTasksModalIfOpen();
            } catch (error) {
                alert(error.message || 'Не удалось отправить запрос');
            } finally {
                setButtonLoading(submit, false);
            }
        });
    }

    // Modals
    if (elements.addProjectBtn && elements.projectForm && elements.projectModal) {
        elements.addProjectBtn.addEventListener('click', () => {
            playClickSound();
            closeSidebarOnMobile();
            elements.projectForm.reset();
            const projectIdInput = document.getElementById('p-id');
            const deadlineGroup = document.getElementById('p-deadline-group');
            if (projectIdInput) projectIdInput.value = ''; // Clear ID for new project
            if (deadlineGroup) deadlineGroup.classList.remove('active');
            setProjectModalMode('create');
            elements.projectModal.classList.add('active');
        });
    }

    if (elements.addTaskBtn && elements.taskForm && elements.taskModal) {
        elements.addTaskBtn.addEventListener('click', () => {
            playClickSound();
            elements.taskForm.reset();
            const taskIdInput = document.getElementById('t-id');
            const taskDeadlineInput = document.getElementById('t-deadline');
            const taskTitle = elements.taskModal.querySelector('h2');
            if (taskIdInput) taskIdInput.value = ''; // Clear ID for new task
            if (taskTitle) taskTitle.textContent = 'Новая задача'; // Reset title
            // Set default date to today
            if (taskDeadlineInput) taskDeadlineInput.valueAsDate = new Date();
            populateAssigneeDropdown();
            populateCoCreatorDropdown();

            // Reset attachments
            pendingAttachments = [];
            renderAttachmentsList();
            updateAddAttachmentBtn();

            elements.taskModal.classList.add('active');
        });
    }

    // File attachment handlers
    const fileInput = document.getElementById('file-input');
    const addAttachmentBtn = document.getElementById('add-attachment-btn');

    if (fileInput) {
        fileInput.addEventListener('change', handleFileSelect);
    }

    if (addAttachmentBtn && fileInput) {
        addAttachmentBtn.addEventListener('click', () => {
            playClickSound();
            fileInput.click();
        });
    }

    // Completion proof file handlers
    const completionFileInput = document.getElementById('completion-file-input');
    const addCompletionFileBtn = document.getElementById('add-completion-file-btn');
    const completionProofForm = document.getElementById('completion-proof-form');

    if (completionFileInput) {
        completionFileInput.addEventListener('change', handleCompletionFileSelect);
    }

    if (addCompletionFileBtn && completionFileInput) {
        addCompletionFileBtn.addEventListener('click', () => {
            playClickSound();
            completionFileInput.click();
        });
    }

    if (completionProofForm) {
        completionProofForm.addEventListener('submit', submitCompletionProof);
    }

    // Revision reason form
    const revisionReasonForm = document.getElementById('revision-reason-form');
    if (revisionReasonForm) {
        revisionReasonForm.addEventListener('submit', submitRevisionReason);
    }

    // Help button
    if (elements.helpBtn && elements.helpModal) {
        elements.helpBtn.addEventListener('click', () => {
            playClickSound();
            elements.helpModal.classList.add('active');
        });
    }

    // Project files button — opens the "Файлы проекта" modal (project-level
    // documents, distinct from per-task attachments)
    if (elements.projectFilesBtn && elements.projectFilesModal) {
        elements.projectFilesBtn.addEventListener('click', () => {
            playClickSound();
            renderProjectFilesList();
            elements.projectFilesModal.classList.add('active');
        });
    }
    if (elements.taskArchiveBtn && elements.taskArchiveModal) {
        elements.taskArchiveBtn.addEventListener('click', () => {
            playClickSound();
            openTaskArchiveModal();
        });
    }
    if (elements.addProjectFileBtn && elements.projectFileInput) {
        elements.addProjectFileBtn.addEventListener('click', () => {
            playClickSound();
            elements.projectFileInput.click();
        });
        elements.projectFileInput.addEventListener('change', handleProjectFileSelect);
    }

    // Close dropdowns when clicking outside
    window.addEventListener('click', () => {
        document.querySelectorAll('.status-dropdown.active').forEach(d => {
            d.classList.remove('active');
        });
    });

    elements.closeModalBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            playClickSound();
            const modal = btn.closest('.modal');
            if (modal) {
                closeModalElement(modal);
            }
        });
    });

    // Close on click outside
    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal')) {
            closeModalElement(e.target);
        }
    });

    // Project deadline toggle
    const projectHasDeadline = document.getElementById('p-has-deadline');
    const projectDeadlineGroup = document.getElementById('p-deadline-group');
    const projectDeadlineInput = document.getElementById('p-deadline');

    if (projectHasDeadline && projectDeadlineGroup) {
        projectHasDeadline.addEventListener('change', (e) => {
            if (e.target.checked) {
                projectDeadlineGroup.classList.add('active');
                if (projectDeadlineInput && !projectDeadlineInput.value) {
                    // Set default deadline to 1 month from now
                    const defaultDate = new Date();
                    defaultDate.setMonth(defaultDate.getMonth() + 1);
                    projectDeadlineInput.value = defaultDate.toISOString().split('T')[0];
                }
            } else {
                projectDeadlineGroup.classList.remove('active');
            }
        });
    }

    // Settings button
    const settingsBtn = document.getElementById('settings-btn');
    const settingsModal = document.getElementById('settings-modal');

    if (settingsBtn && settingsModal) {
        settingsBtn.addEventListener('click', () => {
            playClickSound();
            settingsModal.classList.add('active');
            closeSidebarOnMobile();
        });
    }

    // Forms
    if (elements.projectForm && elements.projectModal) {
        elements.projectForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            playClickSound();
            const projectId = document.getElementById('p-id')?.value || '';
            const isEdit = !!projectId;
            const name = document.getElementById('p-name')?.value || '';
            const desc = document.getElementById('p-desc')?.value || '';
            const hasDeadline = document.getElementById('p-has-deadline')?.checked || false;
            const deadline = hasDeadline ? (document.getElementById('p-deadline')?.value || null) : null;
            const submitBtn = elements.projectForm.querySelector('button[type="submit"]');
            const label = isEdit ? 'Сохранить' : 'Создать проект';

            if (submitBtn) setButtonLoading(submitBtn, true, label);

            try {
                if (isEdit) {
                    await updateProject(projectId, { name, description: desc, deadline });
                } else {
                    await createProject(name, desc, deadline);
                }

                // Reset form only after Firestore accepts the write.
                elements.projectModal.classList.remove('active');
                elements.projectForm.reset();
                const projectIdInput = document.getElementById('p-id');
                const hasDeadlineInput = document.getElementById('p-has-deadline');
                const deadlineGroup = document.getElementById('p-deadline-group');
                if (projectIdInput) projectIdInput.value = '';
                if (hasDeadlineInput) hasDeadlineInput.checked = false;
                if (deadlineGroup) deadlineGroup.classList.remove('active');
            } catch (error) {
                console.error("Error saving project:", error);
                alert("❌ Ошибка при сохранении проекта:\n\n" + (error.message || error));
            } finally {
                if (submitBtn) setButtonLoading(submitBtn, false, label);
            }
        });
    }

    // Logic
    function createProject(name, description, deadline = null) {
        // Check permission: only owner or admin can create projects
        if (!canManageProjects()) {
            return Promise.reject(new Error('Недостаточно прав для создания проекта'));
        }
        const organizationId = getCurrentOrganizationId();
        if (!organizationId) {
            return Promise.reject(new Error('Организация ещё не загружена. Обновите страницу и попробуйте снова.'));
        }

        const projectData = {
            name,
            description,
            organizationId,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        if (deadline) {
            projectData.deadline = deadline;
        }

        return db.collection('projects').add(projectData).then((docRef) => {
            selectProject(docRef.id);
            closeSidebarOnMobile();
        });
    }

    async function createTask(title, assignee, deadline, status, assigneeEmail, description) {
        // Check permission: owner, admin, or moderator can create tasks
        if (!canManageTasks()) {
            alert('❌ Недостаточно прав для создания задачи');
            return;
        }
        if (!state.activeProjectId) {
            alert('❌ Сначала выберите проект');
            return;
        }
        const organizationId = getCurrentOrganizationId();
        if (!organizationId) {
            alert('❌ Организация ещё не загружена. Обновите страницу и попробуйте снова.');
            return;
        }

        // Show loading state on button (may be outside form)
        const submitBtn = document.querySelector('button[form="task-form"]') ||
            elements.taskForm.querySelector('button[type="submit"]');
        if (submitBtn) {
            setButtonLoading(submitBtn, true, 'Создать');
        }

        try {
            // Prepare attachments (filter out any still uploading)
            const attachments = pendingAttachments.filter(a => !a.uploading && a.url);

            // Get creator name
            const createdBy = state.currentUser ?
                `${state.currentUser.firstName || ''} ${state.currentUser.lastName || ''}`.trim() || state.currentUser.email : '';

            const newTaskRef = await db.collection('tasks').add({
                projectId: state.activeProjectId,
                organizationId,
                title,
                description: description || '',
                assignee: assignee || 'Не назначен',
                assigneeEmail: assigneeEmail || '',
                assigneeIds: selectedAssignees.map(a => a.id).filter(Boolean),
                deadline,
                status,
                subStatus: 'assigned', // Default status for new system
                assigneeCompleted: false,
                assignedAt: firebase.firestore.FieldValue.serverTimestamp(),
                attachments: attachments, // Add attachments array
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                createdBy: createdBy,
                createdByEmail: state.currentUser?.email || '',
                createdByUid: state.currentUser?.uid || null,
                // Доп. постановщики: получают уведомления постановщика и могут
                // принимать / возвращать задачу (см. canActAsTaskCreator)
                coCreatorIds: selectedCoCreators.map(c => c.id).filter(Boolean),
                coCreators: selectedCoCreators.map(c => c.name).join(', ')
            });

            // Уведомление каждому исполнителю ПО UID: сервер доставит Telegram
            // (если привязан) + push + email Google + запись в ленту «Уведомления» с
            // deep-link на задачу. Работает и для участников без Telegram.
            const projectName = document.getElementById('project-title')?.textContent || 'Проект';
            const newTaskEvent = { type: 'task_created', taskId: newTaskRef.id, projectId: state.activeProjectId };
            selectedAssignees.forEach(a => {
                if (!a.id) return;
                const message = `📋 <b>Новая задача!</b>

<b>Задача:</b> ${escapeHtmlForTelegram(title)}
<b>Проект:</b> ${escapeHtmlForTelegram(projectName)}
<b>Срок:</b> ${deadline ? formatDate(deadline) : 'Не указан'}

Откройте ProjectMan для подробностей.`;
                sendTaskEventToUid(a.id, message, newTaskEvent);
            });

            // Доп. постановщикам — отдельное уведомление о назначении
            selectedCoCreators.forEach(c => {
                if (!c.id) return;
                const message = `👤 <b>Вы добавлены постановщиком задачи</b>

<b>Задача:</b> ${escapeHtmlForTelegram(title)}
<b>Проект:</b> ${escapeHtmlForTelegram(projectName)}
<b>Срок:</b> ${deadline ? formatDate(deadline) : 'Не указан'}

Вы будете получать уведомления по задаче и сможете принять её или вернуть на доработку.`;
                sendTaskEventToUid(c.id, message, newTaskEvent);
            });

            console.log("✅ Задача успешно создана!");
            elements.taskModal.classList.remove('active');
            elements.taskForm.reset();
            if (submitBtn) setButtonLoading(submitBtn, false, 'Создать');
        } catch (error) {
            console.error("Error creating task:", error);
            alert("❌ Ошибка при создании задачи:\n\n" + error.message);
            if (submitBtn) setButtonLoading(submitBtn, false, 'Создать');
        }
    }

    // ... (rest of functions) ...

    // Event Listeners
    // ...
    if (elements.taskForm) {
        elements.taskForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            playClickSound();

            // Find submit button (may be outside form with form="task-form" attribute)
            const submitBtn = document.querySelector('button[form="task-form"]') ||
                elements.taskForm.querySelector('button[type="submit"]');

            const title = document.getElementById('t-title')?.value || '';
            const description = document.getElementById('t-description')?.value || '';
            const taskId = document.getElementById('t-id')?.value || '';

            // Get selected assignees from new picker
            const { names: assignee, emails: assigneeEmail } = getSelectedAssignees();

            const deadline = document.getElementById('t-deadline')?.value || '';
            const status = document.getElementById('t-status')?.value || '';

            if (taskId) {
                // Prepare attachments (filter out any still uploading)
                const attachments = pendingAttachments.filter(a => !a.uploading && a.url);

                // Update existing task
                const previousTask = findLoadedTask(taskId);
                const nextAssigneeIds = selectedAssignees.map(a => a.id).filter(Boolean);
                const taskUpdates = {
                    title,
                    description,
                    assignee,
                    assigneeEmail,
                    assigneeIds: nextAssigneeIds,
                    deadline,
                    attachments, // Include attachments when updating
                    coCreatorIds: selectedCoCreators.map(c => c.id).filter(Boolean),
                    coCreators: selectedCoCreators.map(c => c.name).join(', ')
                };
                if (previousTask && String(previousTask.deadline || '') !== String(deadline || '')) {
                    taskUpdates.notifiedDeadlineSoonAt = firebase.firestore.FieldValue.delete();
                    taskUpdates.notifiedOverdueOn = firebase.firestore.FieldValue.delete();
                }
                if (previousTask && !sameIdList(previousTask.assigneeIds, nextAssigneeIds)) {
                    taskUpdates.notifiedNotTakenAt = firebase.firestore.FieldValue.delete();
                    taskUpdates.assignedAt = firebase.firestore.FieldValue.serverTimestamp();
                }
                await updateTask(taskId, taskUpdates);
            } else {
                // Create new task
                await createTask(title, assignee, deadline, status, assigneeEmail, description);
            }
        });
    }

    setupDragAndDrop();

    // Theme toggle in settings modal
    const themeToggleOption = document.getElementById('theme-toggle');
    const themeCheckbox = document.getElementById('theme-checkbox');

    if (themeToggleOption && themeCheckbox) {
        // Click on the option card (but not checkbox) - toggle the checkbox
        themeToggleOption.addEventListener('click', (e) => {
            if (e.target !== themeCheckbox && !e.target.closest('.toggle-switch')) {
                playClickSound();
                themeCheckbox.checked = !themeCheckbox.checked;
                setTheme(themeCheckbox.checked);
            }
        });

        // Direct checkbox change
        themeCheckbox.addEventListener('change', () => {
            playClickSound();
            setTheme(themeCheckbox.checked);
        });
    }

    // Role selection listeners removed (deprecated)


    // Back to Auth (Login/Register) from Role Screen
    const backToAuthBtn = document.getElementById('back-to-auth-btn');
    if (backToAuthBtn) {
        backToAuthBtn.addEventListener('click', () => {
            // Sign out to go back to login screen properly
            auth.signOut().then(() => {
                showAuthScreen();
            });
        });
    }

    // Logout
    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            playClickSound();
            closeSidebarOnMobile();
            logout();
        });
    }

    // Mobile Menu
    if (elements.mobileMenuBtn && elements.sidebar && elements.sidebarOverlay) {
        elements.mobileMenuBtn.addEventListener('click', () => {
            playClickSound();
            elements.sidebar.classList.add('active');
            elements.sidebarOverlay.classList.add('active');
        });
    }

    // Buttons that live inside the mobile sidebar and open a modal must first
    // close the sidebar, otherwise the modal opens behind it.
    [elements.myTasksBtn, elements.adminPanelBtn, document.getElementById('agent-notify-btn')].forEach(btn => {
        if (btn) btn.addEventListener('click', closeSidebarOnMobile);
    });

    // Close sidebar when clicking overlay
    if (elements.sidebarOverlay && elements.sidebar) {
        elements.sidebarOverlay.addEventListener('click', () => {
            playClickSound();
            elements.sidebar.classList.remove('active');
            elements.sidebarOverlay.classList.remove('active');
        });
    }

    // Admin Panel
    if (elements.adminPanelBtn) {
        elements.adminPanelBtn.addEventListener('click', () => {
            // Check if button is disabled (non-admin users)
            if (elements.adminPanelBtn.classList.contains('disabled')) {
                return; // Don't open for non-admin users
            }
            playClickSound();
            closeSidebarOnMobile();
            elements.adminPanelModal.classList.add('active');
        });
    }

    // My Tasks Button
    if (elements.myTasksBtn) {
        elements.myTasksBtn.addEventListener('click', () => {
            playClickSound();
            closeSidebarOnMobile();
            openMyTasksModal();
        });
    }

    // Agent Notifications (колокольчик)
    const agentNotifyBtn = document.getElementById('agent-notify-btn');
    if (agentNotifyBtn) {
        agentNotifyBtn.addEventListener('click', () => {
            playClickSound();
            closeSidebarOnMobile();
            renderAgentNotifyList();
            document.getElementById('agent-notify-modal')?.classList.add('active');
        });
    }
    const agentNotifyReadAll = document.getElementById('agent-notify-read-all');
    if (agentNotifyReadAll) {
        agentNotifyReadAll.addEventListener('click', () => {
            playClickSound();
            markAllAgentNotificationsRead();
        });
    }
    const agentNotifyDeleteAll = document.getElementById('agent-notify-delete-all');
    if (agentNotifyDeleteAll) {
        agentNotifyDeleteAll.addEventListener('click', () => {
            playClickSound();
            deleteAllAgentNotifications(agentNotifyDeleteAll);
        });
    }

    // Admin Panel Tabs
    document.querySelectorAll('.admin-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            playClickSound();
            const tabName = tab.dataset.tab;

            // Update active tab
            document.querySelectorAll('.admin-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Update active content
            document.querySelectorAll('.admin-tab-content').forEach(c => c.classList.remove('active'));
            document.getElementById(`admin-${tabName}-tab`).classList.add('active');

            // Ensure tab-specific content is fresh
            if (tabName === 'access') {
                renderProjectAccessTab();
            }
            if (tabName === 'logins') {
                renderLoginHistoryTab();
            }
            if (tabName === 'stats') {
                renderAdminUsersStatsPanel();
            }
        });
    });

    // Category picker (mobile -> opens compact modal)
    if (elements.categoryBtn && elements.categoryModal) {
        elements.categoryBtn.addEventListener('click', (e) => {
            e.preventDefault();
            playClickSound();
            elements.categoryModal.style.display = 'flex';
        });

        // Close on overlay click
        elements.categoryModal.addEventListener('click', (e) => {
            if (e.target === elements.categoryModal) {
                playClickSound();
                elements.categoryModal.style.display = 'none';
            }
        });

        // Handle option selection
        elements.categoryModal.querySelectorAll('button[data-view]').forEach(btn => {
            btn.addEventListener('click', () => {
                playClickSound();
                const view = btn.dataset.view;
                setBoardView(view);
                elements.categoryModal.style.display = 'none';
            });
        });
    }

    // Switching between desktop and mobile changes whether one or all three
    // active columns are visible.
    window.addEventListener('resize', () => setBoardView(state.boardView || 'assigned'));

    // Project access tab is organized by project; it renders on tab-open and on
    // every users snapshot (see renderProjectAccessTab / the users listener).
}


// Authentication Functions

const TELEGRAM_BOT_PENDING_KEY = 'projectman.telegramBotLogin.pending';
let telegramBotLoginAttempt = 0;
let telegramBotLoginResumeInFlight = false;
let organizationLoadRetryInFlight = false;
let emailAuthMode = 'login';
let emailRegistrationInProgress = false;
let emailVerificationCheckInFlight = false;

function isPasswordAuthUser(user) {
    return Boolean(user?.providerData?.some(provider => provider?.providerId === 'password'));
}

function setEmailAuthMode(mode) {
    emailAuthMode = mode === 'register' ? 'register' : 'login';
    const isRegistration = emailAuthMode === 'register';
    const title = document.getElementById('auth-title');
    const subtitle = document.getElementById('auth-subtitle');
    const password = document.getElementById('auth-password');
    const confirmGroup = document.getElementById('auth-password-confirm-group');
    const confirm = document.getElementById('auth-password-confirm');
    const submit = document.getElementById('email-auth-submit');
    const toggle = document.getElementById('auth-mode-toggle');
    const reset = document.getElementById('auth-password-reset');

    if (title) title.textContent = isRegistration ? 'Регистрация' : 'Вход в систему';
    if (subtitle) subtitle.textContent = isRegistration
        ? 'Создайте аккаунт с рабочей или личной почтой'
        : 'Один аккаунт в веб-версии и приложении';
    if (password) password.autocomplete = isRegistration ? 'new-password' : 'current-password';
    if (confirmGroup) confirmGroup.hidden = !isRegistration;
    if (confirm) {
        confirm.required = isRegistration;
        if (!isRegistration) confirm.value = '';
    }
    if (submit) {
        submit.querySelector('span').textContent = isRegistration ? 'Зарегистрироваться' : 'Войти';
        const icon = submit.querySelector('i');
        if (icon) icon.className = isRegistration ? 'fa-solid fa-user-plus' : 'fa-solid fa-right-to-bracket';
    }
    if (toggle) toggle.textContent = isRegistration ? 'Уже есть аккаунт? Войти' : 'Регистрация';
    if (reset) reset.hidden = isRegistration;
    setLoginErrorMessage('');
}

function setEmailAuthContentVisible(visible) {
    const form = document.getElementById('email-auth-form');
    const divider = document.querySelector('#auth-screen > .auth-divider');
    const providers = document.querySelector('#auth-screen > .auth-provider-list');
    if (form) form.hidden = !visible;
    if (divider) divider.hidden = !visible;
    if (providers) providers.hidden = !visible;
}

function showEmailVerificationGate(user, message = '') {
    hideLoadingScreen();
    if (elements.authOverlay) elements.authOverlay.style.display = 'flex';
    if (elements.authScreen) elements.authScreen.style.display = 'flex';
    setEmailAuthContentVisible(false);

    const panel = document.getElementById('email-verification-panel');
    const address = document.getElementById('email-verification-address');
    const title = document.getElementById('auth-title');
    const subtitle = document.getElementById('auth-subtitle');
    if (panel) panel.hidden = false;
    if (address) address.textContent = user?.email || '';
    if (title) title.textContent = 'Подтвердите почту';
    if (subtitle) subtitle.textContent = 'Это необходимо, чтобы продолжить регистрацию';
    setLoginErrorMessage(message, message ? 'success' : 'error');
}

function showEmailAuthContent() {
    const panel = document.getElementById('email-verification-panel');
    if (panel) panel.hidden = true;
    setEmailAuthContentVisible(true);
    setEmailAuthMode(emailAuthMode);
}

function setEmailAuthBusy(busy) {
    const submit = document.getElementById('email-auth-submit');
    if (busy) {
        setButtonLoading(
            submit,
            true,
            emailAuthMode === 'register' ? 'Регистрируем…' : 'Входим…'
        );
    } else {
        setButtonLoading(submit, false);
    }

    ['auth-mode-toggle', 'auth-password-reset', 'google-login-btn', 'apple-login-btn', 'telegram-login-btn'].forEach(id => {
        const control = document.getElementById(id);
        if (control) control.disabled = busy;
    });
}

function emailAuthErrorMessage(error) {
    switch (error?.code) {
        case 'auth/email-already-in-use':
            return 'Аккаунт с этой почтой уже существует. Войдите или восстановите пароль.';
        case 'auth/invalid-email':
            return 'Проверьте правильность адреса почты.';
        case 'auth/weak-password':
            return 'Пароль слишком простой. Используйте минимум 8 символов.';
        case 'auth/user-not-found':
        case 'auth/wrong-password':
        case 'auth/invalid-login-credentials':
        case 'auth/invalid-credential':
            return 'Неверная почта или пароль.';
        case 'auth/too-many-requests':
            return 'Слишком много попыток. Подождите немного и попробуйте снова.';
        case 'auth/operation-not-allowed':
            return 'Вход по почте ещё не включён администратором.';
        case 'auth/network-request-failed':
            return 'Нет соединения с сервером. Проверьте интернет.';
        default:
            return error?.message || 'Не удалось выполнить вход.';
    }
}

async function handleEmailAuthSubmit(event) {
    event.preventDefault();
    if (!auth) return;
    const emailInput = document.getElementById('auth-email');
    const passwordInput = document.getElementById('auth-password');
    const confirmInput = document.getElementById('auth-password-confirm');
    const email = emailInput?.value.trim().toLowerCase() || '';
    const password = passwordInput?.value || '';

    if (!emailInput?.checkValidity()) {
        setLoginErrorMessage('Введите корректный адрес почты.');
        emailInput?.focus();
        return;
    }
    if (password.length < 8) {
        setLoginErrorMessage('Пароль должен содержать минимум 8 символов.');
        passwordInput?.focus();
        return;
    }
    if (emailAuthMode === 'register' && password !== (confirmInput?.value || '')) {
        setLoginErrorMessage('Пароли не совпадают.');
        confirmInput?.focus();
        return;
    }

    setLoginErrorMessage('');
    setEmailAuthBusy(true);
    try {
        await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
        if (emailAuthMode === 'register') {
            emailRegistrationInProgress = true;
            const credential = await auth.createUserWithEmailAndPassword(email, password);
            await credential.user.sendEmailVerification();
            showEmailVerificationGate(credential.user, 'Письмо отправлено. Проверьте входящие и папку «Спам».');
        } else {
            const credential = await auth.signInWithEmailAndPassword(email, password);
            if (!credential.user.emailVerified) {
                showEmailVerificationGate(credential.user);
            }
        }
    } catch (error) {
        console.error('Email auth failed:', error);
        setLoginErrorMessage(emailAuthErrorMessage(error));
    } finally {
        emailRegistrationInProgress = false;
        setEmailAuthBusy(false);
    }
}

async function resendEmailVerification() {
    const user = auth?.currentUser;
    if (!user || !isPasswordAuthUser(user)) return;
    const button = document.getElementById('email-verification-resend');
    setButtonLoading(button, true, 'Отправляем…');
    try {
        await user.sendEmailVerification();
        setLoginErrorMessage('Письмо отправлено повторно. Проверьте также папку «Спам».', 'success');
    } catch (error) {
        setLoginErrorMessage(emailAuthErrorMessage(error));
    } finally {
        setButtonLoading(button, false);
    }
}

async function checkEmailVerification({ silent = false } = {}) {
    const user = auth?.currentUser;
    if (!user || !isPasswordAuthUser(user) || emailVerificationCheckInFlight) return;
    emailVerificationCheckInFlight = true;
    const button = document.getElementById('email-verification-check');
    if (!silent) setButtonLoading(button, true, 'Проверяем…');
    try {
        await user.reload();
        if (!user.emailVerified) {
            if (!silent) setLoginErrorMessage('Почта ещё не подтверждена. Перейдите по ссылке из письма.');
            return;
        }
        await user.getIdToken(true);
        setLoginErrorMessage('Почта подтверждена. Продолжаем регистрацию…', 'success');
        const panel = document.getElementById('email-verification-panel');
        if (panel) panel.hidden = true;
        await bootstrapAuthenticatedProfile(user);
        await loadUserRole(user);
    } catch (error) {
        if (!silent) setLoginErrorMessage(emailAuthErrorMessage(error));
    } finally {
        emailVerificationCheckInFlight = false;
        if (!silent) setButtonLoading(button, false);
    }
}

function getPendingTelegramBotLogin() {
    try {
        const raw = sessionStorage.getItem(TELEGRAM_BOT_PENDING_KEY);
        if (!raw) return null;
        const pending = JSON.parse(raw);
        const expiresAtMs = Date.parse(pending.expiresAt || '');
        if (!pending.code || !Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
            sessionStorage.removeItem(TELEGRAM_BOT_PENDING_KEY);
            return null;
        }
        return pending;
    } catch {
        sessionStorage.removeItem(TELEGRAM_BOT_PENDING_KEY);
        return null;
    }
}

function savePendingTelegramBotLogin(code, expiresAt) {
    if (!code || !expiresAt) return;
    sessionStorage.setItem(TELEGRAM_BOT_PENDING_KEY, JSON.stringify({ code, expiresAt }));
}

function clearPendingTelegramBotLogin() {
    sessionStorage.removeItem(TELEGRAM_BOT_PENDING_KEY);
}

function hasActiveTelegramBotLogin() {
    return Boolean(getPendingTelegramBotLogin());
}

async function resumeTelegramBotLoginIfPending() {
    if (telegramBotLoginResumeInFlight) return;
    if (firebase.auth().currentUser) {
        clearPendingTelegramBotLogin();
        return;
    }
    const pending = getPendingTelegramBotLogin();
    if (!pending) return;

    const attemptId = ++telegramBotLoginAttempt;
    telegramBotLoginResumeInFlight = true;
    try {
        setTelegramBotLoginBusy(true);
        setLoginErrorMessage('Ждём подтверждение входа в Telegram-боте...');
        await pollTelegramBotLogin(pending.code, pending.expiresAt, attemptId);
    } catch (error) {
        if (attemptId === telegramBotLoginAttempt) {
            clearPendingTelegramBotLogin();
            setLoginErrorMessage(error.message || 'Не удалось завершить вход через Telegram-бота.');
        }
    } finally {
        telegramBotLoginResumeInFlight = false;
        if (attemptId === telegramBotLoginAttempt) setTelegramBotLoginBusy(false);
    }
}

// type: 'error' (default, red) | 'success' (green — e.g. confirmed login)
function setLoginErrorMessage(message, type = 'error') {
    if (!elements.loginError) return;
    elements.loginError.textContent = message || '';
    elements.loginError.classList.toggle('success', type === 'success');
}

function setTelegramBotLoginBusy(isBusy) {
    const primaryBtn = document.getElementById('telegram-login-btn');
    if (isBusy) setButtonLoading(primaryBtn, true, 'Проверяем Telegram…');
    else setButtonLoading(primaryBtn, false);
    ['google-login-btn', 'apple-login-btn', 'email-auth-submit', 'auth-mode-toggle', 'auth-password-reset'].forEach(id => {
        const button = document.getElementById(id);
        if (button) button.disabled = isBusy;
    });
    if (elements.telegramBotLoginBtn) elements.telegramBotLoginBtn.disabled = isBusy;
}

function wait(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Telegram Login Widget callback (see index.html data-onauth="onTelegramAuth(user)").
// Sends the widget's signed payload to the server for verification, then signs
// in with the resulting Firebase custom token. onAuthStateChanged takes it from there.
window.onTelegramAuth = async function onTelegramAuth(telegramUser) {
    try {
        const res = await fetch('/api/telegram-auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(telegramUser),
        });
        const data = await res.json();
        if (!data.ok) throw new Error(data.error || 'Telegram auth failed');
        if (data.telegramMessage && data.telegramMessage.ok === false) {
            const detail = data.telegramMessage.description || data.telegramMessage.error || 'неизвестная ошибка Telegram';
            console.warn('Telegram login message was not delivered:', data.telegramMessage);
            setLoginErrorMessage(`Вход выполнен, но сообщение в Telegram не отправлено: ${detail}`);
        } else {
            setLoginErrorMessage('');
        }
        // Force LOCAL (IndexedDB) persistence at sign-in time so the session
        // survives a full browser close — a belt-and-suspenders on top of the
        // init-time setPersistence, in case that one raced or failed.
        await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
        await firebase.auth().signInWithCustomToken(data.token);
    } catch (error) {
        console.error('Telegram login failed', error);
        alert('Не удалось войти через Telegram. Попробуйте ещё раз.');
    }
};

// Opens Telegram's official auth popup from our own styled button.
// bot_id is public (the part before ":" in the bot token) — not a secret.
// If the user is already logged into Telegram in this browser, the popup
// confirms instantly; otherwise Telegram sends a confirmation to their
// Telegram app (that delivery step is handled entirely by Telegram).
window.startTelegramLogin = function startTelegramLogin() {
    const tg = window.Telegram && window.Telegram.Login;
    if (!tg || typeof tg.auth !== 'function') {
        setLoginErrorMessage('Telegram ещё загружается, попробуйте через секунду.');
        return;
    }
    setLoginErrorMessage('');
    tg.auth({ bot_id: '8318306872', request_access: 'write' }, (user) => {
        if (!user) {
            setLoginErrorMessage('Вход через Telegram отменён.');
            return;
        }
        window.onTelegramAuth(user);
    });
};

window.startTelegramBotLogin = async function startTelegramBotLogin() {
    const attemptId = ++telegramBotLoginAttempt;
    let botWindow = null;

    try {
        setTelegramBotLoginBusy(true);
        setLoginErrorMessage('Открываю Telegram-бота...');

        // Open synchronously from the click handler path; opening after await is
        // commonly blocked by browsers as a non-user-initiated popup.
        botWindow = window.open('', '_blank');
        if (botWindow) {
            botWindow.opener = null;
            botWindow.document.title = 'ProjectMan Telegram';
        }

        const res = await fetch('/api/telegram-bot-login-start', { method: 'POST' });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok || !data.code || !data.botUrl) {
            throw new Error(data.error || 'Не удалось начать вход через бота.');
        }
        savePendingTelegramBotLogin(data.code, data.expiresAt);

        if (botWindow) {
            botWindow.location.href = data.botUrl;
            setLoginErrorMessage('Нажмите Start в Telegram-боте. После подтверждения вход завершится автоматически.');
        } else {
            setLoginErrorMessage(`Откройте Telegram-бота вручную: ${data.botUrl}`);
        }

        await pollTelegramBotLogin(data.code, data.expiresAt, attemptId);
    } catch (error) {
        if (botWindow && !botWindow.closed) botWindow.close();
        console.error('Telegram bot login failed', error);
        if (attemptId === telegramBotLoginAttempt) {
            setLoginErrorMessage(error.message || 'Не удалось войти через Telegram-бота.');
        }
    } finally {
        if (attemptId === telegramBotLoginAttempt) {
            setTelegramBotLoginBusy(false);
        }
    }
};

async function pollTelegramBotLogin(code, expiresAt, attemptId) {
    const expiresAtMs = Date.parse(expiresAt || '');
    const deadlineMs = Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + 5 * 60 * 1000;
    let delayMs = 0;

    while (attemptId === telegramBotLoginAttempt && Date.now() < deadlineMs) {
        if (delayMs > 0) await wait(delayMs);
        const res = await fetch('/api/telegram-bot-login-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code }),
        });
        const data = await res.json().catch(() => ({}));

        if (data.status === 'pending') {
            delayMs = Math.min(delayMs + 500, 2000);
            continue;
        }
        if (res.ok && data.ok && data.status === 'confirmed' && data.token) {
            clearPendingTelegramBotLogin();
            setLoginErrorMessage('Вход подтверждён. Загружаем рабочее пространство...', 'success');
            await firebase.auth().setPersistence(firebase.auth.Auth.Persistence.LOCAL).catch(() => {});
            await firebase.auth().signInWithCustomToken(data.token);
            return;
        }
        throw new Error(data.error || 'Telegram-бот не подтвердил вход.');
    }

    clearPendingTelegramBotLogin();
    throw new Error('Ссылка для входа устарела. Нажмите «Войти через бота» ещё раз.');
}

let authStateGeneration = 0;

async function onAuthStateChanged(user) {
    const generation = ++authStateGeneration;
    if (user) {
        clearPendingTelegramBotLogin();
        if (isPasswordAuthUser(user) && !user.emailVerified) {
            // Firebase can restore a cached User object after the verification
            // link was opened in another tab. Refresh it before keeping the
            // user behind the confirmation gate.
            await user.reload().catch(() => {});
            if (user.emailVerified) await user.getIdToken(true).catch(() => {});
        }
        if (isPasswordAuthUser(user) && !user.emailVerified) {
            showEmailVerificationGate(user, emailRegistrationInProgress
                ? 'Письмо отправлено. Проверьте входящие и папку «Спам».'
                : 'Подтвердите адрес по ссылке из письма, чтобы продолжить.');
            return;
        }
        try {
            await bootstrapAuthenticatedProfile(user);
        } catch (error) {
            if (error?.code === 'AUTH_PROVIDER_MISMATCH') {
                await auth.signOut().catch(() => {});
                setLoginErrorMessage(error.message, 'error');
                return;
            }
            // Existing accounts can continue if the bootstrap endpoint is
            // temporarily unavailable. A new account will stay behind the
            // profile-name gate rather than receive fabricated local access.
            console.error('Auth profile bootstrap failed:', error);
        }
        if (generation !== authStateGeneration || auth.currentUser?.uid !== user.uid) return;
        loadUserRole(user);
    } else {
        // No user. Firebase's FIRST onAuthStateChanged fire on page load already
        // reflects the state restored from persistence (it waits for IndexedDB),
        // so a null here means there is genuinely no session — show the login
        // screen once. (An earlier version tried a guarded reload here to paper
        // over a "slow restore", but the first fire is authoritative, so the
        // reload never helped and produced a visible login→reload→login flash
        // when the session truly wasn't persisted. Removed.)
        state.currentUser = null;
        state.role = 'guest';
        // Bump the agent-chat generation counter on every sign-out, however
        // it was triggered (explicit "Выйти" via logout(), or a forced
        // auth.signOut() after the agent-chat endpoint returns 401). This is
        // the single choke point both paths go through, so a stale
        // agent-chat response that resolves after (or during) sign-out can
        // never render into a UI/session that no longer belongs to that
        // user. See agentChatState.generation for the full mechanism.
        agentChatState.generation += 1;
        showAuthScreen();
    }
}

function federatedProvider(providerId) {
    if (providerId === 'google.com') {
        const provider = new firebase.auth.GoogleAuthProvider();
        provider.addScope('profile');
        provider.addScope('email');
        provider.setCustomParameters({ prompt: 'select_account' });
        return provider;
    }
    if (providerId === 'apple.com') {
        const provider = new firebase.auth.OAuthProvider('apple.com');
        provider.addScope('email');
        provider.addScope('name');
        provider.setCustomParameters({ locale: 'ru' });
        return provider;
    }
    throw new Error('Неизвестный способ входа.');
}

function setFederatedLoginBusy(busy, activeButtonId = '') {
    ['google-login-btn', 'apple-login-btn', 'telegram-login-btn'].forEach(id => {
        const button = document.getElementById(id);
        if (!button) return;
        if (busy && id === activeButtonId) {
            const label = id === 'google-login-btn' ? 'Входим через Google…' : 'Входим через Apple…';
            setButtonLoading(button, true, label);
        } else if (!busy) {
            setButtonLoading(button, false);
            button.disabled = false;
        } else {
            button.disabled = true;
        }
    });
}

async function startFederatedLogin(providerId) {
    if (!auth) return;
    playClickSound();
    setLoginErrorMessage('');
    const activeButtonId = providerId === 'google.com' ? 'google-login-btn' : 'apple-login-btn';
    setFederatedLoginBusy(true, activeButtonId);
    try {
        await auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
        const provider = federatedProvider(providerId);
        // Redirect is more reliable on narrow/mobile browsers and preserves
        // the session across the external Apple/Google authorization page.
        if (window.matchMedia('(max-width: 760px)').matches) {
            await auth.signInWithRedirect(provider);
            return;
        }
        await auth.signInWithPopup(provider);
    } catch (error) {
        handleFederatedAuthError(error);
    } finally {
        setFederatedLoginBusy(false);
    }
}

function handleFederatedAuthError(error) {
    if (!error || error.code === 'auth/popup-closed-by-user' || error.code === 'auth/cancelled-popup-request') return;
    console.error('Federated auth failed:', error);
    let message = 'Не удалось войти. Проверьте настройки входа и попробуйте снова.';
    if (error.code === 'auth/account-exists-with-different-credential') {
        message = 'Аккаунт с этой почтой уже существует. Войдите способом, выбранным при регистрации.';
    } else if (error.code === 'auth/unauthorized-domain') {
        message = 'Этот домен не разрешён в настройках Firebase Authentication.';
    } else if (error.code === 'auth/operation-not-allowed') {
        message = 'Этот способ входа ещё не включён администратором.';
    }
    setLoginErrorMessage(message, 'error');
}

async function bootstrapAuthenticatedProfile(user = auth?.currentUser) {
    if (!user) throw new Error('Нет активной сессии.');
    const token = await user.getIdToken();
    const response = await fetch('/api/org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'bootstrapAuth' }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = new Error(data.error || `Ошибка сервера (${response.status})`);
        error.code = data.code || '';
        throw error;
    }
    return data;
}

function renderAuthProvider() {
    const provider = state.currentUser?.authProvider || '';
    const title = provider === 'apple.com' ? 'Apple'
        : provider === 'google.com' ? 'Google'
            : provider === 'password' ? 'Email'
            : provider === 'telegram' ? 'Telegram' : 'ProjectMan';
    const icon = document.getElementById('profile-auth-icon');
    const label = document.getElementById('profile-auth-provider');
    if (label) label.textContent = title;
    if (icon) {
        icon.className = provider === 'apple.com' ? 'fa-brands fa-apple'
            : provider === 'telegram' ? 'fa-brands fa-telegram'
                : provider === 'google.com' ? 'fa-brands fa-google'
                    : provider === 'password' ? 'fa-solid fa-envelope-circle-check'
                    : 'fa-solid fa-user-shield';
    }
}

async function loadUserRole(user) {
    state.currentUser = {
        uid: user.uid,
        email: user.email,
        role: 'reader', // Legacy default
        orgRole: 'employee'
    };

    // Timeout promise to prevent infinite loading
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timed out')), 8000)
    );

    // Fetch user profile to get name, role, and organization
    try {
        const userDocPromise = db.collection('users').doc(user.uid).get();

        // Race between fetch and timeout
        const userDoc = await Promise.race([userDocPromise, timeoutPromise]);

        if (userDoc.exists) {
            const userData = userDoc.data();
            state.currentUser.firstName = userData.firstName;
            state.currentUser.lastName = userData.lastName;
            state.currentUser.fullName = `${userData.firstName} ${userData.lastName}`.trim();
            state.currentUser.role = userData.role || 'reader'; // Legacy role
            state.currentUser.orgRole = userData.orgRole || 'employee'; // New org role
            state.currentUser.organizationId = userData.organizationId || null;
            state.currentUser.allowedProjects = userData.allowedProjects || [];
            state.currentUser.telegramChatId = userData.telegramChatId || null;
            state.currentUser.telegramUsername = userData.telegramUsername || null;
            state.currentUser.authProvider = userData.authProvider || null;
            state.currentUser.profileCompleted = userData.profileCompleted === true;

            // Set state orgRole
            state.orgRole = state.currentUser.orgRole;

            // Load organization if user has one. Retry on transient read
            // errors: right after a fresh Telegram sign-in the auth token can
            // take a moment to propagate, and a single failed read here used to
            // dump a real member onto the "join organization" screen (where
            // re-entering the code then said "you're already in this org").
            if (userData.organizationId) {
                let org = null;
                let readError = false;
                for (let attempt = 1; attempt <= 3; attempt++) {
                    try {
                        org = await getOrganization(userData.organizationId);
                        readError = false;
                        break; // definitive result (org object or null)
                    } catch (orgError) {
                        readError = true;
                        console.error(`Error loading organization (attempt ${attempt}/3):`, orgError);
                        if (attempt < 3) await new Promise(r => setTimeout(r, 400 * attempt));
                    }
                }

                if (org) {
                    state.organization = org;
                } else if (!readError) {
                    // The org document genuinely doesn't exist (deleted) — only
                    // then clear membership. Never clear on a read error.
                    state.currentUser.organizationId = null;
                    await db.collection('users').doc(user.uid).set({
                        organizationId: null,
                        orgRole: null
                    }, { merge: true });
                }
                // If readError persisted after retries, keep organizationId set
                // and leave state.organization null; continueToAppOrOrg handles
                // it without sending a known member to the join screen.
                state.orgLoadFailed = Boolean(state.currentUser.organizationId && !state.organization);
            }
        }

        // Track last login (and first presence ping) for admin "history of logins"
        try {
            await db.collection('users').doc(user.uid).set({
                lastLoginAt: firebase.firestore.FieldValue.serverTimestamp(),
                lastSeenAt: firebase.firestore.FieldValue.serverTimestamp(),
                lastSeenClientAt: new Date().toISOString()
            }, { merge: true });
        } catch (e) {
            console.warn('Failed to update lastLoginAt/lastSeenAt:', e?.message || e);
        }
    } catch (e) {
        console.error("Error fetching user profile (using default role):", e);
        // Even on error, we proceed with default 'reader' role to unblock UI
    }

    // Gate: require a real first/last name before granting access. Telegram
    // registration seeds the name from the Telegram nickname, which for many
    // people is not their real name — so force a one-time confirmation.
    if (!state.currentUser.profileCompleted) {
        showNameSetupScreen(user.uid);
        return;
    }

    continueToAppOrOrg();
}

// Continuation after the profile-name gate: route to org selection or the app.
function continueToAppOrOrg() {
    // Member whose organization failed to load (transient read error after a
    // fresh sign-in). Do NOT send them to the join screen — that shows
    // "you're already in this org". Retry in-place; a full reload produced a
    // visible login → reload → login flash in the Telegram-bot flow.
    if (!state.organization) {
        if (state.orgLoadFailed) {
            retryOrganizationLoadAndContinue();
            return;
        }
        showOrgSelectionScreen();
        return;
    }

    // Auth is complete, but the user chooses which organization to enter.
    showOrgSelectionScreen();
}

async function retryOrganizationLoadAndContinue() {
    if (organizationLoadRetryInFlight) return;
    organizationLoadRetryInFlight = true;
    const orgId = state.currentUser?.organizationId;
    setLoginErrorMessage('Вход выполнен. Загружаем организацию...');
    try {
        for (let attempt = 1; attempt <= 4 && orgId; attempt += 1) {
            try {
                const org = await getOrganization(orgId);
                if (org) {
                    state.organization = org;
                    state.orgLoadFailed = false;
                    setLoginErrorMessage('');
                    continueToAppOrOrg();
                    return;
                }
            } catch (error) {
                console.warn(`Organization retry failed (${attempt}/4):`, error?.message || error);
            }
            if (attempt < 4) await wait(500 * attempt);
        }
        hideLoadingScreen();
        elements.authOverlay.style.display = 'flex';
        elements.authScreen.style.display = 'block';
        setLoginErrorMessage('Вход выполнен, но организация не загрузилась. Проверьте сеть и обновите страницу через несколько секунд.');
    } finally {
        organizationLoadRetryInFlight = false;
    }
}

function finishAuth(role) {
    console.log("Auth finished. Role:", role, "OrgRole:", state.orgRole); // Debug
    state.role = role;
    state.currentUser.role = role;

    // Use enterApp which handles organization UI
    enterApp();
}

function finishAuthLegacy(role) {
    // Legacy function - kept for reference
    hideAuthScreen();

    // Apply role restrictions based on orgRole
    applyRoleRestrictions();

    // Setup admin panel if admin+
    setupAdminPanel();

    // Force re-render of everything now that we have permissions
    renderProjects();
    if (state.activeProjectId) {
        renderBoard();
    }

    // Subscribe to real-time My Tasks updates
    subscribeToMyTasks();
    subscribeToAgentNotifications();
}

function showAuthScreen() {
    // Only hide loading screen when showing auth (user needs to login)
    hideLoadingScreen();

    elements.authOverlay.style.display = 'flex';
    elements.authScreen.style.display = 'flex';
    if (elements.roleScreen) elements.roleScreen.style.display = 'none';
    const currentUser = auth?.currentUser;
    if (currentUser && isPasswordAuthUser(currentUser) && !currentUser.emailVerified) {
        showEmailVerificationGate(currentUser);
    } else {
        showEmailAuthContent();
    }
    setTimeout(resumeTelegramBotLoginIfPending, 0);
}

// showRoleSelection removed as it's no longer used


function hideAuthScreen() {
    elements.authOverlay.style.display = 'none';

    // Show the app container
    const appContainer = document.getElementById('app-container');
    if (appContainer) {
        appContainer.style.display = 'flex';
    }

    // Hide loading screen
    hideLoadingScreen();
}

// uid whose profile the name-setup screen is currently collecting a name for.
let nameSetupUid = null;

// Blocking screen shown after Telegram registration until the user provides a
// real first/last name. Access to the rest of the app is gated on this.
function showNameSetupScreen(uid) {
    nameSetupUid = uid;
    hideLoadingScreen();

    if (elements.authOverlay) elements.authOverlay.style.display = 'none';
    if (elements.orgOverlay) elements.orgOverlay.style.display = 'none';
    const appContainer = document.getElementById('app-container');
    if (appContainer) appContainer.style.display = 'none';

    const overlay = document.getElementById('name-setup-overlay');
    const firstInput = document.getElementById('name-setup-first');
    const lastInput = document.getElementById('name-setup-last');
    const errorEl = document.getElementById('name-setup-error');

    if (errorEl) errorEl.style.display = 'none';
    // Prefill with whatever Telegram provided so the user can just correct it.
    if (firstInput) firstInput.value = state.currentUser?.firstName || '';
    if (lastInput) lastInput.value = state.currentUser?.lastName || '';

    if (overlay) overlay.style.display = 'flex';
    if (firstInput) firstInput.focus();
}

async function handleNameSetupSubmit(e) {
    e.preventDefault();

    const firstInput = document.getElementById('name-setup-first');
    const lastInput = document.getElementById('name-setup-last');
    const errorEl = document.getElementById('name-setup-error');
    const submitBtn = document.querySelector('#name-setup-form button[type="submit"]');

    const first = (firstInput?.value || '').trim();
    const last = (lastInput?.value || '').trim();

    if (first.length < 2 || last.length < 2) {
        if (errorEl) {
            errorEl.textContent = 'Введите имя и фамилию (минимум 2 символа каждое).';
            errorEl.style.display = 'block';
        }
        return;
    }

    const uid = nameSetupUid || firebase.auth().currentUser?.uid;
    if (!uid) return;

    setButtonLoading(submitBtn, true, 'Сохраняем…');

    try {
        await db.collection('users').doc(uid).set({
            firstName: first,
            lastName: last,
            displayName: `${first} ${last}`,
            profileCompleted: true
        }, { merge: true });

        state.currentUser.firstName = first;
        state.currentUser.lastName = last;
        state.currentUser.fullName = `${first} ${last}`;
        state.currentUser.profileCompleted = true;

        const overlay = document.getElementById('name-setup-overlay');
        if (overlay) overlay.style.display = 'none';
        nameSetupUid = null;

        playClickSound();
        continueToAppOrOrg();
    } catch (err) {
        console.error('Name setup failed:', err);
        if (errorEl) {
            errorEl.textContent = 'Не удалось сохранить. Попробуйте ещё раз.';
            errorEl.style.display = 'block';
        }
    } finally {
        setButtonLoading(submitBtn, false);
    }
}

async function logout() {
    try {
        // Unsubscribe from my tasks listener
        unsubscribeFromMyTasks();
        unsubscribeFromAgentNotifications();
        if (ownUserDocListenerUnsubscribe) {
            ownUserDocListenerUnsubscribe();
            ownUserDocListenerUnsubscribe = null;
        }
        stopPresenceHeartbeat();

        await auth.signOut();

        // Reload page to ensure clean state
        window.location.reload();
    } catch (error) {
        console.error('Error signing out:', error);
        // Force reload even on error
        window.location.reload();
    }
}

// Touch Drag and Drop for Mobile - DISABLED (Empty functions)
let touchDragState = {};

function setupTouchDragAndDrop(taskCard) {
    // Disabled
}

function startTouchDrag(element, touch) {
    // Disabled
}

function endTouchDrag(touch) {
    // Disabled
}

function cancelTouchDrag() {
    // Disabled
}

// Admin Panel Functions
function setupAdminPanel() {
    const adminPanelDesc = document.getElementById('admin-panel-desc');

    // Admin panel button is always visible, but disabled for non-admins
    if (elements.adminPanelBtn) {
        elements.adminPanelBtn.style.display = 'flex'; // Always visible

        if (!canAccessAdmin()) {
            elements.adminPanelBtn.classList.add('disabled');
            if (adminPanelDesc) adminPanelDesc.textContent = 'Доступ только для администраторов';
            return;
        }

        elements.adminPanelBtn.classList.remove('disabled');
        if (adminPanelDesc) adminPanelDesc.textContent = 'Управление пользователями';
    }

    // Users are already loaded via setupRealtimeListeners
    // Just render if we have users
    if (state.users.length > 0) {
        renderUsersList();
        renderProjectAccessTab();
        renderLoginHistoryTab();
        renderAdminUsersStatsPanel();
    }
}

function renderUsersList() {
    if (!elements.usersList) return;

    elements.usersList.innerHTML = '';
    elements.usersCount.textContent = `${state.users.length} ${state.users.length === 1 ? 'пользователь' : 'пользователей'}`;

    // Sort: owner first, then by name
    const sortedUsers = [...state.users].sort((a, b) => {
        const roleOrder = { owner: 0, admin: 1, moderator: 2, employee: 3, reader: 3 };
        const aOrder = roleOrder[a.orgRole] ?? 3;
        const bOrder = roleOrder[b.orgRole] ?? 3;
        if (aOrder !== bOrder) return aOrder - bOrder;

        // Compare by name (with fallbacks)
        const aName = a.firstName || a.displayName || a.email || '';
        const bName = b.firstName || b.displayName || b.email || '';
        return aName.localeCompare(bName);
    });

    sortedUsers.forEach(user => {
        const userItem = document.createElement('div');
        userItem.className = 'user-item';

        // Build full name with fallbacks
        let fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
        if (!fullName && user.displayName) {
            fullName = user.displayName;
        }
        if (!fullName) {
            // Last resort: use email prefix
            fullName = user.email ? user.email.split('@')[0] : 'Без имени';
        }

        // Build initials from fullName
        const nameParts = fullName.split(' ').filter(Boolean);
        const initials = nameParts.length >= 2
            ? (nameParts[0][0] || '') + (nameParts[1][0] || '')
            : (fullName[0] || 'U');

        const userRole = user.orgRole || 'employee';
        const isTargetOwner = userRole === 'owner';
        const isCurrentUser = user.id === state.currentUser.uid;

        // Permission checks using new system
        const canEditThisRole = canChangeUserRole(userRole) && !isCurrentUser;
        const canRemoveUser = canRemoveUserFromOrg(userRole) && !isCurrentUser;

        // Role badge
        const roleIcons = {
            owner: '<i class="fa-solid fa-crown"></i>',
            admin: '<i class="fa-solid fa-user-shield"></i>',
            moderator: '<i class="fa-solid fa-user-pen"></i>',
            employee: '<i class="fa-solid fa-user"></i>',
            reader: '<i class="fa-solid fa-user"></i>'
        };
        const roleNames = {
            owner: 'Владелец',
            admin: 'Админ',
            moderator: 'Модератор',
            employee: 'Исполнитель',
            reader: 'Исполнитель'
        };

        // Role selector - only show if user can change this role
        let roleSelector = '';
        if (canEditThisRole) {
            // Owner sees all options (admin, moderator, employee)
            // Admin only sees moderator and employee options
            const isOwner = state.orgRole === 'owner';
            roleSelector = `
                <select class="role-select" data-user-id="${user.id}" data-current-role="${userRole}">
                    ${isOwner ? `<option value="admin" ${userRole === 'admin' ? 'selected' : ''}>Админ</option>` : ''}
                    <option value="moderator" ${userRole === 'moderator' ? 'selected' : ''}>Модератор</option>
                    <option value="employee" ${userRole === 'employee' || userRole === 'reader' ? 'selected' : ''}>Исполнитель</option>
                </select>
            `;
        } else {
            roleSelector = `<span class="role-badge ${userRole}">${roleIcons[userRole]} ${roleNames[userRole]}</span>`;
        }

        const canDelete = canRemoveUser;

        // Telegram connected indicator
        const telegramIcon = user.telegramChatId ?
            '<i class="fa-brands fa-telegram" style="color: #0088cc; font-size: 0.9rem; margin-left: 0.4rem;" title="Telegram подключен"></i>' : '';

        // Avatar with profile photo support
        const avatarHtml = user.profilePhotoUrl
            ? `<div class="avatar" style="width: 40px; height: 40px; font-size: 1rem; overflow: hidden;"><img src="${escapeHtml(sanitizeAttachmentUrl(user.profilePhotoUrl))}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;"></div>`
            : `<div class="avatar" style="width: 40px; height: 40px; font-size: 1rem;">${initials.toUpperCase() || 'U'}</div>`;

        userItem.innerHTML = `
            <div class="user-info">
                ${avatarHtml}
                <div class="user-details">
                    <div class="user-name">${escapeHtml(fullName)}${telegramIcon} ${isCurrentUser ? '<span style="color: var(--text-secondary); font-size: 0.8rem;">(вы)</span>' : ''}</div>
                    <div class="user-email">${escapeHtml(user.email)}</div>
                </div>
            </div>
            <div class="user-actions" style="display: flex; align-items: center; gap: 0.75rem;">
                ${roleSelector}
                ${canDelete ? `
                    <button class="delete-user-btn" data-user-id="${user.id}" title="Удалить из организации">
                        <i class="fa-solid fa-user-xmark"></i>
                    </button>
                ` : ''}
            </div>
        `;

        // Add role change handler
        const roleSelect = userItem.querySelector('.role-select');
        if (roleSelect) {
            roleSelect.addEventListener('change', async (e) => {
                const newRole = e.target.value;
                const userId = e.target.dataset.userId;
                const oldRole = e.target.dataset.currentRole || userRole;

                // Security validation - prevent admins from setting admin role
                if (state.orgRole === 'admin' && newRole === 'admin') {
                    alert('Только владелец может назначать админов');
                    e.target.value = oldRole;
                    return;
                }

                // Prevent admins from changing admin's role
                if (state.orgRole === 'admin' && oldRole === 'admin') {
                    alert('Только владелец может изменять роль админа');
                    e.target.value = oldRole;
                    return;
                }

                try {
                    await callOrgApi('updateMemberRole', { userId, orgRole: newRole });
                    // Update the data attribute for future changes
                    e.target.dataset.currentRole = newRole;
                    playClickSound();
                } catch (error) {
                    console.error('Error updating role:', error);
                    alert('Ошибка при изменении роли');
                    e.target.value = oldRole;
                }
            });
        }

        // Add delete handler
        const deleteBtn = userItem.querySelector('.delete-user-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => {
                playClickSound();
                removeUserFromOrganization(user.id, fullName, userRole);
            });
        }

        elements.usersList.appendChild(userItem);
    });
}

function getUserDisplayName(user) {
    let fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
    if (!fullName && user.displayName) fullName = user.displayName;
    if (!fullName) fullName = user.email ? user.email.split('@')[0] : 'Без имени';
    return fullName;
}

function isUserOnline(user) {
    const lastSeen = parseDateValue(user?.lastSeenAt) || parseDateValue(user?.lastSeenClientAt);
    if (!lastSeen) return false;
    return (Date.now() - lastSeen.getTime()) <= ONLINE_WINDOW_MS;
}

function renderLoginHistoryTab() {
    if (!elements.loginUsersList || !elements.onlineUsersCount || !elements.totalUsersCount) return;

    const users = Array.isArray(state.users) ? state.users : [];
    elements.totalUsersCount.textContent = String(users.length);

    const onlineCount = users.filter(isUserOnline).length;
    elements.onlineUsersCount.textContent = String(onlineCount);

    // Sort: online first, then lastSeen desc, then name
    const sorted = [...users].sort((a, b) => {
        const aOnline = isUserOnline(a) ? 1 : 0;
        const bOnline = isUserOnline(b) ? 1 : 0;
        if (aOnline !== bOnline) return bOnline - aOnline;

        const aSeen = (parseDateValue(a?.lastSeenAt) || parseDateValue(a?.lastSeenClientAt))?.getTime() || 0;
        const bSeen = (parseDateValue(b?.lastSeenAt) || parseDateValue(b?.lastSeenClientAt))?.getTime() || 0;
        if (aSeen !== bSeen) return bSeen - aSeen;

        return getUserDisplayName(a).localeCompare(getUserDisplayName(b));
    });

    elements.loginUsersList.innerHTML = '';

    sorted.forEach(user => {
        const item = document.createElement('div');
        item.className = 'user-item';

        const fullName = getUserDisplayName(user);
        const nameParts = fullName.split(' ').filter(Boolean);
        const initials = nameParts.length >= 2
            ? (nameParts[0][0] || '') + (nameParts[1][0] || '')
            : (fullName[0] || 'U');

        const avatarHtml = user.profilePhotoUrl
            ? `<div class="avatar" style="width: 40px; height: 40px; font-size: 1rem; overflow: hidden;"><img src="${escapeHtml(sanitizeAttachmentUrl(user.profilePhotoUrl))}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;"></div>`
            : `<div class="avatar" style="width: 40px; height: 40px; font-size: 1rem;">${initials.toUpperCase() || 'U'}</div>`;

        const online = isUserOnline(user);
        const lastSeenText = formatDateTimeRu(user.lastSeenAt || user.lastSeenClientAt) || 'нет данных';
        const lastLoginText = formatDateTimeRu(user.lastLoginAt) || 'нет данных';

        const statusDot = `<span style="display:inline-block;width:8px;height:8px;border-radius:999px;margin-right:6px;vertical-align:middle;background:${online ? 'var(--success)' : 'rgba(148,163,184,0.6)'};"></span>`;
        const statusText = online
            ? `${statusDot}<span style="color: var(--success); font-weight: 700;">Онлайн</span>`
            : `${statusDot}<span style="color: var(--text-secondary);">Оффлайн</span>`;

        item.innerHTML = `
            <div class="user-info">
                ${avatarHtml}
                <div class="user-details">
                    <div class="user-name">${escapeHtml(fullName)}</div>
                    <div class="user-email">${escapeHtml(user.email || '')}</div>
                    <div style="color: var(--text-secondary); font-size: 0.85rem; margin-top: 0.25rem;">
                        ${statusText}
                        <span style="margin-left: 10px;">Активность: <strong>${escapeHtml(lastSeenText)}</strong></span>
                        <span style="margin-left: 10px;">Вход: <strong>${escapeHtml(lastLoginText)}</strong></span>
                    </div>
                </div>
            </div>
        `;

        elements.loginUsersList.appendChild(item);
    });
}

function renderAdminUsersStatsPanel() {
    if (!elements.adminUsersStatsList) return;

    const users = (Array.isArray(state.users) ? state.users : [])
        .filter(u => u.organizationId === state.organization?.id);

    // Sort by level desc, then completed tasks desc, then name
    const sorted = [...users].sort((a, b) => {
        const aLevel = getLevelFromXP(a.totalXP || 0).level;
        const bLevel = getLevelFromXP(b.totalXP || 0).level;
        if (bLevel !== aLevel) return bLevel - aLevel;

        const aCompleted = a.completedTasksCount || 0;
        const bCompleted = b.completedTasksCount || 0;
        if (bCompleted !== aCompleted) return bCompleted - aCompleted;

        return getUserDisplayName(a).localeCompare(getUserDisplayName(b));
    });

    elements.adminUsersStatsList.innerHTML = '';

    if (sorted.length === 0) {
        elements.adminUsersStatsList.innerHTML = `
            <div class="user-item" style="justify-content: center; color: var(--text-secondary);">
                Нет пользователей
            </div>
        `;
        return;
    }

    sorted.forEach(user => {
        const item = document.createElement('div');
        item.className = 'user-item';

        const fullName = getUserDisplayName(user);
        const nameParts = fullName.split(' ').filter(Boolean);
        const initials = nameParts.length >= 2
            ? (nameParts[0][0] || '') + (nameParts[1][0] || '')
            : (fullName[0] || 'U');

        const avatarHtml = user.profilePhotoUrl
            ? `<div class="avatar" style="width: 40px; height: 40px; font-size: 1rem; overflow: hidden;"><img src="${escapeHtml(sanitizeAttachmentUrl(user.profilePhotoUrl))}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;"></div>`
            : `<div class="avatar" style="width: 40px; height: 40px; font-size: 1rem;">${initials.toUpperCase() || 'U'}</div>`;

        const completed = user.completedTasksCount || 0;
        const onTime = user.onTimeTasksCount || 0;
        const noRevision = user.noRevisionTasksCount || 0;
        const onTimePercent = completed > 0 ? Math.round((onTime / completed) * 100) : 0;
        const noRevisionPercent = completed > 0 ? Math.round((noRevision / completed) * 100) : 0;

        const levelInfo = getLevelFromXP(user.totalXP || 0);

        item.innerHTML = `
            <div class="user-info">
                ${avatarHtml}
                <div class="user-details">
                    <div class="user-name">
                        ${escapeHtml(fullName)}
                        <span style="color: var(--text-secondary); font-size: 0.85rem; margin-left: 8px;">
                            Ур. ${levelInfo.level} • ${escapeHtml(levelInfo.title)}
                        </span>
                    </div>
                    <div class="user-email">${escapeHtml(user.email || '')}</div>
                </div>
            </div>
            <div class="user-actions" style="display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; justify-content: flex-end;">
                <span class="role-badge employee" style="border-color: rgba(148,163,184,0.25); background: rgba(148,163,184,0.08); color: var(--text);">
                    <i class="fa-solid fa-check"></i> ${completed}
                </span>
                <span class="role-badge employee" style="border-color: rgba(34,197,94,0.25); background: rgba(34,197,94,0.10); color: var(--text);">
                    <i class="fa-solid fa-clock"></i> ${onTimePercent}%
                </span>
                <span class="role-badge employee" style="border-color: rgba(245,158,11,0.25); background: rgba(245,158,11,0.10); color: var(--text);">
                    <i class="fa-solid fa-rotate-left"></i> ${noRevisionPercent}%
                </span>
            </div>
        `;

        elements.adminUsersStatsList.appendChild(item);
    });
}

// Remove user from organization (not delete account)
async function removeUserFromOrganization(userId, userName, targetRole = 'employee') {
    // Prevent removing yourself
    if (userId === state.currentUser?.uid) {
        alert('Вы не можете удалить себя. Используйте "Покинуть организацию".');
        return;
    }

    // Security: Admins cannot remove other admins or owner
    if (state.orgRole === 'admin' && ['admin', 'owner'].includes(targetRole)) {
        alert('Только владелец может исключить админа из организации.');
        return;
    }

    // Security: No one can remove owner
    if (targetRole === 'owner') {
        alert('Невозможно удалить владельца организации.');
        return;
    }

    if (!confirm(`Удалить ${userName} из организации?`)) return;

    try {
        // Done SERVER-SIDE (api/org 'removeMember', Admin SDK): re-checks the
        // caller's rights, clears the target's org fields + allowedProjects, and
        // decrements membersCount atomically. The client checks above are just
        // for UX; the server is the real gate.
        await callOrgApi('removeMember', { userId });
        playClickSound();
    } catch (error) {
        console.error('Error removing user:', error);
        alert('Ошибка при удалении пользователя: ' + (error.message || error));
    }
}

// Selected assignees storage
let selectedAssignees = [];

function populateAssigneeDropdown() {
    const searchInput = document.getElementById('assignee-search');
    const dropdown = document.getElementById('assignee-dropdown');
    const selectedContainer = document.getElementById('selected-assignees');

    if (!searchInput || !dropdown || !selectedContainer) return;

    // Clear previous state
    selectedAssignees = [];
    selectedContainer.innerHTML = '';
    searchInput.value = '';

    // Setup search input events
    searchInput.removeEventListener('input', handleAssigneeSearch);
    searchInput.removeEventListener('focus', handleAssigneeSearch);
    searchInput.removeEventListener('blur', handleAssigneeBlur);
    searchInput.addEventListener('input', handleAssigneeSearch);
    searchInput.addEventListener('focus', handleAssigneeSearch);
    searchInput.addEventListener('blur', handleAssigneeBlur);

    // Close dropdown when clicking outside
    document.removeEventListener('click', handleAssigneeClickOutside);
    document.addEventListener('click', handleAssigneeClickOutside);
}

function handleAssigneeBlur(e) {
    // Delay to allow click on dropdown item to register first
    setTimeout(() => {
        const dropdown = document.getElementById('assignee-dropdown');
        if (dropdown) {
            dropdown.classList.remove('active');
        }
    }, 200);
}

function handleAssigneeClickOutside(e) {
    const dropdown = document.getElementById('assignee-dropdown');
    const searchWrapper = document.querySelector('.assignee-search-wrapper');
    if (dropdown && searchWrapper && !searchWrapper.contains(e.target)) {
        dropdown.classList.remove('active');
    }
}

function handleAssigneeSearch(e) {
    const searchInput = document.getElementById('assignee-search');
    const dropdown = document.getElementById('assignee-dropdown');
    if (!searchInput || !dropdown) return;

    // Enable scrolling inside dropdown on mobile. Bind ONCE — handleAssigneeSearch
    // runs on every input/focus, and a fresh listener each time piled up.
    if (dropdown.dataset.touchmoveBound !== '1') {
        dropdown.addEventListener('touchmove', (e) => { e.stopPropagation(); }, { passive: true });
        dropdown.dataset.touchmoveBound = '1';
    }

    const query = searchInput.value.toLowerCase().trim();

    // Filter users
    const filteredUsers = state.users.filter(user => {
        // Only members with access to the current project can be assigned to its
        // tasks — hide everyone who can't see this project. owner/admin always
        // pass (full access by role). Already-assigned chips are unaffected;
        // this only limits who can be ADDED.
        if (state.activeProjectId && !userHasProjectAccess(user, state.activeProjectId)) {
            return false;
        }

        let fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
        if (!fullName && user.displayName) fullName = user.displayName;
        if (!fullName && user.email) fullName = user.email.split('@')[0];
        fullName = fullName.toLowerCase();
        const email = (user.email || '').toLowerCase();

        // Check if already selected (by uid — email is null for Telegram users)
        const isSelected = selectedAssignees.some(a => a.id === user.id);
        if (isSelected) return false;

        // If no query, show all
        if (!query) return true;

        // Search by name or email
        return fullName.includes(query) || email.includes(query);
    });

    // Render dropdown
    dropdown.innerHTML = '';

    if (filteredUsers.length === 0) {
        dropdown.innerHTML = '<div class="assignee-dropdown-empty">Не найдено</div>';
    } else {
        filteredUsers.forEach(user => {
            let fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
            if (!fullName && user.displayName) fullName = user.displayName;
            if (!fullName) fullName = user.email || 'Без имени';
            const nameParts = fullName.split(' ').filter(Boolean);
            const initials = nameParts.length >= 2
                ? (nameParts[0][0] || '') + (nameParts[1][0] || '')
                : (fullName[0] || 'U');
            const initialsUpper = initials.toUpperCase().substring(0, 2);

            // Avatar with profile photo support
            const avatarHtml = user.profilePhotoUrl
                ? `<div class="assignee-dropdown-avatar" style="overflow: hidden;"><img src="${escapeHtml(sanitizeAttachmentUrl(user.profilePhotoUrl))}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;"></div>`
                : `<div class="assignee-dropdown-avatar">${initialsUpper}</div>`;

            const item = document.createElement('div');
            item.className = 'assignee-dropdown-item';
            item.innerHTML = `
                ${avatarHtml}
                <div class="assignee-dropdown-info">
                    <div class="assignee-dropdown-name">${escapeHtml(fullName)}</div>
                    <div class="assignee-dropdown-email">${escapeHtml(user.email || '')}</div>
                </div>
            `;

            // Use mousedown to prevent blur from closing dropdown before selection (desktop)
            item.addEventListener('mousedown', (e) => {
                e.preventDefault(); // Prevent blur
                e.stopPropagation();
                addAssignee(user);
                searchInput.value = '';
                dropdown.classList.remove('active');
            });

            // Mobile: track if scrolling to prevent accidental selection
            let touchStartY = 0;
            let isScrolling = false;

            item.addEventListener('touchstart', (e) => {
                touchStartY = e.touches[0].clientY;
                isScrolling = false;
            }, { passive: true });

            item.addEventListener('touchmove', (e) => {
                const touchMoveY = e.touches[0].clientY;
                const deltaY = Math.abs(touchMoveY - touchStartY);
                // If moved more than 10px, it's a scroll
                if (deltaY > 10) {
                    isScrolling = true;
                }
            }, { passive: true });

            item.addEventListener('touchend', (e) => {
                // Only select if it wasn't a scroll
                if (!isScrolling) {
                    e.preventDefault();
                    e.stopPropagation();
                    addAssignee(user);
                    searchInput.value = '';
                    dropdown.classList.remove('active');
                }
            });

            dropdown.appendChild(item);
        });
    }

    dropdown.classList.add('active');
}

function addAssignee(user) {
    let fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
    if (!fullName && user.displayName) fullName = user.displayName;
    if (!fullName) fullName = user.email || 'Без имени';

    // Check if already added (by uid — email is null for Telegram users)
    if (selectedAssignees.some(a => a.id === user.id)) return;

    selectedAssignees.push({
        id: user.id,
        email: user.email || null,
        name: fullName
    });

    renderSelectedAssignees();
}

// Remove by index: two Telegram users both have email=null, so removing by
// email would drop all of them at once.
function removeAssigneeAt(index) {
    selectedAssignees.splice(index, 1);
    renderSelectedAssignees();

    // Update dropdown if it's open to show removed user again
    const dropdown = document.getElementById('assignee-dropdown');
    if (dropdown && dropdown.classList.contains('active')) {
        handleAssigneeSearch();
    }
}

function renderSelectedAssignees() {
    const container = document.getElementById('selected-assignees');
    if (!container) return;

    container.innerHTML = '';

    selectedAssignees.forEach((assignee, index) => {
        const initials = (assignee.name || '?').split(' ').map(n => n[0] || '').join('').toUpperCase().substring(0, 2);

        // Resolve the user by uid first (email is null for Telegram users).
        const user = state.users.find(u =>
            (assignee.id && u.id === assignee.id) ||
            (assignee.email && (u.email || '').toLowerCase() === assignee.email.toLowerCase())
        );

        const chip = document.createElement('div');
        chip.className = 'assignee-chip';

        const avatar = document.createElement('div');
        avatar.className = 'assignee-chip-avatar';
        if (user?.profilePhotoUrl) {
            avatar.style.overflow = 'hidden';
            const img = document.createElement('img');
            img.src = sanitizeAttachmentUrl(user.profilePhotoUrl);
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;';
            avatar.appendChild(img);
        } else {
            avatar.textContent = initials;
        }

        const nameSpan = document.createElement('span');
        nameSpan.textContent = assignee.name;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'assignee-chip-remove';
        removeBtn.setAttribute('aria-label', 'Убрать исполнителя');
        const xIcon = document.createElement('i');
        xIcon.className = 'fa-solid fa-xmark';
        removeBtn.appendChild(xIcon);
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeAssigneeAt(index);
        });

        chip.appendChild(avatar);
        chip.appendChild(nameSpan);
        chip.appendChild(removeBtn);
        container.appendChild(chip);
    });
}

// Rebuild the assignee picker from a task when editing. Prefer assigneeIds
// (uid) — Telegram-login assignees have no email, so rebuilding from
// assigneeEmail alone silently dropped them and a subsequent save wiped the
// assignees. Falls back to email/name for legacy tasks without assigneeIds.
function setSelectedAssignees(task) {
    selectedAssignees = [];
    if (!task) { renderSelectedAssignees(); return; }

    const ids = Array.isArray(task.assigneeIds) ? task.assigneeIds.filter(Boolean) : [];
    const nameList = (task.assignee || '').split(',').map(n => n.trim()).filter(Boolean);
    const emailList = (task.assigneeEmail || '').split(',').map(e => e.trim()).filter(Boolean);

    if (ids.length > 0) {
        ids.forEach((uid, index) => {
            const user = state.users.find(u => u.id === uid);
            const name = user
                ? (`${user.firstName || ''} ${user.lastName || ''}`.trim() || user.displayName || user.email || nameList[index] || 'Исполнитель')
                : (nameList[index] || 'Исполнитель');
            selectedAssignees.push({ id: uid, email: user?.email || emailList[index] || null, name });
        });
    } else if (emailList.length > 0) {
        emailList.forEach((email, index) => {
            const user = state.users.find(u => (u.email || '').toLowerCase() === email.toLowerCase());
            selectedAssignees.push({ id: user?.id || null, email, name: nameList[index] || email });
        });
    } else if (nameList.length > 0) {
        // Oldest tasks: only names stored. Resolve to a user by full name if possible.
        nameList.forEach(name => {
            const user = state.users.find(u => `${u.firstName || ''} ${u.lastName || ''}`.trim() === name);
            selectedAssignees.push({ id: user?.id || null, email: user?.email || null, name });
        });
    }

    renderSelectedAssignees();
}

function getSelectedAssignees() {
    return {
        names: selectedAssignees.map(a => a.name).join(', ') || 'Не назначен',
        // Filter out null/empty emails (Telegram-login assignees have none) so we
        // don't store stray "," segments in assigneeEmail. Identity is carried by
        // assigneeIds; assigneeEmail is only a legacy convenience field.
        emails: selectedAssignees.map(a => a.email).filter(Boolean).join(',')
    };
}

// ========== CO-CREATOR PICKER (доп. постановщики) ==========
// Зеркало пикера ответственных: те же классы/поведение, свой стор и свои
// element id. Доп. постановщик получает уведомления постановщика и право
// принять / вернуть на доработку (см. canActAsTaskCreator + firestore.rules).
let selectedCoCreators = [];

function populateCoCreatorDropdown() {
    const searchInput = document.getElementById('cocreator-search');
    const dropdown = document.getElementById('cocreator-dropdown');
    const selectedContainer = document.getElementById('selected-cocreators');
    if (!searchInput || !dropdown || !selectedContainer) return;

    selectedCoCreators = [];
    selectedContainer.innerHTML = '';
    searchInput.value = '';

    searchInput.removeEventListener('input', handleCoCreatorSearch);
    searchInput.removeEventListener('focus', handleCoCreatorSearch);
    searchInput.removeEventListener('blur', handleCoCreatorBlur);
    searchInput.addEventListener('input', handleCoCreatorSearch);
    searchInput.addEventListener('focus', handleCoCreatorSearch);
    searchInput.addEventListener('blur', handleCoCreatorBlur);

    document.removeEventListener('click', handleCoCreatorClickOutside);
    document.addEventListener('click', handleCoCreatorClickOutside);
}

function handleCoCreatorBlur() {
    setTimeout(() => {
        const dropdown = document.getElementById('cocreator-dropdown');
        if (dropdown) dropdown.classList.remove('active');
    }, 200);
}

function handleCoCreatorClickOutside(e) {
    const dropdown = document.getElementById('cocreator-dropdown');
    const searchWrapper = document.querySelector('.cocreator-search-wrapper');
    if (dropdown && searchWrapper && !searchWrapper.contains(e.target)) {
        dropdown.classList.remove('active');
    }
}

function handleCoCreatorSearch() {
    const searchInput = document.getElementById('cocreator-search');
    const dropdown = document.getElementById('cocreator-dropdown');
    if (!searchInput || !dropdown) return;

    if (dropdown.dataset.touchmoveBound !== '1') {
        dropdown.addEventListener('touchmove', (e) => { e.stopPropagation(); }, { passive: true });
        dropdown.dataset.touchmoveBound = '1';
    }

    const query = searchInput.value.toLowerCase().trim();
    const filteredUsers = state.users.filter(user => {
        if (state.activeProjectId && !userHasProjectAccess(user, state.activeProjectId)) return false;
        // Основной постановщик — текущий пользователь; в доп. не предлагаем.
        if (user.id === state.currentUser?.uid) return false;
        if (selectedCoCreators.some(c => c.id === user.id)) return false;

        let fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
        if (!fullName && user.displayName) fullName = user.displayName;
        if (!fullName && user.email) fullName = user.email.split('@')[0];
        fullName = fullName.toLowerCase();
        const email = (user.email || '').toLowerCase();
        if (!query) return true;
        return fullName.includes(query) || email.includes(query);
    });

    dropdown.innerHTML = '';
    if (filteredUsers.length === 0) {
        dropdown.innerHTML = '<div class="assignee-dropdown-empty">Не найдено</div>';
    } else {
        filteredUsers.forEach(user => {
            let fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
            if (!fullName && user.displayName) fullName = user.displayName;
            if (!fullName) fullName = user.email || 'Без имени';
            const nameParts = fullName.split(' ').filter(Boolean);
            const initials = (nameParts.length >= 2
                ? (nameParts[0][0] || '') + (nameParts[1][0] || '')
                : (fullName[0] || 'U')).toUpperCase().substring(0, 2);
            const avatarHtml = user.profilePhotoUrl
                ? `<div class="assignee-dropdown-avatar" style="overflow: hidden;"><img src="${escapeHtml(sanitizeAttachmentUrl(user.profilePhotoUrl))}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;"></div>`
                : `<div class="assignee-dropdown-avatar">${initials}</div>`;

            const item = document.createElement('div');
            item.className = 'assignee-dropdown-item';
            item.innerHTML = `
                ${avatarHtml}
                <div class="assignee-dropdown-info">
                    <div class="assignee-dropdown-name">${escapeHtml(fullName)}</div>
                    <div class="assignee-dropdown-email">${escapeHtml(user.email || '')}</div>
                </div>
            `;
            item.addEventListener('mousedown', (e) => {
                e.preventDefault();
                e.stopPropagation();
                addCoCreator(user);
                searchInput.value = '';
                dropdown.classList.remove('active');
            });

            let touchStartY = 0;
            let isScrolling = false;
            item.addEventListener('touchstart', (e) => {
                touchStartY = e.touches[0].clientY;
                isScrolling = false;
            }, { passive: true });
            item.addEventListener('touchmove', (e) => {
                if (Math.abs(e.touches[0].clientY - touchStartY) > 10) isScrolling = true;
            }, { passive: true });
            item.addEventListener('touchend', (e) => {
                if (!isScrolling) {
                    e.preventDefault();
                    e.stopPropagation();
                    addCoCreator(user);
                    searchInput.value = '';
                    dropdown.classList.remove('active');
                }
            });

            dropdown.appendChild(item);
        });
    }
    dropdown.classList.add('active');
}

function addCoCreator(user) {
    let fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
    if (!fullName && user.displayName) fullName = user.displayName;
    if (!fullName) fullName = user.email || 'Без имени';
    if (selectedCoCreators.some(c => c.id === user.id)) return;
    selectedCoCreators.push({ id: user.id, email: user.email || null, name: fullName });
    renderSelectedCoCreators();
}

function removeCoCreatorAt(index) {
    selectedCoCreators.splice(index, 1);
    renderSelectedCoCreators();
    const dropdown = document.getElementById('cocreator-dropdown');
    if (dropdown && dropdown.classList.contains('active')) handleCoCreatorSearch();
}

function renderSelectedCoCreators() {
    const container = document.getElementById('selected-cocreators');
    if (!container) return;
    container.innerHTML = '';
    selectedCoCreators.forEach((coCreator, index) => {
        const initials = (coCreator.name || '?').split(' ').map(n => n[0] || '').join('').toUpperCase().substring(0, 2);
        const user = state.users.find(u => coCreator.id && u.id === coCreator.id);

        const chip = document.createElement('div');
        chip.className = 'assignee-chip';

        const avatar = document.createElement('div');
        avatar.className = 'assignee-chip-avatar';
        if (user?.profilePhotoUrl) {
            avatar.style.overflow = 'hidden';
            const img = document.createElement('img');
            img.src = sanitizeAttachmentUrl(user.profilePhotoUrl);
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;';
            avatar.appendChild(img);
        } else {
            avatar.textContent = initials;
        }

        const nameSpan = document.createElement('span');
        nameSpan.textContent = coCreator.name;

        const removeBtn = document.createElement('button');
        removeBtn.type = 'button';
        removeBtn.className = 'assignee-chip-remove';
        removeBtn.setAttribute('aria-label', 'Убрать постановщика');
        const xIcon = document.createElement('i');
        xIcon.className = 'fa-solid fa-xmark';
        removeBtn.appendChild(xIcon);
        removeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeCoCreatorAt(index);
        });

        chip.appendChild(avatar);
        chip.appendChild(nameSpan);
        chip.appendChild(removeBtn);
        container.appendChild(chip);
    });
}

// Восстановление доп. постановщиков при редактировании (uid-first, как и у
// исполнителей: у Telegram-пользователей нет email).
function setSelectedCoCreators(task) {
    selectedCoCreators = [];
    if (!task) { renderSelectedCoCreators(); return; }
    const ids = Array.isArray(task.coCreatorIds) ? task.coCreatorIds.filter(Boolean) : [];
    const nameList = (task.coCreators || '').split(',').map(n => n.trim()).filter(Boolean);
    ids.forEach((uid, index) => {
        const user = state.users.find(u => u.id === uid);
        const name = user
            ? (`${user.firstName || ''} ${user.lastName || ''}`.trim() || user.displayName || user.email || nameList[index] || 'Постановщик')
            : (nameList[index] || 'Постановщик');
        selectedCoCreators.push({ id: uid, email: user?.email || null, name });
    });
    renderSelectedCoCreators();
}

// Является ли текущий пользователь доп. постановщиком задачи
function isCurrentUserCoCreator(task) {
    const uid = state.currentUser?.uid;
    return !!uid && Array.isArray(task?.coCreatorIds) && task.coCreatorIds.includes(uid);
}

// Право действовать как постановщик задачи: менеджер проекта (owner/admin/
// moderator) ИЛИ доп. постановщик этой задачи (независимо от орг-роли).
function canActAsTaskCreator(task) {
    return canManageTasks() || isCurrentUserCoCreator(task);
}

// ========== XP AND LEVEL SYSTEM ==========
const XP_CONFIG = {
    baseTaskXP: 10,        // Base XP for completing a task
    onTimeBonus: 5,        // Bonus XP for completing on time
    revisionPenalty: 3,    // XP penalty for task returned for revision
    levels: [
        { level: 1, xpRequired: 0, title: 'Новичок' },
        { level: 2, xpRequired: 50, title: 'Стажёр' },
        { level: 3, xpRequired: 150, title: 'Специалист' },
        { level: 4, xpRequired: 300, title: 'Профессионал' },
        { level: 5, xpRequired: 500, title: 'Эксперт' },
        { level: 6, xpRequired: 800, title: 'Мастер' },
        { level: 7, xpRequired: 1200, title: 'Легенда' }
    ]
};

function getLevelFromXP(xp) {
    let currentLevel = XP_CONFIG.levels[0];
    for (const level of XP_CONFIG.levels) {
        if (xp >= level.xpRequired) {
            currentLevel = level;
        } else {
            break;
        }
    }
    return currentLevel;
}

function getNextLevelXP(currentXP) {
    const currentLevel = getLevelFromXP(currentXP);
    const nextLevel = XP_CONFIG.levels.find(l => l.level === currentLevel.level + 1);
    return nextLevel ? nextLevel.xpRequired : currentLevel.xpRequired;
}

function calculateXPProgress(currentXP) {
    const currentLevel = getLevelFromXP(currentXP);
    const nextLevel = XP_CONFIG.levels.find(l => l.level === currentLevel.level + 1);

    if (!nextLevel) return 100; // Max level

    const xpInCurrentLevel = currentXP - currentLevel.xpRequired;
    const xpNeededForNext = nextLevel.xpRequired - currentLevel.xpRequired;

    return Math.floor((xpInCurrentLevel / xpNeededForNext) * 100);
}

// XP / stats awarding moved SERVER-SIDE — see api/award-xp.js, called from the
// task-approval flow (updateTaskSubStatus, newSubStatus === 'done'). It runs
// under the Admin SDK because the users rules now lock
// totalXP/level/completedTasksCount/onTimeTasksCount/noRevisionTasksCount
// against client writes. Do NOT reintroduce a client-side writer: it would fail
// the rules and could double-credit (the server award is transactional +
// idempotent via task.xpProcessed). getLevelFromXP/getNextLevelXP below stay —
// they are read-only helpers used to render level/progress in the UI.

// ========== TELEGRAM NOTIFICATIONS ==========

// Send Telegram notification via server-side endpoint (bot token stays server-only)
// Событие задачи участнику ПО UID: сервер (api/notify-telegram) сам решает
// доставку — Telegram (если чат привязан) + мобильный push + email Google + запись в ленту
// agentNotifications с типом события (task_created / task_completed /
// task_revision / task_done) и taskId/projectId для перехода к задаче.
async function sendTaskEventToUid(recipientUid, text, event) {
    if (!recipientUid) return;
    const currentUser = firebase.auth().currentUser;
    if (!currentUser) return;
    try {
        const idToken = await currentUser.getIdToken();
        await fetch('/api/notify-telegram', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ recipientUid, text, parseMode: 'HTML', event })
        });
    } catch (error) {
        console.error('Error sending task event notification:', error);
    }
}

async function sendTelegramNotification(chatId, message, event = null) {
    if (!chatId) return;

    // Fire-and-forget: the endpoint now requires an authenticated, org-scoped
    // caller. If there's no signed-in user (or getIdToken() fails), just skip
    // the notification rather than blocking whatever action triggered it.
    const currentUser = firebase.auth().currentUser;
    if (!currentUser) return;

    try {
        const idToken = await currentUser.getIdToken();
        const response = await fetch('/api/notify-telegram', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({
                chatId,
                text: message,
                parseMode: 'HTML',
                ...(event ? { event } : {})
            })
        });

        const result = await response.json();
        if (result.ok) {
            console.log('Telegram notification sent successfully');
        } else {
            console.error('Telegram notification failed:', result.error || result.description);
        }
    } catch (error) {
        console.error('Telegram notification error:', error);
    }
}

// Resolves a picked assignee ({id, email, name}) to their Telegram chat id.
// Telegram-login users have no email, so the uid is the only reliable key —
// email is kept as a fallback for legacy/email-login accounts.
function resolveAssigneeChatId(assignee) {
    if (!assignee) return null;
    let user = null;
    if (assignee.id) user = state.users.find(u => u.id === assignee.id);
    if (!user && assignee.email) {
        user = state.users.find(u => u.email?.toLowerCase() === assignee.email.toLowerCase());
    }
    return user?.telegramChatId || null;
}

// Notifies one assignee about a newly created task. Resolves the recipient by
// uid first (so self-assignment by a Telegram user actually delivers), then
// email. Fire-and-forget; missing chat id just means the user hasn't linked
// Telegram yet.
async function sendNewTaskNotificationToAssignee(assignee, taskTitle, projectName, deadline) {
    const chatId = resolveAssigneeChatId(assignee);
    if (!chatId) return;

    const message = `📋 <b>Новая задача!</b>

<b>Задача:</b> ${escapeHtmlForTelegram(taskTitle)}
<b>Проект:</b> ${escapeHtmlForTelegram(projectName)}
<b>Срок:</b> ${deadline ? formatDate(deadline) : 'Не указан'}

Откройте ProjectMan для подробностей.`;

    await sendTelegramNotification(chatId, message);
}

// Returns the Telegram chatIds of all assignees of a task. Resolves by uid
// (assigneeIds) first — the only reliable key for Telegram-login users — and
// falls back to email only for legacy tasks that predate assigneeIds.
function taskAssigneeChatIds(task) {
    const chatIds = new Set();
    (task.assigneeIds || []).forEach(uid => {
        const chatId = resolveAssigneeChatId({ id: uid });
        if (chatId) chatIds.add(chatId);
    });
    if ((!task.assigneeIds || task.assigneeIds.length === 0) && task.assigneeEmail) {
        task.assigneeEmail.split(',').forEach(email => {
            const chatId = resolveAssigneeChatId({ email: email.trim() });
            if (chatId) chatIds.add(chatId);
        });
    }
    return [...chatIds];
}

// Send revision notification via Telegram (chatId resolved by caller via uid)
async function sendTelegramRevisionNotification(chatId, taskTitle, revisionReason, returnedBy) {
    if (!chatId) return;

    const message = `🔄 <b>Задача возвращена на доработку</b>

<b>Задача:</b> ${escapeHtmlForTelegram(taskTitle)}

<b>Причина:</b>
${escapeHtmlForTelegram(revisionReason)}

<b>Вернул:</b> ${escapeHtmlForTelegram(returnedBy)}

Пожалуйста, внесите изменения и отправьте на проверку.`;

    await sendTelegramNotification(chatId, message);
}

// Client-side deadline reminders were RETIRED. The per-task Telegram
// reminder helpers (deadline / take-into-work / overdue) and the client
// reminder sweep that called them lived here. They only worked while a
// manager had a tab open and messaged the assignee only. Replaced by the
// server-side api/agent-monitor (Vercel cron daily + GitHub Actions hourly):
// it notifies the assignee AND the task creator, writes the in-app
// agentNotifications feed, duplicates to Telegram, and de-dups via
// notifiedOverdueOn / notifiedDeadlineSoonAt / notifiedNotTakenAt flags.
// Do NOT reintroduce a client-side sweep — it would double every message.

// Escape HTML for Telegram
function escapeHtmlForTelegram(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// ========================================
// PROJECT ACCESS CONTROL (organized BY PROJECT)
// ========================================
// Model: users/{uid}.allowedProjects is the list of project ids a member may
// see. An ABSENT or EMPTY array means "all projects" (default for freshly
// joined members). owner/admin always see everything by role (see
// getFilteredProjects + firestore rules), so their array is irrelevant and we
// don't manage them here.
//
// Because [] already means "all", we can't express "no access at all" with an
// empty array — clearing a member's last project would flip them to full
// access. We store a sentinel id (matches no real project) to mean "none".
const NO_ACCESS_SENTINEL = '__no_access__';

// Which project rows are expanded — preserved across live re-renders so the
// accordion doesn't collapse every time an access change streams back.
const expandedAccessProjects = new Set();

const ACCESS_ROLE_LABELS = {
    owner: 'Владелец',
    admin: 'Администратор',
    moderator: 'Модератор',
    employee: 'Исполнитель',
    reader: 'Исполнитель',
};

function accessRoleLabel(orgRole) {
    return ACCESS_ROLE_LABELS[orgRole] || 'Исполнитель';
}

// owner/admin see every project by role — access list doesn't apply to them.
function hasFullAccessByRole(user) {
    return ['owner', 'admin'].includes(user.orgRole);
}

// Does this member currently have access to the given project?
function userHasProjectAccess(user, projectId) {
    if (hasFullAccessByRole(user)) return true;
    const ap = user.allowedProjects;
    if (!Array.isArray(ap) || ap.length === 0) return true; // empty/absent = all
    return ap.includes(projectId);
}

// A member's effective EXPLICIT list of real project ids: expands the "all"
// default into every current project id and drops the sentinel + stale ids.
function effectiveAllowedIds(user) {
    const ap = user.allowedProjects;
    if (!Array.isArray(ap) || ap.length === 0) {
        return state.projects.map(p => p.id); // "all" -> explicit full list
    }
    return ap.filter(id => id !== NO_ACCESS_SENTINEL && state.projects.some(p => p.id === id));
}

async function writeAllowedProjects(userId, ids) {
    try {
        await callOrgApi('updateMemberAccess', { userId, allowedProjects: ids });
        // The membership listener re-renders the tab automatically.
    } catch (error) {
        console.error('Error updating project access:', error);
        alert('Ошибка при изменении доступа: ' + (error.message || error));
    }
}

async function grantProjectAccess(userId, projectId) {
    const user = state.users.find(u => u.id === userId);
    if (!user) return;
    const ids = effectiveAllowedIds(user);
    if (!ids.includes(projectId)) ids.push(projectId);
    await writeAllowedProjects(userId, ids);
}

async function revokeProjectAccess(userId, projectId) {
    const user = state.users.find(u => u.id === userId);
    if (!user) return;
    let ids = effectiveAllowedIds(user).filter(id => id !== projectId);
    // An empty list would read back as "all" — store the sentinel to mean "none".
    if (ids.length === 0) ids = [NO_ACCESS_SENTINEL];
    await writeAllowedProjects(userId, ids);
}

function accessUserDisplayName(user) {
    let name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
    if (!name && user.displayName) name = user.displayName;
    if (!name && user.email) name = user.email.split('@')[0];
    return name || 'Без имени';
}

function accessUserInitials(user) {
    const init = (((user.firstName || '')[0] || '') + ((user.lastName || '')[0] || '')).toUpperCase();
    return init || (accessUserDisplayName(user)[0] || 'U').toUpperCase();
}

// One member row (avatar + name + role + action) built via DOM — never
// innerHTML with user-controlled data.
function buildAccessMemberRow(user, projectId, mode) {
    const row = document.createElement('div');
    row.className = 'access-member-row';

    const avatar = document.createElement('div');
    avatar.className = 'access-member-avatar';
    if (user.profilePhotoUrl) {
        const img = document.createElement('img');
        img.src = sanitizeAttachmentUrl(user.profilePhotoUrl);
        img.alt = '';
        avatar.appendChild(img);
    } else {
        avatar.textContent = accessUserInitials(user);
    }
    row.appendChild(avatar);

    const info = document.createElement('div');
    info.className = 'access-member-info';
    const nm = document.createElement('div');
    nm.className = 'access-member-name';
    nm.textContent = accessUserDisplayName(user);
    const role = document.createElement('div');
    role.className = 'access-member-role';
    role.textContent = accessRoleLabel(user.orgRole);
    info.appendChild(nm);
    info.appendChild(role);
    row.appendChild(info);

    if (mode === 'full') {
        const badge = document.createElement('span');
        badge.className = 'access-full-badge';
        badge.textContent = 'полный доступ';
        row.appendChild(badge);
    } else {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = mode === 'has' ? 'access-remove-btn' : 'access-add-btn';
        btn.textContent = mode === 'has' ? '− Убрать' : '+ Добавить';
        btn.onclick = () => {
            playClickSound();
            if (mode === 'has') revokeProjectAccess(user.id, projectId);
            else grantProjectAccess(user.id, projectId);
        };
        row.appendChild(btn);
    }
    return row;
}

function buildAccessColumn(kind, members, projectId) {
    const col = document.createElement('div');
    col.className = 'access-col';

    const head = document.createElement('div');
    head.className = 'access-col-head ' + (kind === 'has' ? 'has' : 'no');
    head.textContent = (kind === 'has' ? 'Есть доступ' : 'Нет доступа') + ` (${members.length})`;
    col.appendChild(head);

    if (members.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'access-col-empty';
        empty.textContent = kind === 'has' ? 'Никто' : 'Все имеют доступ';
        col.appendChild(empty);
        return col;
    }

    members.forEach(u => {
        const mode = kind === 'has' ? (hasFullAccessByRole(u) ? 'full' : 'has') : 'add';
        col.appendChild(buildAccessMemberRow(u, projectId, mode));
    });
    return col;
}

// Render the whole "Доступ к проектам" tab: one accordion row per project, each
// expanding into "has access" / "no access" columns.
function renderProjectAccessTab() {
    const container = elements.projectAccessList;
    if (!container) return;
    container.innerHTML = '';

    if (state.projects.length === 0) {
        const p = document.createElement('p');
        p.className = 'access-empty';
        p.textContent = 'В организации пока нет проектов.';
        container.appendChild(p);
        return;
    }

    const members = [...state.users].sort((a, b) =>
        accessUserDisplayName(a).localeCompare(accessUserDisplayName(b), 'ru'));

    state.projects.forEach(project => {
        const withAccess = [];
        const withoutAccess = [];
        members.forEach(u => {
            if (userHasProjectAccess(u, project.id)) withAccess.push(u);
            else withoutAccess.push(u);
        });

        const isOpen = expandedAccessProjects.has(project.id);
        const card = document.createElement('div');
        card.className = 'access-project-card';

        const header = document.createElement('button');
        header.type = 'button';
        header.className = 'access-project-header' + (isOpen ? ' open' : '');

        const titleWrap = document.createElement('div');
        titleWrap.className = 'access-project-title';
        const chev = document.createElement('i');
        chev.className = 'fa-solid fa-chevron-right access-chevron';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'access-project-name';
        nameSpan.textContent = project.name;
        titleWrap.appendChild(chev);
        titleWrap.appendChild(nameSpan);

        const count = document.createElement('span');
        count.className = 'access-project-count';
        count.textContent = `${withAccess.length} из ${members.length}`;

        header.appendChild(titleWrap);
        header.appendChild(count);
        header.onclick = () => {
            playClickSound();
            if (expandedAccessProjects.has(project.id)) expandedAccessProjects.delete(project.id);
            else expandedAccessProjects.add(project.id);
            renderProjectAccessTab();
        };
        card.appendChild(header);

        if (isOpen) {
            const body = document.createElement('div');
            body.className = 'access-project-body';
            body.appendChild(buildAccessColumn('has', withAccess, project.id));
            body.appendChild(buildAccessColumn('no', withoutAccess, project.id));
            card.appendChild(body);
        }

        container.appendChild(card);
    });
}

// ========================================
// MY TASKS FUNCTIONALITY
// ========================================

// Fetch all tasks where current user is assignee
async function fetchMyTasks() {
    if (!state.currentUser) return [];

    const myTasks = [];
    const userUid = state.currentUser.uid;
    const userEmail = state.currentUser.email?.toLowerCase();
    const userFullName = state.currentUser.fullName ||
        `${state.currentUser.firstName || ''} ${state.currentUser.lastName || ''}`.trim();

    try {
        // Get all projects user has access to
        const accessibleProjects = getFilteredProjects();

        // Fetch all projects in PARALLEL for speed
        const projectPromises = accessibleProjects.map(project =>
            db.collection('tasks')
                .where('projectId', '==', project.id)
                .get()
                .then(snapshot => ({ project, snapshot }))
        );

        const results = await Promise.all(projectPromises);

        // Process all results
        results.forEach(({ project, snapshot }) => {
            snapshot.forEach(doc => {
                const task = { id: doc.id, ...doc.data() };
                let isAssignee = false;

                // Match by uid first (Telegram-login users have no email)
                if (userUid && Array.isArray(task.assigneeIds) && task.assigneeIds.includes(userUid)) {
                    isAssignee = true;
                }

                // Fallback: email (legacy tasks)
                if (!isAssignee && userEmail && task.assigneeEmail) {
                    const assigneeEmails = task.assigneeEmail.toLowerCase().split(',');
                    isAssignee = assigneeEmails.map(e => e.trim()).includes(userEmail);
                }

                // Fallback: full name (oldest tasks)
                if (!isAssignee && userFullName && task.assignee) {
                    const assigneeNames = task.assignee.split(',').map(n => n.trim());
                    isAssignee = assigneeNames.includes(userFullName);
                }

                // Only add tasks that are NOT in archive (status !== 'done')
                if (isAssignee && task.status !== 'done') {
                    myTasks.push({
                        ...task,
                        projectName: project.name,
                        projectId: project.id
                    });
                }
            });
        });

        // Sort by deadline (closest first)
        myTasks.sort((a, b) => {
            const dateA = a.deadline ? new Date(a.deadline) : new Date('9999-12-31');
            const dateB = b.deadline ? new Date(b.deadline) : new Date('9999-12-31');
            return dateA - dateB;
        });

    } catch (error) {
        console.error('Error fetching my tasks:', error);
    }

    return myTasks;
}

// Open My Tasks modal and load tasks
async function openMyTasksModal() {
    elements.myTasksModal.classList.add('active');
    elements.myTasksList.classList.remove('my-tasks-board');
    elements.myTasksList.innerHTML = `
        <div class="my-tasks-loading" role="status" aria-label="Загрузка задач">
            <div class="my-tasks-spinner" aria-hidden="true"></div>
        </div>
    `;

    const tasks = await fetchMyTasks();
    renderMyTasks(tasks);
}

// Render tasks in the My Tasks modal — полноэкранная мини-доска: три колонки
// по статусам (Назначенные / В работе / На проверке). Это настоящие карточки
// доски: статус, информация, файлы, перенос срока, редактирование и удаление
// работают прямо здесь, без перехода в проект.
const MY_TASKS_COLUMNS = [
    { key: 'assigned', title: 'Назначенные', icon: 'fa-circle-exclamation', cls: 'col-assigned' },
    { key: 'in-progress', title: 'В работе', icon: 'fa-person-digging', cls: 'col-in-progress' },
    { key: 'review', title: 'На проверке', icon: 'fa-clock', cls: 'col-review' },
];

let myTasksModalTasks = [];
let myTasksRefreshPromise = null;

function findLoadedTask(taskId) {
    return state.tasks.find(task => task.id === taskId) ||
        myTasksModalTasks.find(task => task.id === taskId) || null;
}

async function refreshMyTasksModalIfOpen() {
    if (!elements.myTasksModal?.classList.contains('active')) return;
    if (myTasksRefreshPromise) return myTasksRefreshPromise;
    myTasksRefreshPromise = fetchMyTasks()
        .then(renderMyTasks)
        .finally(() => { myTasksRefreshPromise = null; });
    return myTasksRefreshPromise;
}

function renderMyTasks(tasks) {
    const container = elements.myTasksList;
    myTasksModalTasks = Array.isArray(tasks) ? tasks : [];
    container.classList.remove('my-tasks-board');
    if (myTasksModalTasks.length === 0) {
        container.innerHTML = `
            <div class="my-tasks-empty">
                <i class="fa-solid fa-clipboard-check"></i>
                <p>У вас нет назначенных задач</p>
            </div>
        `;
        return;
    }

    container.innerHTML = '';
    container.classList.add('my-tasks-board');

    MY_TASKS_COLUMNS.forEach(col => {
        const colTasks = myTasksModalTasks.filter(task => boardViewForTask(task) === col.key);

        const colEl = document.createElement('div');
        colEl.className = `my-tasks-col ${col.cls}`;

        const header = document.createElement('div');
        header.className = `my-tasks-col-header ${col.cls}`;
        header.innerHTML = `<i class="fa-solid ${col.icon}"></i> <span>${col.title}</span>`;
        const count = document.createElement('span');
        count.className = 'my-tasks-col-count';
        count.textContent = String(colTasks.length);
        header.appendChild(count);
        colEl.appendChild(header);

        const list = document.createElement('div');
        list.className = 'my-tasks-col-list';

        if (colTasks.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'my-tasks-col-empty';
            empty.textContent = 'Нет задач';
            list.appendChild(empty);
        }

        colTasks.forEach(task => {
            const wrap = document.createElement('div');
            wrap.className = 'my-kanban-card-wrap';
            wrap.dataset.projectId = task.projectId;
            wrap.dataset.taskId = task.id;

            const projectChip = document.createElement('div');
            projectChip.className = 'my-task-project-chip';
            const folderIcon = document.createElement('i');
            folderIcon.className = 'fa-solid fa-folder';
            projectChip.appendChild(folderIcon);
            projectChip.appendChild(document.createTextNode(' ' + (task.projectName || 'Проект')));
            wrap.appendChild(projectChip);

            const card = createTaskCard(task);
            card.classList.add('my-tasks-kanban-card');
            wrap.appendChild(card);

            list.appendChild(wrap);
        });

        colEl.appendChild(list);
        container.appendChild(colEl);
    });
}

// Maps a task to its active board column, or to the separate completed archive.
function boardViewForTask(task) {
    if (!task) return 'assigned';
    if (task.status === 'done') return 'done';
    const sub = task.subStatus || (task.assigneeCompleted ? 'completed' : 'assigned');
    if (sub === 'completed') return 'review';
    if (sub === 'in_work') return 'in-progress';
    return 'assigned';
}

// Navigate to project containing the task, opening the task's own status column
function navigateToTask(projectId, taskId, boardView) {
    // Close modal
    elements.myTasksModal.classList.remove('active');
    elements.taskArchiveModal?.classList.remove('active');

    // Close sidebar on mobile
    if (window.innerWidth <= 768) {
        elements.sidebar.classList.remove('active');
        if (elements.sidebarOverlay) {
            elements.sidebarOverlay.classList.remove('active');
        }
    }

    // Select the project (this resets the board view to "assigned")...
    selectProject(projectId);
    // The Gantt view has no per-status columns to land on — always switch
    // back to kanban so the highlighted card is actually visible.
    setProjectView('kanban');

    // Finished tasks no longer live in the active workflow. Open their archive
    // card instead of trying to select a removed "Готово" column.
    if (boardView === 'done') {
        openTaskArchiveModal(taskId);
        return;
    }

    // ...so switch to the task's actual status section AFTER selecting. On
    // mobile only the active column is shown, so this is what makes the task
    // visible instead of an empty "Назначенные" list.
    if (boardView) setBoardView(boardView);

    // Highlight the task briefly after loading
    setTimeout(() => {
        const taskCard = document.querySelector(`[data-task-id="${taskId}"]`);
        if (taskCard) {
            taskCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            taskCard.classList.add('highlight-task');
            setTimeout(() => {
                taskCard.classList.remove('highlight-task');
            }, 2000);
        }
    }, 500);
}

// Update My Tasks count badge
async function updateMyTasksCount() {
    if (!state.currentUser || !elements.myTasksCount) return;

    const tasks = await fetchMyTasks();
    // Count only active tasks (not completed in archive)
    const activeTasks = tasks.filter(t => t.status !== 'done');

    if (activeTasks.length > 0) {
        elements.myTasksCount.textContent = activeTasks.length;
        elements.myTasksCount.style.display = 'flex';
    } else {
        elements.myTasksCount.style.display = 'none';
    }
}

// ===== AGENT NOTIFICATIONS FEED (колокольчик «Уведомления») =====
// Записи в agentNotifications создаёт ТОЛЬКО сервер (api/agent-monitor,
// api/agent-chat через Admin SDK); правила разрешают клиенту читать и помечать
// прочитанным только СВОИ записи. Запрос обязан быть заскоуплен по uid — иначе
// правила отклонят его целиком.
let agentNotifyUnsubscribe = null;
let agentNotifications = [];
let agentNotifyDeletingAll = false;

function subscribeToAgentNotifications() {
    if (agentNotifyUnsubscribe) { agentNotifyUnsubscribe(); agentNotifyUnsubscribe = null; }
    const uid = state.currentUser?.uid;
    const orgId = getCurrentOrganizationId();
    // Strict tenant isolation: the feed is scoped to uid AND the CURRENT
    // organization. Without the org filter, notifications from a previous
    // organization followed the user into the new one (they key on uid).
    // enterApp() re-runs this after join/create-org, so an org switch swaps
    // the listener to the new org. No org yet → empty feed.
    if (!uid || !db || !orgId) {
        agentNotifications = [];
        renderAgentNotifyBadge();
        renderAgentNotifyList();
        return;
    }
    agentNotifyUnsubscribe = db.collection('agentNotifications')
        .where('uid', '==', uid)
        .where('organizationId', '==', orgId)
        .orderBy('createdAt', 'desc')
        .limit(50)
        .onSnapshot(snap => {
            agentNotifications = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            renderAgentNotifyBadge();
            renderAgentNotifyList();
        }, err => console.error('agentNotifications listener:', err?.message || err));
}

function unsubscribeFromAgentNotifications() {
    if (agentNotifyUnsubscribe) { agentNotifyUnsubscribe(); agentNotifyUnsubscribe = null; }
    agentNotifications = [];
}

function renderAgentNotifyBadge() {
    const badge = document.getElementById('agent-notify-count');
    if (!badge) return;
    const unread = agentNotifications.filter(n => !n.readAt).length;
    badge.textContent = String(unread);
    badge.style.display = unread > 0 ? 'flex' : 'none';
}

const AGENT_NOTIFY_ICONS = {
    overdue: 'fa-triangle-exclamation',
    deadline_today: 'fa-calendar-day',
    deadline_tomorrow: 'fa-clock',
    not_taken_1h: 'fa-hourglass-half',
    unassigned_1h: 'fa-user-slash',
    tasks_created: 'fa-square-plus',
    task_created: 'fa-clipboard-list',
    task_completed: 'fa-clipboard-check',
    task_done: 'fa-circle-check',
    task_revision: 'fa-rotate-left'
};

const AGENT_NOTIFY_META = {
    overdue: { title: 'Задача просрочена', tone: 'danger' },
    deadline_today: { title: 'Срок сегодня', tone: 'warning' },
    deadline_tomorrow: { title: 'Срок завтра', tone: 'warning' },
    not_taken_1h: { title: 'Задача ещё не принята', tone: 'warning' },
    unassigned_1h: { title: 'Нет ответственного', tone: 'danger' },
    tasks_created: { title: 'Задачи созданы агентом', tone: 'success' },
    task_created: { title: 'Новая задача', tone: 'default' },
    task_completed: { title: 'Задача на проверке', tone: 'warning' },
    task_done: { title: 'Задача принята', tone: 'success' },
    task_revision: { title: 'Возврат на доработку', tone: 'warning' }
};

function pluralizeRu(count, forms) {
    const value = Math.abs(Number(count)) % 100;
    const last = value % 10;
    if (value > 10 && value < 20) return forms[2];
    if (last > 1 && last < 5) return forms[1];
    if (last === 1) return forms[0];
    return forms[2];
}

function agentNotificationText(notification, title) {
    let text = formatIsoDatesInText(notification?.text || '').trim();
    text = text.replace(/^[^\p{L}\p{N}]+/u, '');
    const escapedTitle = String(title || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (escapedTitle) {
        text = text.replace(new RegExp(`^${escapedTitle}\\s*[:!—-]*\\s*`, 'i'), '');
    }
    return text || 'Откройте уведомление, чтобы посмотреть подробности.';
}

function renderAgentNotifyList() {
    const list = document.getElementById('agent-notify-list');
    if (!list) return;
    list.textContent = '';
    updateAgentNotifyActions();
    const summary = document.getElementById('agent-notify-summary');
    const unreadCount = agentNotifications.filter(notification => !notification.readAt).length;
    if (summary) {
        summary.textContent = agentNotifications.length === 0
            ? 'События по вашим проектам и задачам'
            : `${agentNotifications.length} ${pluralizeRu(agentNotifications.length, ['уведомление', 'уведомления', 'уведомлений'])}${unreadCount ? ` · ${unreadCount} непрочитано` : ''}`;
    }
    if (agentNotifications.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'agent-notify-empty';
        empty.innerHTML = '<i class="fa-regular fa-bell-slash"></i><strong>Пока всё спокойно</strong><span>Новые события по задачам появятся здесь.</span>';
        list.appendChild(empty);
        return;
    }
    agentNotifications.forEach(n => {
        const meta = AGENT_NOTIFY_META[n.type] || { title: 'Системное уведомление', tone: 'default' };
        const item = document.createElement('div');
        item.className = `agent-notify-item type-${meta.tone}${n.readAt ? '' : ' unread'}`;
        const iconWrap = document.createElement('div');
        iconWrap.className = 'agent-notify-icon';
        const icon = document.createElement('i');
        icon.className = 'fa-solid ' + (AGENT_NOTIFY_ICONS[n.type] || 'fa-bell');
        iconWrap.appendChild(icon);
        const body = document.createElement('div');
        body.className = 'agent-notify-body';
        const titleRow = document.createElement('div');
        titleRow.className = 'agent-notify-title-row';
        const title = document.createElement('div');
        title.className = 'agent-notify-title';
        title.textContent = meta.title;
        titleRow.appendChild(title);
        if (!n.readAt) {
            const unreadDot = document.createElement('span');
            unreadDot.className = 'agent-notify-unread-dot';
            unreadDot.title = 'Не прочитано';
            titleRow.appendChild(unreadDot);
        }
        const text = document.createElement('div');
        text.className = 'agent-notify-text';
        text.textContent = agentNotificationText(n, meta.title);
        const when = document.createElement('div');
        when.className = 'agent-notify-time';
        when.innerHTML = '<i class="fa-regular fa-clock"></i>';
        when.appendChild(document.createTextNode(formatDateTimeRu(n.createdAt) || ''));
        body.appendChild(titleRow);
        body.appendChild(text);
        body.appendChild(when);
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'agent-notify-delete';
        deleteBtn.title = 'Удалить уведомление';
        deleteBtn.setAttribute('aria-label', 'Удалить уведомление');
        const deleteIcon = document.createElement('i');
        deleteIcon.className = 'fa-solid fa-xmark';
        deleteBtn.appendChild(deleteIcon);
        deleteBtn.addEventListener('click', (event) => {
            event.stopPropagation();
            deleteAgentNotification(n, item);
        });
        item.appendChild(iconWrap);
        item.appendChild(body);
        item.appendChild(deleteBtn);
        item.addEventListener('click', () => {
            markAgentNotificationRead(n);
            if (n.taskId) openTaskFromNotification(n.taskId);
        });
        list.appendChild(item);
    });
}

function updateAgentNotifyActions() {
    const readAllBtn = document.getElementById('agent-notify-read-all');
    const deleteAllBtn = document.getElementById('agent-notify-delete-all');
    if (readAllBtn) {
        readAllBtn.disabled = agentNotifyDeletingAll || !agentNotifications.some(n => !n.readAt);
    }
    if (deleteAllBtn) {
        deleteAllBtn.disabled = agentNotifyDeletingAll || agentNotifications.length === 0;
        deleteAllBtn.setAttribute('aria-busy', agentNotifyDeletingAll ? 'true' : 'false');
    }
}

function markAgentNotificationRead(n) {
    if (!n || n.readAt || !db) return;
    db.collection('agentNotifications').doc(n.id)
        .update({ readAt: firebase.firestore.FieldValue.serverTimestamp() })
        .catch(err => console.warn('agent-notify mark read failed:', err?.message || err));
}

function markAllAgentNotificationsRead() {
    if (!db) return;
    const unread = agentNotifications.filter(n => !n.readAt);
    if (unread.length === 0) return;
    const batch = db.batch();
    unread.forEach(n => batch.update(
        db.collection('agentNotifications').doc(n.id),
        { readAt: firebase.firestore.FieldValue.serverTimestamp() }
    ));
    batch.commit().catch(err => console.warn('agent-notify mark all failed:', err?.message || err));
}

async function deleteAgentNotification(n, itemEl) {
    if (!n?.id) return;
    try {
        itemEl?.classList.add('deleting');
        const currentUser = firebase.auth().currentUser;
        if (!currentUser) throw new Error('not-authenticated');
        const idToken = await currentUser.getIdToken();
        const response = await fetch('/api/agent-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ action: 'delete_notification', id: n.id })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || 'delete failed');
        agentNotifications = agentNotifications.filter(item => item.id !== n.id);
        renderAgentNotifyBadge();
        renderAgentNotifyList();
    } catch (err) {
        itemEl?.classList.remove('deleting');
        console.warn('agent-notify delete failed:', err?.message || err);
        alert('Не удалось удалить уведомление. Попробуйте ещё раз.');
    }
}

async function deleteAllAgentNotifications(buttonEl) {
    if (agentNotifyDeletingAll || agentNotifications.length === 0) return;
    if (!confirm('Удалить все уведомления этой организации?\n\nЭто действие нельзя отменить.')) return;

    agentNotifyDeletingAll = true;
    updateAgentNotifyActions();
    try {
        const currentUser = firebase.auth().currentUser;
        if (!currentUser) throw new Error('not-authenticated');
        const idToken = await currentUser.getIdToken();
        const response = await fetch('/api/agent-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({ action: 'delete_notifications', all: true })
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.ok) throw new Error(data.error || 'delete all failed');
        agentNotifications = [];
        renderAgentNotifyBadge();
        renderAgentNotifyList();
    } catch (err) {
        console.warn('agent-notify delete all failed:', err?.message || err);
        alert('Не удалось удалить уведомления. Попробуйте ещё раз.');
    } finally {
        agentNotifyDeletingAll = false;
        updateAgentNotifyActions();
        buttonEl?.blur();
    }
}

// Перейти к карточке задачи из уведомления тем же маршрутом, что и из
// «Мои задачи». Задача может быть не в state.tasks (открыт другой проект),
// поэтому читаем документ напрямую и определяем её фактическую колонку.
// Удалённая/недоступная задача — молча ничего.
async function openTaskFromNotification(taskId) {
    if (!db || !taskId) return;
    try {
        const doc = await db.collection('tasks').doc(taskId).get();
        if (!doc.exists) return;
        const task = { id: doc.id, ...doc.data() };
        if (!task.projectId) return;
        document.getElementById('agent-notify-modal')?.classList.remove('active');
        navigateToTask(task.projectId, task.id, boardViewForTask(task));
    } catch (err) {
        console.warn('openTaskFromNotification failed:', err?.message || err);
    }
}

// Subscribe to real-time updates for My Tasks count
function subscribeToMyTasks() {
    unsubscribeFromMyTasks(); // clear any previous (broad or chunked) listeners
    if (!state.currentUser) return;

    // Scope to the projects the user may see. A broad tasks listener fails
    // entirely for a restricted member (Firestore denies the WHOLE query if any
    // matched doc is unreadable), so listen per accessible project via chunked
    // `in` queries (Firestore caps `in` at 10 values) and merge the results.
    const projectIds = getFilteredProjects().map(p => p.id);
    if (projectIds.length === 0) {
        renderMyTasksBadge([]); // no accessible projects → hide the badge
        return;
    }
    const chunks = [];
    for (let i = 0; i < projectIds.length; i += 10) chunks.push(projectIds.slice(i, i + 10));
    myTasksByChunk = chunks.map(() => []);
    myTasksChunkUnsubs = chunks.map((chunk, idx) =>
        db.collection('tasks').where('projectId', 'in', chunk).onSnapshot(snapshot => {
            myTasksByChunk[idx] = snapshot.docs.map(d => d.data());
            renderMyTasksBadge(myTasksByChunk.flat());
        }, error => {
            console.error("Error listening to my tasks chunk:", error);
        })
    );
}

// Recompute the "My Tasks" badge from the merged task list across chunks.
function renderMyTasksBadge(tasks) {
    if (!state.currentUser || !elements.myTasksCount) return;

    const userUid = state.currentUser.uid;
    const userEmail = state.currentUser.email?.toLowerCase();
    const userFullName = state.currentUser.fullName ||
        `${state.currentUser.firstName || ''} ${state.currentUser.lastName || ''}`.trim();

    let activeCount = 0;

    (tasks || []).forEach(task => {
        // Skip completed tasks
        if (task.status === 'done') return;

        let isAssignee = false;

        // Match by uid first (Telegram-login users have no email)
        if (userUid && Array.isArray(task.assigneeIds) && task.assigneeIds.includes(userUid)) {
            isAssignee = true;
        }

        // Fallback: email (legacy tasks)
        if (!isAssignee && userEmail && task.assigneeEmail) {
            const assigneeEmails = task.assigneeEmail.toLowerCase().split(',');
            isAssignee = assigneeEmails.map(e => e.trim()).includes(userEmail);
        }

        // Fallback: full name (oldest tasks)
        if (!isAssignee && userFullName && task.assignee) {
            const assigneeNames = task.assignee.split(',').map(n => n.trim());
            isAssignee = assigneeNames.includes(userFullName);
        }

        if (isAssignee) {
            activeCount++;
        }
    });

    if (activeCount > 0) {
        elements.myTasksCount.textContent = activeCount;
        elements.myTasksCount.style.display = 'flex';
    } else {
        elements.myTasksCount.style.display = 'none';
    }
}

// Unsubscribe from all My Tasks listeners (chunked + any legacy broad one).
function unsubscribeFromMyTasks() {
    myTasksChunkUnsubs.forEach(u => { try { u(); } catch (e) { /* ignore */ } });
    myTasksChunkUnsubs = [];
    myTasksByChunk = [];
    if (myTasksListenerUnsubscribe) {
        myTasksListenerUnsubscribe();
        myTasksListenerUnsubscribe = null;
    }
}

// Filter projects based on user access
function getFilteredProjects() {
    if (!state.currentUser) return [];

    // Organization owners/admins see all projects in their organization.
    if (canManageProjects() || state.role === 'admin') {
        return state.projects;
    }

    // Load user data to check allowedProjects
    const userData = state.users.find(u => u.id === state.currentUser.uid);
    if (!userData) return state.projects; // Default to all if user data not loaded

    const allowedProjects = userData.allowedProjects || [];

    // Empty array means access to all projects
    if (allowedProjects.length === 0) {
        return state.projects;
    }

    // Filter projects
    return state.projects.filter(p => allowedProjects.includes(p.id));
}

// ========== KEYBOARD NAVIGATION ==========
const keyboardNav = {
    active: false,
    mode: 'projects', // 'projects' or 'tasks'
    taskColumn: 'assigned', // assigned | in-progress | review
    focusIndex: -1,
    hintTimeout: null,
    inactivityTimeout: null
};

function initKeyboardNavigation() {
    // Create hint element
    const hint = document.createElement('div');
    hint.className = 'keyboard-nav-hint';
    hint.innerHTML = '<kbd>↑↓</kbd> навигация <kbd>←→</kbd> колонки <kbd>Enter</kbd> инфо';
    document.body.appendChild(hint);

    // Listen for keyboard events
    document.addEventListener('keydown', handleKeyboardNavigation);

    // Listen for mouse movement to disable keyboard mode
    document.addEventListener('mousemove', disableKeyboardNav);
    document.addEventListener('click', disableKeyboardNav);
}

function resetInactivityTimer() {
    clearTimeout(keyboardNav.inactivityTimeout);
    keyboardNav.inactivityTimeout = setTimeout(() => {
        disableKeyboardNav();
    }, 3000);
}

function handleKeyboardNavigation(e) {
    // Ignore if typing in input/textarea
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        return;
    }

    // Handle Escape - close modal if open
    if (e.key === 'Escape') {
        const activeModal = document.querySelector('.modal.active');
        if (activeModal) {
            e.preventDefault();
            closeModalElement(activeModal);
            playClickSound();
            resetInactivityTimer();
            // Return to tasks mode after closing modal
            keyboardNav.mode = 'tasks';
        }
        return;
    }

    // Check if task details modal is open - allow scrolling with arrows
    const taskDetailsModal = document.getElementById('task-details-modal');
    if (taskDetailsModal && taskDetailsModal.classList.contains('active')) {
        if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const content = document.querySelector('.task-details-body');
            if (content) {
                const scrollAmount = 50;
                if (e.key === 'ArrowUp') {
                    content.scrollTop -= scrollAmount;
                } else {
                    content.scrollTop += scrollAmount;
                }
            }
            resetInactivityTimer();
            return;
        }
    }

    // Ignore other keys if modal is open (except task details which we handle above)
    const activeModal = document.querySelector('.modal.active');
    if (activeModal) {
        return;
    }

    // Check for navigation keys
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) {
        e.preventDefault();

        // Enable keyboard navigation mode
        if (!keyboardNav.active) {
            enableKeyboardNav();
        }

        // Reset inactivity timer
        resetInactivityTimer();

        switch (e.key) {
            case 'ArrowUp':
                navigateUp();
                break;
            case 'ArrowDown':
                navigateDown();
                break;
            case 'ArrowLeft':
                if (keyboardNav.mode === 'tasks') {
                    // Cycle columns left: review -> in-progress -> assigned -> projects
                    if (keyboardNav.taskColumn === 'review') {
                        keyboardNav.taskColumn = 'in-progress';
                        setBoardView('in-progress');
                    } else if (keyboardNav.taskColumn === 'in-progress') {
                        keyboardNav.taskColumn = 'assigned';
                        setBoardView('assigned');
                    } else {
                        // From assigned -> projects mode
                        keyboardNav.mode = 'projects';
                    }
                    keyboardNav.focusIndex = -1;
                    clearKeyboardFocus();
                    navigateDown();
                }
                break;
            case 'ArrowRight':
                if (keyboardNav.mode === 'projects' && state.activeProjectId) {
                    // Switch to tasks mode (assigned column)
                    keyboardNav.mode = 'tasks';
                    keyboardNav.taskColumn = 'assigned';
                    setBoardView('assigned');
                    keyboardNav.focusIndex = -1;
                    clearKeyboardFocus();
                    navigateDown();
                } else if (keyboardNav.mode === 'tasks') {
                    // Cycle columns right: assigned -> in-progress -> review
                    if (keyboardNav.taskColumn === 'assigned') {
                        keyboardNav.taskColumn = 'in-progress';
                        setBoardView('in-progress');
                    } else if (keyboardNav.taskColumn === 'in-progress') {
                        keyboardNav.taskColumn = 'review';
                        setBoardView('review');
                    }
                    keyboardNav.focusIndex = -1;
                    clearKeyboardFocus();
                    navigateDown();
                }
                break;
            case 'Enter':
                // Enter only opens task info panel
                if (keyboardNav.mode === 'tasks') {
                    openFocusedTaskInfo();
                }
                break;
        }
    }
}

function enableKeyboardNav() {
    keyboardNav.active = true;
    document.body.classList.add('keyboard-nav');
    showKeyboardHint();
    resetInactivityTimer();
}

function disableKeyboardNav() {
    if (!keyboardNav.active) return;

    keyboardNav.active = false;
    keyboardNav.focusIndex = -1;
    document.body.classList.remove('keyboard-nav');
    clearKeyboardFocus();
    hideKeyboardHint();
    clearTimeout(keyboardNav.inactivityTimeout);
}

function showKeyboardHint() {
    const hint = document.querySelector('.keyboard-nav-hint');
    if (hint) {
        hint.classList.add('visible');

        // Auto-hide after 3 seconds
        clearTimeout(keyboardNav.hintTimeout);
        keyboardNav.hintTimeout = setTimeout(() => {
            hint.classList.remove('visible');
        }, 3000);
    }
}

function hideKeyboardHint() {
    const hint = document.querySelector('.keyboard-nav-hint');
    if (hint) {
        hint.classList.remove('visible');
    }
    clearTimeout(keyboardNav.hintTimeout);
}

function clearKeyboardFocus() {
    document.querySelectorAll('.keyboard-focus').forEach(el => {
        el.classList.remove('keyboard-focus');
    });
}

function navigateUp() {
    const items = getNavigableItems();
    if (items.length === 0) return;

    clearKeyboardFocus();

    if (keyboardNav.focusIndex <= 0) {
        keyboardNav.focusIndex = items.length - 1;
    } else {
        keyboardNav.focusIndex--;
    }

    const item = items[keyboardNav.focusIndex];
    item.classList.add('keyboard-focus');
    item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // Auto-select project when navigating
    if (keyboardNav.mode === 'projects') {
        selectProjectByKeyboard(item);
    }
}

function navigateDown() {
    const items = getNavigableItems();
    if (items.length === 0) return;

    clearKeyboardFocus();

    if (keyboardNav.focusIndex >= items.length - 1) {
        keyboardNav.focusIndex = 0;
    } else {
        keyboardNav.focusIndex++;
    }

    const item = items[keyboardNav.focusIndex];
    item.classList.add('keyboard-focus');
    item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // Auto-select project when navigating
    if (keyboardNav.mode === 'projects') {
        selectProjectByKeyboard(item);
    }
}

function getNavigableItems() {
    if (keyboardNav.mode === 'projects') {
        return Array.from(document.querySelectorAll('.project-item'));
    } else {
        // Get task cards from the current column
        const columnMap = {
            'assigned': 'list-assigned',
            'in-progress': 'list-in-progress',
            'review': 'list-review'
        };
        const columnId = columnMap[keyboardNav.taskColumn] || 'list-in-progress';
        return Array.from(document.querySelectorAll(`#${columnId} .task-card`));
    }
}

function selectProjectByKeyboard(projectItem) {
    // Get project ID from the item
    const projectId = projectItem.dataset.id;
    if (projectId && projectId !== state.activeProjectId) {
        playClickSound();
        // Trigger project selection
        selectProject(projectId);
    }
}

function openFocusedTaskInfo() {
    const focusedItem = document.querySelector('.keyboard-focus');
    if (!focusedItem) return;

    playClickSound();

    // Open task info modal
    const taskId = focusedItem.dataset.id || focusedItem.dataset.taskId;
    if (taskId) {
        const task = state.tasks.find(t => t.id === taskId);
        if (task) {
            openTaskDetailsModal(task);
        }
    }
}

// Start
document.addEventListener('DOMContentLoaded', () => {
    init();
    initKeyboardNavigation();
    initProfileAndLeaderboard();
    initCalendarModule();
    initAgentChat();

});

// ========== MIGRATION FUNCTION ==========
function forceUpdate() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistrations().then(function (registrations) {
            for (let registration of registrations) {
                registration.unregister();
            }
            // Clear all caches
            caches.keys().then(function (names) {
                for (let name of names)
                    caches.delete(name);
            });
            window.location.reload(true);
        });
    } else {
        window.location.reload(true);
    }
}

// Update organization member limit
// Usage: updateOrgLimit(100) - set limit to 100 users
async function updateOrgLimit(newLimit = 100) {
    if (!state.organization?.id) {
        console.error('No organization selected');
        return;
    }

    if (!canAccessAdmin()) {
        console.error('Only owner/admin can change limits');
        return;
    }

    try {
        await db.collection('organizations').doc(state.organization.id).update({
            'settings.maxUsers': newLimit
        });
        console.log(`✅ Limit updated to ${newLimit} users`);
        state.organization.settings = state.organization.settings || {};
        state.organization.settings.maxUsers = newLimit;
    } catch (error) {
        console.error('Error updating limit:', error);
    }
}

// ========== PERSONAL PROFILE ==========
function setProfileNameEditorOpen(isOpen) {
    const form = document.getElementById('profile-name-form');
    const editButton = document.getElementById('profile-name-edit');
    const error = document.getElementById('profile-name-error');
    if (!form) return;

    form.hidden = !isOpen;
    if (editButton) editButton.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    if (error) {
        error.hidden = true;
        error.textContent = '';
    }

    if (isOpen) {
        const userData = state.users.find(user => user.id === state.currentUser?.uid) || state.currentUser;
        const firstInput = document.getElementById('profile-first-name');
        const lastInput = document.getElementById('profile-last-name');
        if (firstInput) firstInput.value = userData?.firstName || '';
        if (lastInput) lastInput.value = userData?.lastName || '';
        requestAnimationFrame(() => firstInput?.focus());
    }
}

async function handleProfileNameSubmit(event) {
    event.preventDefault();
    const firstInput = document.getElementById('profile-first-name');
    const lastInput = document.getElementById('profile-last-name');
    const error = document.getElementById('profile-name-error');
    const message = document.getElementById('profile-name-message');
    const saveButton = document.getElementById('profile-name-save');
    const firstName = (firstInput?.value || '').trim().replace(/\s+/g, ' ');
    const lastName = (lastInput?.value || '').trim().replace(/\s+/g, ' ');

    if (firstName.length < 2 || lastName.length < 2) {
        if (error) {
            error.textContent = 'Введите имя и фамилию: минимум по 2 символа.';
            error.hidden = false;
        }
        return;
    }

    setButtonLoading(saveButton, true, 'Сохраняем…');
    if (error) error.hidden = true;
    if (message) message.hidden = true;

    try {
        const result = await callOrgApi('completeProfile', { firstName, lastName });
        const displayName = result.displayName || `${firstName} ${lastName}`;
        Object.assign(state.currentUser, {
            firstName,
            lastName,
            fullName: displayName,
            displayName,
            profileCompleted: true,
        });
        const currentRosterUser = state.users.find(user => user.id === state.currentUser.uid);
        if (currentRosterUser) {
            Object.assign(currentRosterUser, { firstName, lastName, displayName });
        }

        const profileName = document.getElementById('profile-name');
        if (profileName) profileName.textContent = displayName;
        const avatarText = document.getElementById('profile-avatar-text');
        const avatarImg = document.getElementById('profile-avatar-img');
        if (avatarText && avatarImg?.style.display === 'none') {
            avatarText.textContent = `${firstName[0] || ''}${lastName[0] || ''}`.toUpperCase() || 'U';
        }

        setProfileNameEditorOpen(false);
        if (message) {
            message.textContent = 'Имя и фамилия обновлены.';
            message.hidden = false;
        }
        renderUsersList();
        renderProjectAccessTab();
        renderLoginHistoryTab();
        renderAdminUsersStatsPanel();
        playClickSound();
    } catch (submitError) {
        if (error) {
            error.textContent = submitError?.message || 'Не удалось сохранить имя и фамилию.';
            error.hidden = false;
        }
    } finally {
        setButtonLoading(saveButton, false);
    }
}

function openProfileModal() {
    const modal = document.getElementById('profile-modal');
    if (!modal || !state.currentUser) return;

    // Get current user data
    const userData = state.users.find(u => u.id === state.currentUser.uid);
    if (!userData) return;

    // Update avatar
    const avatarText = document.getElementById('profile-avatar-text');
    const avatarImg = document.getElementById('profile-avatar-img');
    const initials = ((userData.firstName || '')[0] || '') + ((userData.lastName || '')[0] || '');

    if (userData.profilePhotoUrl) {
        avatarImg.src = sanitizeAttachmentUrl(userData.profilePhotoUrl) || '';
        avatarImg.style.display = 'block';
        avatarText.style.display = 'none';
    } else {
        avatarText.textContent = initials.toUpperCase() || 'U';
        avatarText.style.display = 'block';
        avatarImg.style.display = 'none';
    }

    // Update name and email
    const fullName = `${userData.firstName || ''} ${userData.lastName || ''}`.trim() || 'Без имени';
    document.getElementById('profile-name').textContent = fullName;
    document.getElementById('profile-email').textContent = userData.email || '';
    setProfileNameEditorOpen(false);
    const profileNameMessage = document.getElementById('profile-name-message');
    if (profileNameMessage) profileNameMessage.hidden = true;
    renderAuthProvider();

    // Update level info
    const totalXP = userData.totalXP || 0;
    const levelInfo = getLevelFromXP(totalXP);
    const nextLevelXP = getNextLevelXP(totalXP);
    const progress = calculateXPProgress(totalXP);

    document.getElementById('profile-level').textContent = levelInfo.level;
    document.getElementById('profile-level-title').textContent = levelInfo.title;
    document.getElementById('profile-xp').textContent = totalXP;
    document.getElementById('profile-xp-next').textContent = nextLevelXP;
    document.getElementById('profile-xp-progress').style.width = `${progress}%`;

    // Use stored counters for completed stats (persists even if tasks deleted)
    const completedTasks = userData.completedTasksCount || 0;
    const onTimeTasks = userData.onTimeTasksCount || 0;
    const onTimePercent = completedTasks > 0 ? Math.round((onTimeTasks / completedTasks) * 100) : 0;

    const noRevisionTasks = userData.noRevisionTasksCount || 0;
    const noRevisionPercent = completedTasks > 0 ? Math.round((noRevisionTasks / completedTasks) * 100) : 0;

    document.getElementById('profile-completed-tasks').textContent = completedTasks;
    document.getElementById('profile-ontime-tasks').textContent = onTimeTasks;
    document.getElementById('profile-ontime-percent').textContent = `${onTimePercent}%`;
    document.getElementById('profile-no-revision-tasks').textContent = noRevisionTasks;
    document.getElementById('profile-no-revision-percent').textContent = `${noRevisionPercent}%`;

    // Show loading state for active tasks only
    document.getElementById('profile-active-tasks').textContent = '...';

    // Open modal immediately
    modal.classList.add('active');

    // Load active tasks count asynchronously (these need to be queried from tasks)
    countActiveTasks(userData).then(activeTasks => {
        document.getElementById('profile-active-tasks').textContent = activeTasks;
    });
}

async function countActiveTasks(user) {
    // Match by uid first (assigneeIds) — Telegram-login users have no email, so
    // the old email-only count always showed 0 for them. Email is a fallback.
    const uid = user?.id || null;
    const email = user?.email ? user.email.toLowerCase() : null;
    if (!uid && !email) return 0;

    let activeTasks = 0;

    // Only the caller's ACCESSIBLE projects. Scanning all org projects would
    // throw on a project the caller can't read (rules), leaving the profile
    // "Текущие задачи" stuck on "…". Each project read is also guarded so one
    // failure can't abort the whole count.
    const accessibleProjects = getFilteredProjects();

    for (const project of accessibleProjects) {
        try {
            const tasksSnapshot = await db.collection('tasks')
                .where('projectId', '==', project.id)
                .get();

            tasksSnapshot.forEach(taskDoc => {
                const task = taskDoc.data();
                if (task.status === 'done') return;

                let isAssignee = false;
                if (uid && Array.isArray(task.assigneeIds) && task.assigneeIds.includes(uid)) {
                    isAssignee = true;
                }
                if (!isAssignee && email && task.assigneeEmail) {
                    const emails = task.assigneeEmail.toLowerCase().split(',').map(e => e.trim());
                    if (emails.includes(email)) isAssignee = true;
                }
                if (isAssignee) activeTasks++;
            });
        } catch (e) {
            console.error('countActiveTasks: failed for project', project.id, e);
        }
    }

    return activeTasks;
}

// ========== PHOTO CROP SYSTEM ==========
let cropState = {
    image: null,
    zoom: 1,
    offsetX: 0,
    offsetY: 0,
    isDragging: false,
    startX: 0,
    startY: 0
};

function openPhotoCrop(file) {
    if (!file || !state.currentUser) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
        alert('Пожалуйста, выберите изображение');
        return;
    }

    // Validate file size (max 5MB for cropping)
    if (file.size > 5 * 1024 * 1024) {
        alert('Размер файла не должен превышать 5MB');
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        const cropModal = document.getElementById('crop-modal');
        const cropImage = document.getElementById('crop-image');

        // Reset crop state
        cropState = {
            image: null,
            zoom: 1,
            offsetX: 0,
            offsetY: 0,
            isDragging: false,
            startX: 0,
            startY: 0
        };

        // Set image
        cropImage.src = e.target.result;
        document.getElementById('crop-zoom').value = 1;

        // Wait for image to load
        cropImage.onload = () => {
            cropState.image = cropImage;
            updateCropTransform();
            cropModal.classList.add('active');
        };
    };
    reader.readAsDataURL(file);
}

function updateCropTransform() {
    const cropImage = document.getElementById('crop-image');
    if (cropImage) {
        cropImage.style.transform = `translate(${cropState.offsetX}px, ${cropState.offsetY}px) scale(${cropState.zoom})`;
    }
}

function initPhotoCrop() {
    const cropModal = document.getElementById('crop-modal');
    const cropImage = document.getElementById('crop-image');
    const cropContainer = document.getElementById('crop-container');
    const cropZoom = document.getElementById('crop-zoom');
    const cropCancel = document.getElementById('crop-cancel');
    const cropSave = document.getElementById('crop-save');

    if (!cropModal) return;

    // Zoom control
    if (cropZoom) {
        cropZoom.addEventListener('input', (e) => {
            cropState.zoom = parseFloat(e.target.value);
            updateCropTransform();
        });
    }

    // Drag to pan
    if (cropContainer) {
        cropContainer.addEventListener('mousedown', (e) => {
            if (e.target === cropImage) {
                cropState.isDragging = true;
                cropState.startX = e.clientX - cropState.offsetX;
                cropState.startY = e.clientY - cropState.offsetY;
                cropImage.style.cursor = 'grabbing';
            }
        });

        cropContainer.addEventListener('mousemove', (e) => {
            if (cropState.isDragging) {
                cropState.offsetX = e.clientX - cropState.startX;
                cropState.offsetY = e.clientY - cropState.startY;
                updateCropTransform();
            }
        });

        cropContainer.addEventListener('mouseup', () => {
            cropState.isDragging = false;
            cropImage.style.cursor = 'move';
        });

        cropContainer.addEventListener('mouseleave', () => {
            cropState.isDragging = false;
            cropImage.style.cursor = 'move';
        });

        // Touch support
        cropContainer.addEventListener('touchstart', (e) => {
            if (e.target === cropImage) {
                cropState.isDragging = true;
                const touch = e.touches[0];
                cropState.startX = touch.clientX - cropState.offsetX;
                cropState.startY = touch.clientY - cropState.offsetY;
            }
        });

        cropContainer.addEventListener('touchmove', (e) => {
            if (cropState.isDragging) {
                e.preventDefault();
                const touch = e.touches[0];
                cropState.offsetX = touch.clientX - cropState.startX;
                cropState.offsetY = touch.clientY - cropState.startY;
                updateCropTransform();
            }
        });

        cropContainer.addEventListener('touchend', () => {
            cropState.isDragging = false;
        });
    }

    // Cancel button
    if (cropCancel) {
        cropCancel.addEventListener('click', () => {
            cropModal.classList.remove('active');
            document.getElementById('profile-photo-input').value = '';
        });
    }

    // Save button
    if (cropSave) {
        cropSave.addEventListener('click', async () => {
            setButtonLoading(cropSave, true, 'Сохраняем…');
            try {
                const croppedImage = await cropImageToCircle();

                // Save to user document
                await db.collection('users').doc(state.currentUser.uid).update({
                    profilePhotoUrl: croppedImage
                });

                // Update UI
                const avatarImg = document.getElementById('profile-avatar-img');
                const avatarText = document.getElementById('profile-avatar-text');
                avatarImg.src = croppedImage;
                avatarImg.style.display = 'block';
                avatarText.style.display = 'none';

                cropModal.classList.remove('active');
                document.getElementById('profile-photo-input').value = '';
                playClickSound();
            } catch (error) {
                console.error('Error saving cropped photo:', error);
                alert('Ошибка сохранения фото');
            } finally {
                setButtonLoading(cropSave, false);
            }
        });
    }
}

function cropImageToCircle() {
    return new Promise((resolve) => {
        const cropImage = document.getElementById('crop-image');
        const container = document.getElementById('crop-container');

        // Get the actual displayed image rect
        const imgRect = cropImage.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();

        // Circle position (centered in container, 200px size)
        const circleSize = 200;
        const circleCenterX = containerRect.left + containerRect.width / 2;
        const circleCenterY = containerRect.top + containerRect.height / 2;

        // Calculate what part of the natural image is in the circle
        // The image on screen has been transformed, so we need to reverse-calculate

        // Image center on screen
        const imgCenterX = imgRect.left + imgRect.width / 2;
        const imgCenterY = imgRect.top + imgRect.height / 2;

        // How far is the circle center from the image center (in screen pixels)
        const diffX = circleCenterX - imgCenterX;
        const diffY = circleCenterY - imgCenterY;

        // Scale from displayed size to natural size
        const scaleToNatural = cropImage.naturalWidth / imgRect.width;

        // Circle radius in natural image pixels
        const radiusNatural = (circleSize / 2) * scaleToNatural;

        // Center of crop area in natural image coordinates
        const naturalCenterX = cropImage.naturalWidth / 2 + diffX * scaleToNatural;
        const naturalCenterY = cropImage.naturalHeight / 2 + diffY * scaleToNatural;

        // Source rectangle in natural image
        const sourceX = naturalCenterX - radiusNatural;
        const sourceY = naturalCenterY - radiusNatural;
        const sourceSize = radiusNatural * 2;

        // Output canvas
        const canvas = document.createElement('canvas');
        const outputSize = 200;
        canvas.width = outputSize;
        canvas.height = outputSize;
        const ctx = canvas.getContext('2d');

        // Create circular clip
        ctx.beginPath();
        ctx.arc(outputSize / 2, outputSize / 2, outputSize / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();

        // Draw the cropped area
        ctx.drawImage(
            cropImage,
            sourceX, sourceY, sourceSize, sourceSize,
            0, 0, outputSize, outputSize
        );

        resolve(canvas.toDataURL('image/jpeg', 0.9));
    });
}



// ========== LEADERBOARD ==========
function openLeaderboardModal() {
    const modal = document.getElementById('leaderboard-modal');
    if (!modal) return;

    const podiumContainer = document.getElementById('leaderboard-podium');
    const MIN_LEVEL_FOR_RANKING = 3;
    const RANKING_WEIGHTS = { onTime: 0.5, noRevision: 0.5 };

    // Get all users from organization with level 3+
    const allUsers = state.users
        .filter(u => u.organizationId === state.organization?.id)
        .map(u => {
            const completedTasks = u.completedTasksCount || 0;
            const onTimeTasks = u.onTimeTasksCount || 0;
            const noRevisionTasks = u.noRevisionTasksCount || 0;
            // Calculate on-time percentage (0 if no completed tasks)
            const onTimePercent = completedTasks > 0 ? Math.round((onTimeTasks / completedTasks) * 100) : 0;
            const noRevisionPercent = completedTasks > 0 ? Math.round((noRevisionTasks / completedTasks) * 100) : 0;
            const ratingScore = completedTasks > 0
                ? Math.round(onTimePercent * RANKING_WEIGHTS.onTime + noRevisionPercent * RANKING_WEIGHTS.noRevision)
                : 0;
            const level = getLevelFromXP(u.totalXP || 0);
            return {
                ...u,
                completedTasks,
                onTimeTasks,
                noRevisionTasks,
                onTimePercent,
                noRevisionPercent,
                ratingScore,
                level
            };
        })
        // Only include users with level 3 or higher
        .filter(u => u.level.level >= MIN_LEVEL_FOR_RANKING);

    // Header note about level requirement
    let headerHTML = `<div class="leaderboard-note"><i class="fa-solid fa-info-circle"></i> Рейтинг доступен с ${MIN_LEVEL_FOR_RANKING} уровня</div>`;

    if (allUsers.length === 0) {
        podiumContainer.innerHTML = headerHTML + `<div class="leaderboard-empty"><i class="fa-solid fa-trophy" style="font-size: 3rem; opacity: 0.3; margin-bottom: 1rem;"></i><p>Пока нет сотрудников с ${MIN_LEVEL_FOR_RANKING}+ уровнем</p></div>`;
        modal.classList.add('active');
        return;
    }

    // Sort: by rating score (desc), then by completed tasks (desc), then by no-revision %, then by on-time %
    const sortedUsers = allUsers.sort((a, b) => {
        // Both have completed tasks - sort by percentage then by count
        if (a.completedTasks > 0 && b.completedTasks > 0) {
            if (b.ratingScore !== a.ratingScore) return b.ratingScore - a.ratingScore;
            if (b.completedTasks !== a.completedTasks) return b.completedTasks - a.completedTasks;
            if (b.noRevisionPercent !== a.noRevisionPercent) return b.noRevisionPercent - a.noRevisionPercent;
            if (b.onTimePercent !== a.onTimePercent) return b.onTimePercent - a.onTimePercent;
            return 0;
        }
        // One has completed tasks, other doesn't - completed first
        if (a.completedTasks > 0) return -1;
        if (b.completedTasks > 0) return 1;
        // Both have 0 completed - random order
        return Math.random() - 0.5;
    });

    // Always take top 3 (or less if fewer users)
    const top3 = sortedUsers.slice(0, 3);
    const places = ['gold', 'silver', 'bronze'];
    const medals = ['1', '2', '3'];

    let podiumHTML = '';

    // Render in order: 1st, 2nd, 3rd
    top3.forEach((user, index) => {
        const place = places[index];
        const medal = medals[index];
        const initials = ((user.firstName || '')[0] || '') + ((user.lastName || '')[0] || '');
        const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Без имени';

        // Show stats or "Нет задач" if no completed tasks
        const statsText = user.completedTasks > 0
            ? `В срок: ${user.onTimeTasks} из ${user.completedTasks} (${user.onTimePercent}%) • Без доработок: ${user.noRevisionTasks} из ${user.completedTasks} (${user.noRevisionPercent}%)`
            : 'Нет завершённых задач';
        const percentText = user.completedTasks > 0
            ? `${user.ratingScore}%`
            : '—';
        const levelText = `Ур. ${user.level.level} • ${user.level.title}`;

        podiumHTML += `
            <div class="podium-place ${place}">
                <div class="podium-avatar">
                    ${user.profilePhotoUrl
                ? `<img src="${escapeHtml(sanitizeAttachmentUrl(user.profilePhotoUrl))}" alt="${escapeHtml(fullName)}">`
                : initials.toUpperCase() || 'U'
            }
                    <div class="podium-medal">${medal}</div>
                </div>
                <div class="podium-info">
                    <div class="podium-name">${escapeHtml(fullName)}</div>
                    <div class="podium-level">${levelText}</div>
                    <div class="podium-stats">${statsText}</div>
                </div>
                <div class="podium-xp">${percentText}</div>
            </div>
        `;
    });

    podiumContainer.innerHTML = headerHTML + podiumHTML;

    modal.classList.add('active');
}

// Initialize profile and leaderboard buttons
function initProfileAndLeaderboard() {
    const profileBtn = document.getElementById('profile-btn');
    const leaderboardBtn = document.getElementById('leaderboard-btn');
    const photoInput = document.getElementById('profile-photo-input');
    const profileNameEdit = document.getElementById('profile-name-edit');
    const profileNameCancel = document.getElementById('profile-name-cancel');
    const profileNameForm = document.getElementById('profile-name-form');

    if (profileBtn) {
        profileBtn.addEventListener('click', () => {
            playClickSound();
            openProfileModal();
        });
    }

    if (leaderboardBtn) {
        leaderboardBtn.addEventListener('click', () => {
            playClickSound();
            openLeaderboardModal();
        });
    }

    if (photoInput) {
        photoInput.addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (file) {
                openPhotoCrop(file);
            }
        });
    }

    profileNameEdit?.addEventListener('click', () => {
        const form = document.getElementById('profile-name-form');
        setProfileNameEditorOpen(Boolean(form?.hidden));
    });
    profileNameCancel?.addEventListener('click', () => setProfileNameEditorOpen(false));
    profileNameForm?.addEventListener('submit', handleProfileNameSubmit);

    // Initialize photo crop
    initPhotoCrop();
}

// ========== CALENDAR MODULE ==========
let calendarState = {
    currentDate: new Date(),
    tasks: [],
    openDayDate: null
};

const calElements = {
    container: document.getElementById('calendar-view-container'),
    grid: document.getElementById('calendar-grid'),
    monthTitle: document.getElementById('cal-current-month'),
    prevBtn: document.getElementById('cal-prev-month'),
    nextBtn: document.getElementById('cal-next-month'),
    todayBtn: document.getElementById('cal-today-btn'),

    dayTasksModal: document.getElementById('day-tasks-modal'),
    dayTasksTitle: document.getElementById('day-tasks-title'),
    dayTasksBody: document.getElementById('day-tasks-body')
};

function initCalendarModule() {
    calElements.prevBtn?.addEventListener('click', () => {
        calendarState.currentDate.setMonth(calendarState.currentDate.getMonth() - 1);
        renderCalendar();
    });

    calElements.nextBtn?.addEventListener('click', () => {
        calendarState.currentDate.setMonth(calendarState.currentDate.getMonth() + 1);
        renderCalendar();
    });

    calElements.todayBtn?.addEventListener('click', () => {
        calendarState.currentDate = new Date();
        renderCalendar();
    });

    // Day-tasks modal: close button(s) + backdrop click
    calElements.dayTasksModal?.querySelectorAll('.close-modal').forEach(btn => {
        btn.addEventListener('click', closeDayTasksModal);
    });
    calElements.dayTasksModal?.addEventListener('click', (e) => {
        if (e.target === calElements.dayTasksModal) closeDayTasksModal();
    });
}

function renderCalendar() {
    if (!calElements.grid) return;

    // Календарь — проектный вид (как Канбан и Гант): рисуем задачи АКТИВНОГО
    // проекта из того же живого снапшота state.tasks. Собственный слушатель по
    // всем проектам больше не нужен — renderBoard() вызывает renderCalendar()
    // на каждом обновлении задач.
    calendarState.tasks = Array.isArray(state.tasks) ? state.tasks : [];
    // Открытая модалка «Задачи дня» обновляется вместе со снапшотом.
    if (calendarState.openDayDate) renderDayTasks(calendarState.openDayDate);

    const year = calendarState.currentDate.getFullYear();
    const month = calendarState.currentDate.getMonth();

    calElements.monthTitle.textContent = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(calendarState.currentDate);

    // Get first day of month (Russian week starts Monday)
    const firstDay = new Date(year, month, 1);
    let startDayOffset = firstDay.getDay() - 1; // 0 for Mon, 6 for Sun
    if (startDayOffset === -1) startDayOffset = 6;

    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevMonthDays = new Date(year, month, 0).getDate();

    calElements.grid.innerHTML = '';

    // Prev month days
    for (let i = startDayOffset - 1; i >= 0; i--) {
        addDayToGrid(prevMonthDays - i, true, new Date(year, month - 1, prevMonthDays - i));
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
        addDayToGrid(d, false, new Date(year, month, d));
    }

    // Next month days (fill grid to 42 cells)
    const extra = 42 - calElements.grid.children.length;
    for (let i = 1; i <= extra; i++) {
        addDayToGrid(i, true, new Date(year, month + 1, i));
    }
}

// Local YYYY-MM-DD (not toISOString, which is UTC and can shift the day across
// the midnight boundary for non-UTC users — the same timezone-skew class of bug
// fixed earlier in scheduleStatus).
function localDateStr(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

// Resolves a task to one calendar status key. Order matters: archived/done and
// assignee-completed win over the overdue check so a finished task never shows
// as "просрочена".
function calendarTaskStatusKey(task) {
    if (task.status === 'done') return 'done';
    const sub = task.subStatus || (task.assigneeCompleted ? 'completed' : 'assigned');
    if (sub === 'completed' || task.assigneeCompleted) return 'completed';
    if (task.deadline) {
        const dl = new Date(task.deadline);
        dl.setHours(23, 59, 59, 999);
        if (dl < new Date()) return 'overdue';
    }
    return sub === 'in_work' ? 'in_work' : 'assigned';
}

function calendarTaskStatusLabel(key) {
    return ({
        assigned: 'Назначена',
        in_work: 'В работе',
        completed: 'На проверке',
        done: 'Готово',
        overdue: 'Просрочена'
    })[key] || 'Назначена';
}

function calendarTasksForDate(dateStr) {
    return calendarState.tasks.filter(t => t.deadline && String(t.deadline).slice(0, 10) === dateStr);
}

function addDayToGrid(num, otherMonth, fullDate) {
    const dayEl = document.createElement('div');
    dayEl.className = `calendar-day ${otherMonth ? 'other-month' : ''}`;

    const today = new Date();
    if (fullDate.toDateString() === today.toDateString()) {
        dayEl.classList.add('today');
    }

    const dateStr = localDateStr(fullDate);

    const numEl = document.createElement('div');
    numEl.className = 'day-number';
    numEl.textContent = num;
    dayEl.appendChild(numEl);

    const cont = document.createElement('div');
    cont.className = 'calendar-events-container';
    dayEl.appendChild(cont);

    // Task pills coloured by status.
    const dayTasks = calendarTasksForDate(dateStr);
    const MAX_PILLS = 3;
    dayTasks.slice(0, MAX_PILLS).forEach(task => {
        const key = calendarTaskStatusKey(task);
        const pill = document.createElement('div');
        pill.className = `calendar-task-pill task-${key}`;
        const dot = document.createElement('span');
        dot.className = 'pill-dot';
        pill.appendChild(dot);
        const label = document.createElement('span');
        label.textContent = task.title || 'Задача';
        label.style.overflow = 'hidden';
        label.style.textOverflow = 'ellipsis';
        pill.appendChild(label);
        pill.addEventListener('click', (e) => {
            e.stopPropagation();
            openDayTasksModal(dateStr);
        });
        cont.appendChild(pill);
    });

    if (dayTasks.length > MAX_PILLS) {
        const more = document.createElement('div');
        more.className = 'calendar-day-more';
        more.textContent = `+${dayTasks.length - MAX_PILLS} ещё`;
        cont.appendChild(more);
    }

    // A click anywhere on the day opens the list of that day's tasks.
    dayEl.addEventListener('click', () => openDayTasksModal(dateStr));
    calElements.grid.appendChild(dayEl);
}

// Opens the modal listing every task due on the given day.
function openDayTasksModal(dateStr) {
    calendarState.openDayDate = dateStr;

    if (calElements.dayTasksTitle) {
        const d = new Date(dateStr + 'T00:00:00');
        const formatted = new Intl.DateTimeFormat('ru-RU', {
            day: 'numeric', month: 'long', year: 'numeric'
        }).format(d);
        calElements.dayTasksTitle.textContent = formatted;
    }

    renderDayTasks(dateStr);
    calElements.dayTasksModal?.classList.add('active');
}

function renderDayTasks(dateStr) {
    const body = calElements.dayTasksBody;
    if (!body) return;
    body.innerHTML = '';

    const tasks = calendarTasksForDate(dateStr).slice().sort((a, b) =>
        (a.title || '').localeCompare(b.title || '', 'ru'));

    if (!tasks.length) {
        const empty = document.createElement('p');
        empty.className = 'day-tasks-empty';
        empty.textContent = 'На этот день задач нет';
        body.appendChild(empty);
        return;
    }

    tasks.forEach(task => {
        const key = calendarTaskStatusKey(task);
        const project = state.projects.find(p => p.id === task.projectId);

        const row = document.createElement('div');
        row.className = `day-task-row task-${key}`;

        const info = document.createElement('div');
        info.className = 'day-task-info';

        const title = document.createElement('div');
        title.className = 'day-task-title';
        title.textContent = task.title || 'Задача';
        info.appendChild(title);

        const meta = document.createElement('div');
        meta.className = 'day-task-meta';
        const parts = [];
        if (project?.name) parts.push(project.name);
        if (task.assignee && task.assignee !== 'Не назначен') parts.push(task.assignee);
        meta.textContent = parts.join(' · ') || 'Без проекта';
        info.appendChild(meta);

        const tag = document.createElement('div');
        tag.className = `day-task-status-tag task-${key}`;
        tag.textContent = calendarTaskStatusLabel(key);

        row.appendChild(info);
        row.appendChild(tag);

        // Jump to the task: close the day-tasks modal, switch the workspace
        // to the kanban view and open the task's exact status column with
        // highlight — same behaviour as "Мои задачи".
        const boardView = boardViewForTask(task);
        row.addEventListener('click', () => {
            closeDayTasksModal();
            if (task.projectId) navigateToTask(task.projectId, task.id, boardView);
        });

        body.appendChild(row);
    });
}

function closeDayTasksModal() {
    calElements.dayTasksModal?.classList.remove('active');
    calendarState.openDayDate = null;
}

// ========== GLOBAL AI AGENT CHAT (Task 15) ==========
//
// Client for POST /api/agent-chat (Task 14). That endpoint reads the caller's
// ACCESSIBLE projects/tasks/files via the Admin SDK and answers only from them:
// an owner/admin (or a member with no allowedProjects restriction) sees the
// whole organization, while a restricted member is scoped to their
// allowedProjects — the agent RESPECTS per-user access, it does not bypass it
// (see accessibleProjectIdsFor in api/agent-chat.js). The chat spans the
// caller's whole accessible scope rather than one project, so this UI does not
// scope the chat to the currently open project, and the client-side history is
// intentionally NOT reset when the user switches projects (see agentChatState
// below — nothing here reads state.activeProjectId).
//
// Response shape actually returned by api/agent-chat.js (verified by reading
// the file directly, not assumed from the plan text):
//   - 200 { ok: true, answer, model }                          success
//   - 200 { ok: true, taskProposal, model }                    create preview
//   - 200 { ok: true, deleteProposal }                         delete preview
//   - 200 { ok: true, answer: "<фраза на русском>" }            LLM/context
//         (no `model` field on the "org not found"/"no org"/    fallback —
//          "failed to load"/"OpenRouter not configured" paths)  still ok:true
//   - 401 { error: "Unauthorized" }                             missing/invalid
//                                                                 Firebase ID token
//   - 400 { error: "Invalid JSON body" | "message is required" } validation
//   - 405 { error: "Method not allowed" }                       wrong HTTP verb
// Every failure mode the server can hit for itself (Firestore errors, missing
// OpenRouter key, all models failing) is normalized to HTTP 200 with a
// Russian-language `answer` string — so the client only needs its own
// error-handling path for network failures and the auth/validation 4xx cases,
// not for "the LLM had a bad day".

const AGENT_CHAT_MAX_HISTORY_TURNS = 100; // mirrors MAX_HISTORY_TURNS in api/agent-chat.js
const AGENT_TASK_FILE_MAX_BYTES = 3 * 1024 * 1024;
const AGENT_TASK_FILE_ALLOWED_EXTENSIONS = ['md', 'xlsx', 'xlsm', 'pdf', 'docx'];
// Clickable suggestions in the empty chat state. Clicking one only fills the
// input (no auto-submit) so the user can edit before sending.
const AGENT_CHAT_EXAMPLE_PROMPTS = [
    'Что просрочено?',
    'Создай задачу: название, исполнитель, срок',
    'Что на этой неделе?',
    'Удали все готовые задачи проекта',
];
// How long the input stays locked after a server 429 (mirrors the «подождите
// минуту» window in api/agent-chat.js's rate limiter).
const AGENT_CHAT_RATE_LIMIT_SECONDS = 60;

const agentChatState = {
    // { role: 'user' | 'assistant', content: string }[] — up to 100 turns from
    // this live chat session. The server retains the newest turns verbatim and
    // compactly carries the older part so follow-ups keep names and decisions.
    history: [],
    // Incremented by three lifecycle triggers (not by handleAgentChatSubmit itself
    // firing twice — the synchronous `elements.agentChatInput.disabled`
    // re-entrancy check there already fully serializes sends, so there is no
    // way to reach a second in-flight send while one is pending):
    //
    //   1. closeModalElement() (search this file) — bumped whenever the
    //      agent-chat modal specifically is closed, via any of its three
    //      close paths (.close-modal button, clicking the backdrop, Escape).
    //      Closing the modal does NOT clear agentChatState.history or the
    //      rendered message list (Task 15's plan accepted "in-memory,
    //      resets on reload" as the simple default — closing and reopening
    //      the MODAL, as opposed to reloading the page, keeps showing prior
    //      turns, like a persistent panel). So the race this guards is
    //      narrower than a full reset: close the modal while a send is still
    //      in flight, reopen it, send a NEW message — without this counter
    //      the OLD request's response could still land and either append a
    //      reply after the new user turn or stomp on the newer send's
    //      input-disabled/re-enable lifecycle.
    //   2. onAuthStateChanged()'s signed-out branch (search this file) —
    //      bumped on every real sign-out, whichever path triggered it:
    //      logout() calling `auth.signOut()` (which is immediately followed
    //      by `window.location.reload()`, itself the strongest guard once it
    //      lands, since it destroys the whole JS context — but there is a
    //      window between signOut() resolving and the reload actually
    //      happening), or handleAgentChatSubmit's own 401 handler forcing
    //      `auth.signOut()` when the server rejects the caller's Firebase ID
    //      token. Either way, a logged-out user must never see a stale
    //      agent response render as if it belonged to their (now-ended)
    //      session.
    //
    //   3. resetAgentChatForOrganizationChange() — clears history/cards and
    //      invalidates responses before switching to another organization.
    //
    // The closure created by a given send() captures its own `generation`
    // value and checks it still matches agentChatState.generation before
    // touching the DOM once the network response resolves; a mismatch means
    // one of the two triggers above fired since this send went out, so the
    // response is dropped as a harmless no-op instead of appending a reply
    // to the wrong turn or re-enabling an input that no longer represents
    // the current chat.
    generation: 0,
    // One-off local File selected for "create tasks from attached file".
    // It is never persisted and is cleared as soon as a request starts.
    pendingFile: null,
    // Server 429 lockout: epoch ms until which the chat input must stay
    // disabled, plus the 1s interval driving the visible countdown hint.
    // rateLimitedUntil is checked inside setAgentChatInputDisabled so NO code
    // path (submit finally-block, org-switch reset, etc.) can re-enable the
    // input early; the timer below is the only thing that clears it.
    rateLimitedUntil: 0,
    rateLimitTimer: null,
};

function resetAgentChatForOrganizationChange() {
    // Organization data is a hard trust boundary. Drop both visible cards and
    // model history, invalidate every in-flight response, and clear a selected
    // local document before the workspace switch begins.
    agentChatState.generation += 1;
    agentChatState.history = [];
    agentChatState.pendingFile = null;
    if (elements.agentChatFileInput) elements.agentChatFileInput.value = '';
    if (elements.agentChatInput) {
        elements.agentChatInput.value = '';
        elements.agentChatInput.style.height = '';
    }
    setAgentChatInputDisabled(false);
    renderAgentChatFileChip();
    renderAgentChatEmptyState();
}

function truncateAgentChatHistory(history) {
    if (!Array.isArray(history)) return [];
    return history.slice(-AGENT_CHAT_MAX_HISTORY_TURNS);
}

function canUseAgentTaskFileUpload() {
    return canManageTasks();
}

function updateAgentChatAttachVisibility() {
    if (!elements.agentChatAttachBtn) return;
    const allowed = canUseAgentTaskFileUpload();
    elements.agentChatAttachBtn.hidden = !allowed;
    elements.agentChatAttachBtn.style.display = allowed ? 'flex' : 'none';
    if (!allowed) clearAgentChatFileSelection();
}

function agentTaskFileExtension(filename) {
    const clean = String(filename || '').toLowerCase().split('?')[0].split('#')[0];
    const idx = clean.lastIndexOf('.');
    return idx >= 0 ? clean.slice(idx + 1) : '';
}

function clearAgentChatFileSelection() {
    agentChatState.pendingFile = null;
    if (elements.agentChatFileInput) elements.agentChatFileInput.value = '';
    renderAgentChatFileChip();
}

function renderAgentChatFileChip() {
    const chip = elements.agentChatFileChip;
    if (!chip) return;
    chip.textContent = '';
    const file = agentChatState.pendingFile;
    if (!file) {
        chip.hidden = true;
        return;
    }
    chip.hidden = false;

    const icon = document.createElement('i');
    icon.className = 'fa-solid fa-paperclip';
    chip.appendChild(icon);

    const name = document.createElement('span');
    name.className = 'agent-chat-file-chip-name';
    name.textContent = `${file.name} (${formatFileSize(file.size)})`;
    chip.appendChild(name);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'agent-chat-file-chip-remove';
    remove.title = 'Убрать файл';
    remove.setAttribute('aria-label', 'Убрать файл');
    const removeIcon = document.createElement('i');
    removeIcon.className = 'fa-solid fa-xmark';
    remove.appendChild(removeIcon);
    remove.addEventListener('click', clearAgentChatFileSelection);
    chip.appendChild(remove);
}

function handleAgentChatFileSelect(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    if (!canUseAgentTaskFileUpload()) {
        event.target.value = '';
        appendAgentChatMessage('error', 'Создавать задачи через файл может владелец, админ или модератор.');
        return;
    }

    const ext = agentTaskFileExtension(file.name);
    if (!AGENT_TASK_FILE_ALLOWED_EXTENSIONS.includes(ext)) {
        event.target.value = '';
        appendAgentChatMessage('error', 'Поддерживаются только md, xlsx, xlsm, pdf и docx.');
        return;
    }
    if (file.size > AGENT_TASK_FILE_MAX_BYTES) {
        event.target.value = '';
        appendAgentChatMessage('error', `Файл больше ${formatFileSize(AGENT_TASK_FILE_MAX_BYTES)}. Для создания задач через чат лимит 3 МБ.`);
        return;
    }

    agentChatState.pendingFile = file;
    renderAgentChatFileChip();
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            resolve(result.includes(',') ? result.split(',').pop() : result);
        };
        reader.onerror = () => reject(reader.error || new Error('file read failed'));
        reader.readAsDataURL(file);
    });
}

// Селектор области в шапке чата агента: «Все проекты» или конкретный проект.
// Выбор пользователя главнее открытого проекта; 'all' — пустой projectId,
// сервер отвечает по всем доступным проектам организации.
function populateAgentProjectSelect() {
    const select = document.getElementById('agent-project-select');
    if (!select) return;
    const previous = select.value;
    select.innerHTML = '';
    const allOption = document.createElement('option');
    allOption.value = 'all';
    allOption.textContent = 'Все проекты';
    select.appendChild(allOption);
    getFilteredProjects().forEach(project => {
        if (!project?.id) return;
        const option = document.createElement('option');
        option.value = project.id;
        option.textContent = project.name || 'Без названия';
        select.appendChild(option);
    });
    // Сохраняем прежний выбор, если проект ещё доступен; иначе — открытый
    // проект; иначе — «Все проекты».
    const values = Array.from(select.options).map(o => o.value);
    if (previous && values.includes(previous)) {
        select.value = previous;
    } else if (state.activeProjectId && values.includes(state.activeProjectId)) {
        select.value = state.activeProjectId;
    } else {
        select.value = 'all';
    }
}

function getAgentTaskTargetProject() {
    const select = document.getElementById('agent-project-select');
    if (select && select.value) {
        if (select.value === 'all') return { id: '', name: '' };
        const selected = state.projects.find(p => p.id === select.value);
        if (selected) return selected;
    }
    if (state.activeProjectId) {
        const project = state.projects.find(p => p.id === state.activeProjectId);
        if (project) return project;
        return { id: state.activeProjectId, name: '' };
    }

    const activeItemId = document.querySelector('.project-item.active')?.dataset?.id;
    if (activeItemId) {
        const project = state.projects.find(p => p.id === activeItemId);
        if (project) return project;
        return { id: activeItemId, name: '' };
    }

    const title = elements.projectTitle?.textContent?.trim();
    if (title && title !== 'Выберите проект') {
        const normalizedTitle = title.toLowerCase();
        const project = state.projects.find(p => String(p.name || '').trim().toLowerCase() === normalizedTitle);
        if (project) return project;
        return { id: '', name: title };
    }

    return { id: '', name: '' };
}

// Renders plain text as safe DOM nodes: text via `.textContent` (never
// innerHTML), newlines via one `<br>` element. Used for user/pending/error
// bubbles, which are never Markdown.
function renderAgentChatText(container, text) {
    const lines = String(text ?? '').split('\n');
    lines.forEach((line, index) => {
        container.appendChild(document.createTextNode(line));
        if (index < lines.length - 1) container.appendChild(document.createElement('br'));
    });
}

// ── Safe minimal Markdown renderer for the agent's answers ──────────────────
// The agent's output can be INFLUENCED by org data (indirect prompt injection
// via task titles / uploaded file text), so we must never treat it as trusted
// markup. This renderer NEVER builds an HTML string from model text: every
// piece of model text reaches the DOM only through `.textContent` /
// createTextNode, and we only ever create a fixed whitelist of structural
// elements (table/thead/tbody/tr/th/td, ul/ol/li, strong/em/code, pre, div,
// br). There is therefore no code path that interprets model text as markup —
// `<script>`, `onerror=`, `javascript:` etc. are inert no matter what. Links
// are not rendered as anchors (cleanAnswer already flattens [text](url) → text),
// which removes the only remaining URL/attribute-injection surface.
// Supports: GFM tables, fenced code blocks, #-headings, -/*/•/numbered lists,
// **bold**, *italic*, `inline code`, and paragraphs.
function isMarkdownTableSeparator(line) {
    // A row of dash-runs split by pipes, e.g. "| --- | :---: | ---: |".
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line)
        || /^\s*\|\s*:?-{2,}:?\s*\|\s*$/.test(line); // single-column table
}

function splitMarkdownTableRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
}

// Parse inline **bold** / __bold__ / *italic* / _italic_ / `code` into DOM
// nodes appended to `parent`. Everything else is plain text. No innerHTML.
function appendAgentInline(parent, text) {
    const str = String(text ?? '');
    const re = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_[^_\n]+_)/g;
    let last = 0;
    for (const m of str.matchAll(re)) {
        if (m.index > last) parent.appendChild(document.createTextNode(str.slice(last, m.index)));
        const tok = m[0];
        if (tok.startsWith('`')) {
            const el = document.createElement('code');
            el.className = 'agent-md-code';
            el.textContent = tok.slice(1, -1);
            parent.appendChild(el);
        } else if (tok.startsWith('**') || tok.startsWith('__')) {
            const el = document.createElement('strong');
            el.textContent = tok.slice(2, -2);
            parent.appendChild(el);
        } else {
            const el = document.createElement('em');
            el.textContent = tok.slice(1, -1);
            parent.appendChild(el);
        }
        last = m.index + tok.length;
    }
    if (last < str.length) parent.appendChild(document.createTextNode(str.slice(last)));
}

function buildAgentMarkdownTable(header, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'agent-md-table-wrap';
    const table = document.createElement('table');
    table.className = 'agent-md-table';

    const thead = document.createElement('thead');
    const htr = document.createElement('tr');
    header.forEach((cell) => {
        const th = document.createElement('th');
        appendAgentInline(th, cell);
        htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    rows.forEach((cells) => {
        const tr = document.createElement('tr');
        for (let c = 0; c < header.length; c += 1) {
            const td = document.createElement('td');
            appendAgentInline(td, cells[c] != null ? cells[c] : '');
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    wrap.appendChild(table);
    return wrap;
}

function isAgentMarkdownBlockStart(lines, i) {
    const line = lines[i];
    return /^\s*```/.test(line)
        || (line.includes('|') && i + 1 < lines.length && isMarkdownTableSeparator(lines[i + 1]))
        || /^(#{1,6})\s+/.test(line)
        || /^\s*([-*•]|\d+[.)])\s+/.test(line);
}

function renderAgentChatMarkdown(container, text) {
    const lines = String(text ?? '').split('\n');
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];

        // Fenced code block
        if (/^\s*```/.test(line)) {
            const code = [];
            i += 1;
            while (i < lines.length && !/^\s*```/.test(lines[i])) { code.push(lines[i]); i += 1; }
            i += 1; // skip closing fence
            const pre = document.createElement('pre');
            pre.className = 'agent-md-pre';
            const codeEl = document.createElement('code');
            codeEl.textContent = code.join('\n');
            pre.appendChild(codeEl);
            container.appendChild(pre);
            continue;
        }

        // GFM table (header line followed by a separator line)
        if (line.includes('|') && i + 1 < lines.length && isMarkdownTableSeparator(lines[i + 1])) {
            const header = splitMarkdownTableRow(line);
            i += 2;
            const rows = [];
            while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
                rows.push(splitMarkdownTableRow(lines[i]));
                i += 1;
            }
            container.appendChild(buildAgentMarkdownTable(header, rows));
            continue;
        }

        // Heading
        const h = line.match(/^(#{1,6})\s+(.*)$/);
        if (h) {
            const el = document.createElement('div');
            el.className = 'agent-md-heading';
            appendAgentInline(el, h[2]);
            container.appendChild(el);
            i += 1;
            continue;
        }

        // List (bullet or numbered) — collect consecutive items
        if (/^\s*([-*•]|\d+[.)])\s+/.test(line)) {
            const ordered = /^\s*\d+[.)]\s+/.test(line);
            const listEl = document.createElement(ordered ? 'ol' : 'ul');
            listEl.className = 'agent-md-list';
            while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) {
                const li = document.createElement('li');
                appendAgentInline(li, lines[i].replace(/^\s*([-*•]|\d+[.)])\s+/, ''));
                listEl.appendChild(li);
                i += 1;
            }
            container.appendChild(listEl);
            continue;
        }

        // Blank line — skip (paragraphs are separated visually via CSS margins)
        if (line.trim() === '') { i += 1; continue; }

        // Paragraph: gather consecutive plain lines until the next block/blank
        const para = document.createElement('div');
        para.className = 'agent-md-p';
        let first = true;
        while (i < lines.length && lines[i].trim() !== '' && !isAgentMarkdownBlockStart(lines, i)) {
            if (!first) para.appendChild(document.createElement('br'));
            appendAgentInline(para, lines[i]);
            first = false;
            i += 1;
        }
        container.appendChild(para);
    }
}

// options.retryMessage: when set on an 'error' bubble, appends a small
// «Повторить» button that puts the failed message back into the input and
// re-submits it through the normal handler (so history/truncation/disabled
// bookkeeping stays in exactly one place). Pass null for failures where a
// retry is pointless (401/session-expired) or cannot work (file sends — the
// local File object is already gone by the time the error renders).
function appendAgentChatMessage(role, text, options) {
    if (!elements.agentChatMessages) return null;
    const emptyState = elements.agentChatMessages.querySelector('.agent-chat-empty');
    if (emptyState) emptyState.remove();

    const bubble = document.createElement('div');
    bubble.className = `agent-chat-message agent-chat-message-${role}`;
    // Only the agent's answers get Markdown (tables/lists/etc.); user, pending
    // and error bubbles are short, app- or user-authored plain text.
    const displayText = role === 'assistant' ? formatIsoDatesInText(text) : text;
    if (role === 'assistant') {
        renderAgentChatMarkdown(bubble, displayText);
    } else {
        renderAgentChatText(bubble, displayText);
    }
    const retryMessage = options && typeof options.retryMessage === 'string'
        ? options.retryMessage.trim() : '';
    if (role === 'error' && retryMessage) {
        const retryBtn = document.createElement('button');
        retryBtn.type = 'button';
        retryBtn.className = 'agent-chat-retry-btn';
        retryBtn.textContent = 'Повторить';
        retryBtn.addEventListener('click', () => {
            // Respect whatever currently owns the disabled state (an in-flight
            // send or a 429 lockout) — retrying INTO either would double-send.
            if (!elements.agentChatInput || elements.agentChatInput.disabled) return;
            retryBtn.disabled = true;
            elements.agentChatInput.value = retryMessage;
            autoResizeAgentChatInput();
            handleAgentChatSubmit({ preventDefault() {} });
        });
        bubble.appendChild(retryBtn);
    }
    elements.agentChatMessages.appendChild(bubble);
    elements.agentChatMessages.scrollTop = elements.agentChatMessages.scrollHeight;
    return bubble;
}

function renderAgentChatEmptyState() {
    if (!elements.agentChatMessages) return;
    elements.agentChatMessages.innerHTML = '';
    const empty = document.createElement('div');
    empty.className = 'agent-chat-empty';
    const hint = document.createElement('div');
    hint.textContent = 'Спросите про задачи, сроки, статусы или файлы текущей организации.';
    empty.appendChild(hint);
    const chips = document.createElement('div');
    chips.className = 'agent-chat-chips';
    AGENT_CHAT_EXAMPLE_PROMPTS.forEach(promptText => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'agent-chat-chip';
        chip.textContent = promptText;
        chip.addEventListener('click', () => {
            if (!elements.agentChatInput || elements.agentChatInput.disabled) return;
            elements.agentChatInput.value = promptText;
            autoResizeAgentChatInput();
            elements.agentChatInput.focus();
        });
        chips.appendChild(chip);
    });
    empty.appendChild(chips);
    elements.agentChatMessages.appendChild(empty);
}

// ===== Proposal-card helpers (create / delete / action cards) =====
// All three cards share the same lifecycle: a confirm + cancel button row
// (".agent-task-proposal-actions") that ends in one of three terminal states —
// done (server confirmed), cancelled (purely client-side; the server treats an
// unconfirmed proposal as a no-op, so no cancel call exists or is needed), or
// a live card with an inline error line under the still-enabled buttons.

function setAgentProposalActionsEnabled(actions, enabled) {
    if (!actions) return;
    actions.querySelectorAll('button').forEach(btn => { btn.disabled = !enabled; });
}

// Replaces the whole button row with a one-line terminal status.
function setAgentProposalCardStatus(actions, text, statusClass) {
    if (!actions) return;
    actions.textContent = '';
    const status = document.createElement('div');
    status.className = `agent-task-proposal-status ${statusClass || ''}`.trim();
    status.textContent = text;
    actions.appendChild(status);
}

// Shows (or updates) a non-terminal error line under the buttons — the card
// stays live so the user can retry or cancel.
function showAgentProposalCardError(actions, text) {
    if (!actions) return;
    let err = actions.querySelector('.agent-task-proposal-error');
    if (!err) {
        err = document.createElement('div');
        err.className = 'agent-task-proposal-error';
        actions.appendChild(err);
    }
    err.textContent = text;
}

function buildAgentProposalCancelBtn(actions) {
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'secondary-btn agent-task-proposal-cancel';
    cancelBtn.textContent = 'Отмена';
    cancelBtn.addEventListener('click', () => {
        setAgentProposalActionsEnabled(actions, false);
        actions?.closest('.agent-task-proposal')?.classList.add('agent-task-proposal-cancelled');
        setAgentProposalCardStatus(actions, 'Действие отменено', 'agent-task-proposal-status-cancelled');
    });
    return cancelBtn;
}

// Locks the chat input for `seconds` after a server 429 and shows a live
// countdown above the form. The lockout survives handleAgentChatSubmit's
// finally-block re-enable because setAgentChatInputDisabled consults
// agentChatState.rateLimitedUntil; this timer is the only place that clears it.
function startAgentChatRateLimitCountdown(seconds) {
    const totalSeconds = Number.isFinite(seconds) && seconds > 0
        ? Math.ceil(seconds) : AGENT_CHAT_RATE_LIMIT_SECONDS;
    agentChatState.rateLimitedUntil = Date.now() + totalSeconds * 1000;
    if (agentChatState.rateLimitTimer) {
        clearInterval(agentChatState.rateLimitTimer);
        agentChatState.rateLimitTimer = null;
    }
    const tick = () => {
        const remaining = Math.max(0, Math.ceil((agentChatState.rateLimitedUntil - Date.now()) / 1000));
        if (remaining <= 0) {
            if (agentChatState.rateLimitTimer) {
                clearInterval(agentChatState.rateLimitTimer);
                agentChatState.rateLimitTimer = null;
            }
            agentChatState.rateLimitedUntil = 0;
            if (elements.agentChatRateHint) elements.agentChatRateHint.hidden = true;
            setAgentChatInputDisabled(false);
            elements.agentChatInput?.focus();
            return;
        }
        if (elements.agentChatRateHint) {
            elements.agentChatRateHint.hidden = false;
            elements.agentChatRateHint.textContent = `Можно отправить снова через ${remaining} с.`;
        }
        setAgentChatInputDisabled(true);
    };
    tick();
    agentChatState.rateLimitTimer = setInterval(tick, 1000);
}

// ===== TASK PROPOSAL CARD (создание задач из документа, фаза предпросмотра) =====
// Рендерит карточку «что я создам» из ответа сервера {taskProposal}. DOM
// строится только через createElement/textContent (никакого innerHTML с
// данными). Кнопка создания видна лишь когда сервер сказал canCreate — и
// сервер всё равно перепроверит права на фазе 2.
function appendAgentTaskProposal(proposal) {
    if (!elements.agentChatMessages || !proposal || !Array.isArray(proposal.tasks)) return;
    const emptyState = elements.agentChatMessages.querySelector('.agent-chat-empty');
    if (emptyState) emptyState.remove();

    const card = document.createElement('div');
    card.className = 'agent-chat-message agent-chat-message-assistant agent-task-proposal';

    const heading = document.createElement('div');
    heading.className = 'agent-task-proposal-title';
    const proposalSourceTitle = proposal.source === 'text'
        ? 'Задачи из текстового запроса'
        : `Задачи из документа «${proposal.file || ''}»`;
    heading.textContent = `${proposalSourceTitle} (проект «${proposal.projectName || ''}»)`;
    card.appendChild(heading);

    if (proposal.truncated) {
        const warn = document.createElement('div');
        warn.className = 'agent-notify-time';
        warn.textContent = '⚠️ Документ большой — показана часть задач. Создайте эти и попросите следующую порцию.';
        card.appendChild(warn);
    }

    const table = document.createElement('table');
    table.className = 'agent-task-proposal-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const proposalColumns = proposal.multiProject
        ? ['Задача', 'Проект', 'Срок', 'Ответственный', 'Статус']
        : ['Задача', 'Срок', 'Ответственный', 'Статус'];
    proposalColumns.forEach(label => {
        const th = document.createElement('th');
        th.textContent = label;
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    proposal.tasks.forEach(t => {
        const tr = document.createElement('tr');
        const taskCell = document.createElement('td');
        const taskTitle = document.createElement('div');
        taskTitle.textContent = t.title || '';
        taskCell.appendChild(taskTitle);
        if (typeof t.description === 'string' && t.description.trim()) {
            const taskDescription = document.createElement('div');
            taskDescription.className = 'agent-task-proposal-description';
            taskDescription.textContent = t.description.trim();
            taskCell.appendChild(taskDescription);
        }
        // Доп. постановщики (если агенту их назвали) — приписываем к
        // ответственному, чтобы не раздувать таблицу отдельной колонкой.
        const assigneeCellText = (t.assigneeDisplay || t.assigneeName || 'Не назначен')
            + (t.coCreatorDisplay ? ` (доп. постановщики: ${t.coCreatorDisplay})` : '');
        const cells = proposal.multiProject
            ? [
                t.projectName || '—',
                t.deadline ? formatDate(t.deadline) : '—',
                assigneeCellText,
                t.ok ? '✅ будет создана' : `⚠️ ${t.reason || 'не будет создана'}`
            ]
            : [
                t.deadline ? formatDate(t.deadline) : '—',
                assigneeCellText,
                t.ok ? '✅ будет создана' : `⚠️ ${t.reason || 'не будет создана'}`
            ];
        tr.appendChild(taskCell);
        cells.forEach(value => {
            const td = document.createElement('td');
            td.textContent = value;
            tr.appendChild(td);
        });
        if (!t.ok) tr.className = 'agent-task-proposal-skip';
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    // Таблица может быть шире пузыря — скроллим внутри карточки.
    const scroller = document.createElement('div');
    scroller.className = 'agent-task-proposal-scroll';
    scroller.appendChild(table);
    card.appendChild(scroller);

    // Срок опционален: строка без дедлайна тоже создаётся (deadline: null).
    // Исполнитель опционален: ok-строка без assigneeUid создаётся как
    // «Не назначен» (пользователь вправе просить «без ответственных»).
    const okTasks = proposal.tasks.filter(t => t.ok);
    if (proposal.canCreate && okTasks.length > 0) {
        const actions = document.createElement('div');
        actions.className = 'agent-task-proposal-actions';
        const btn = document.createElement('button');
        btn.className = 'primary-btn agent-task-proposal-create';
        btn.textContent = `Создать ${okTasks.length} задач(и)`;
        btn.addEventListener('click', () => {
            // Disable the whole row (confirm AND cancel) while the request is
            // in flight — cancelling mid-flight would mislabel tasks the
            // server is already creating.
            setAgentProposalActionsEnabled(actions, false);
            btn.textContent = 'Создаю…';
            confirmAgentTaskProposal(proposal, okTasks, btn, actions);
        });
        actions.appendChild(btn);
        actions.appendChild(buildAgentProposalCancelBtn(actions));
        card.appendChild(actions);
    } else if (okTasks.length === 0) {
        const note = document.createElement('div');
        note.className = 'agent-task-proposal-note';
        note.textContent = 'Создавать нечего: ни одна строка не прошла проверку.';
        card.appendChild(note);
    } else if (!proposal.canCreate) {
        const note = document.createElement('div');
        note.className = 'agent-task-proposal-note';
        note.textContent = 'Создавать задачи может владелец, админ или модератор с доступом к проекту.';
        card.appendChild(note);
    }

    elements.agentChatMessages.appendChild(card);
    elements.agentChatMessages.scrollTop = elements.agentChatMessages.scrollHeight;
}

// Фаза 2: подтверждение — POST {action:'create_tasks'} на тот же endpoint.
// On success the button row becomes a «✓ Задачи созданы» status line (same
// done-state as iOS); on failure the row is re-enabled and the server message
// is shown inline in the card so it can't be missed between chat bubbles.
async function confirmAgentTaskProposal(proposal, okTasks, btn, actions) {
    try {
        const currentUser = firebase.auth().currentUser;
        if (!currentUser) throw new Error('Не авторизован');
        const idToken = await currentUser.getIdToken();
        const res = await fetch('/api/agent-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({
                action: 'create_tasks',
                proposalId: proposal.proposalId || '',
                projectId: proposal.projectId,
                file: proposal.source === 'text' ? '' : (proposal.file || ''),
                tasks: okTasks.map(t => ({
                    title: t.title,
                    description: t.description || '',
                    deadline: t.deadline || null,
                    assigneeUid: t.assigneeUid || null,
                    coCreatorUids: Array.isArray(t.coCreatorUids) ? t.coCreatorUids : [],
                    projectId: t.projectId || null,
                }))
            })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && data.ok && Number.isInteger(data.created)) {
            if (actions) setAgentProposalCardStatus(actions, '✓ Задачи созданы', 'agent-task-proposal-status-done');
            else if (btn) btn.remove();
            const doneText = `✅ Создано задач: ${data.created}. Проект «${proposal.projectName || ''}», раздел «Назначенные». Исполнители получили уведомления.`;
            appendAgentChatMessage('assistant', doneText);
            agentChatState.history.push({ role: 'assistant', content: doneText });
            agentChatState.history = truncateAgentChatHistory(agentChatState.history);
        } else {
            if (btn) { btn.disabled = false; btn.textContent = `Создать ${okTasks.length} задач(и)`; }
            setAgentProposalActionsEnabled(actions, true);
            const detail = data && typeof data.error === 'string' ? data.error : 'Попробуйте ещё раз.';
            if (actions) showAgentProposalCardError(actions, `Не удалось создать задачи: ${detail}`);
            else appendAgentChatMessage('error', `Не удалось создать задачи: ${detail}`);
        }
    } catch (error) {
        if (btn) { btn.disabled = false; btn.textContent = `Создать ${okTasks.length} задач(и)`; }
        setAgentProposalActionsEnabled(actions, true);
        console.error('agent-chat create_tasks failed:', error);
        if (actions) showAgentProposalCardError(actions, 'Ошибка сети при создании задач. Попробуйте ещё раз.');
        else appendAgentChatMessage('error', 'Ошибка сети при создании задач. Попробуйте ещё раз.');
    }
}

// ===== DELETE PROPOSAL CARD (удаление задач, фаза предпросмотра) =====
// Mirrors appendAgentTaskProposal: all task data is inserted via textContent,
// and the actual destructive action happens only after an explicit button click.
function appendAgentDeleteProposal(proposal) {
    if (!elements.agentChatMessages || !proposal || !Array.isArray(proposal.tasks)) return;
    const emptyState = elements.agentChatMessages.querySelector('.agent-chat-empty');
    if (emptyState) emptyState.remove();

    const card = document.createElement('div');
    card.className = 'agent-chat-message agent-chat-message-assistant agent-task-proposal agent-delete-proposal';

    const heading = document.createElement('div');
    heading.className = 'agent-task-proposal-title';
    heading.textContent = `Удаление задач: ${proposal.filterLabel || 'выбранные задачи'} (проект «${proposal.projectName || ''}»)`;
    card.appendChild(heading);

    const warning = document.createElement('div');
    warning.className = 'agent-task-proposal-note agent-delete-proposal-warning';
    warning.textContent = 'После подтверждения эти задачи будут удалены без восстановления.';
    card.appendChild(warning);

    const table = document.createElement('table');
    table.className = 'agent-task-proposal-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    ['Задача', 'Срок', 'Ответственный', 'Статус'].forEach(label => {
        const th = document.createElement('th');
        th.textContent = label;
        headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    proposal.tasks.forEach(t => {
        const tr = document.createElement('tr');
        [
            t.title || '',
            t.deadline ? formatDate(t.deadline) : '—',
            t.assigneeDisplay || 'Не назначен',
            t.statusDisplay || ''
        ].forEach(value => {
            const td = document.createElement('td');
            td.textContent = value;
            tr.appendChild(td);
        });
        tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    const scroller = document.createElement('div');
    scroller.className = 'agent-task-proposal-scroll';
    scroller.appendChild(table);
    card.appendChild(scroller);

    const deletableTasks = proposal.tasks.filter(t => t.id);
    if (proposal.canDelete && deletableTasks.length > 0) {
        const actions = document.createElement('div');
        actions.className = 'agent-task-proposal-actions';
        const btn = document.createElement('button');
        btn.className = 'primary-btn agent-task-proposal-create agent-task-proposal-delete';
        btn.textContent = `Удалить ${deletableTasks.length} задач(и)`;
        btn.addEventListener('click', () => {
            setAgentProposalActionsEnabled(actions, false);
            btn.textContent = 'Удаляю…';
            confirmAgentDeleteProposal(proposal, deletableTasks, btn, actions);
        });
        actions.appendChild(btn);
        actions.appendChild(buildAgentProposalCancelBtn(actions));
        card.appendChild(actions);
    } else {
        const note = document.createElement('div');
        note.className = 'agent-task-proposal-note';
        note.textContent = 'Удалять задачи может владелец, админ или модератор с доступом к проекту.';
        card.appendChild(note);
    }

    elements.agentChatMessages.appendChild(card);
    elements.agentChatMessages.scrollTop = elements.agentChatMessages.scrollHeight;
}

async function confirmAgentDeleteProposal(proposal, tasksToDelete, btn, actions) {
    try {
        const currentUser = firebase.auth().currentUser;
        if (!currentUser) throw new Error('Не авторизован');
        const idToken = await currentUser.getIdToken();
        const res = await fetch('/api/agent-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({
                action: 'delete_tasks',
                proposalId: proposal.proposalId || '',
                projectId: proposal.projectId,
                taskIds: tasksToDelete.map(t => t.id)
            })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data && data.ok && Number.isInteger(data.deleted)) {
            if (actions) setAgentProposalCardStatus(actions, '✓ Задачи удалены', 'agent-task-proposal-status-done');
            else if (btn) btn.remove();
            const doneText = `✅ Удалено задач: ${data.deleted}. Проект «${proposal.projectName || ''}».`;
            appendAgentChatMessage('assistant', doneText);
            agentChatState.history.push({ role: 'assistant', content: doneText });
            agentChatState.history = truncateAgentChatHistory(agentChatState.history);
        } else {
            if (btn) { btn.disabled = false; btn.textContent = `Удалить ${tasksToDelete.length} задач(и)`; }
            setAgentProposalActionsEnabled(actions, true);
            const detail = data && typeof data.error === 'string' ? data.error : 'Попробуйте сформировать карточку удаления заново.';
            if (actions) showAgentProposalCardError(actions, `Не удалось удалить задачи: ${detail}`);
            else appendAgentChatMessage('error', `Не удалось удалить задачи: ${detail}`);
        }
    } catch (error) {
        if (btn) { btn.disabled = false; btn.textContent = `Удалить ${tasksToDelete.length} задач(и)`; }
        setAgentProposalActionsEnabled(actions, true);
        console.error('agent-chat delete_tasks failed:', error);
        if (actions) showAgentProposalCardError(actions, 'Ошибка сети при удалении задач. Попробуйте ещё раз.');
        else appendAgentChatMessage('error', 'Ошибка сети при удалении задач. Попробуйте ещё раз.');
    }
}

function appendAgentActionProposal(proposal) {
    if (!elements.agentChatMessages || !proposal || typeof proposal.action !== 'string') return;
    const emptyState = elements.agentChatMessages.querySelector('.agent-chat-empty');
    if (emptyState) emptyState.remove();

    const card = document.createElement('div');
    card.className = `agent-chat-message agent-chat-message-assistant agent-task-proposal${proposal.destructive ? ' agent-delete-proposal' : ''}`;
    const heading = document.createElement('div');
    heading.className = 'agent-task-proposal-title';
    heading.textContent = proposal.title || 'Подтверждение действия';
    card.appendChild(heading);
    const summary = document.createElement('div');
    summary.className = 'agent-task-proposal-note';
    summary.textContent = formatIsoDatesInText(proposal.summary || '');
    card.appendChild(summary);
    const actions = document.createElement('div');
    actions.className = 'agent-task-proposal-actions';
    const btn = document.createElement('button');
    btn.className = `primary-btn agent-task-proposal-create${proposal.destructive ? ' agent-task-proposal-delete' : ''}`;
    btn.textContent = proposal.confirmLabel || 'Подтвердить';
    btn.addEventListener('click', () => {
        setAgentProposalActionsEnabled(actions, false);
        confirmAgentActionProposal(proposal, btn, actions);
    });
    actions.appendChild(btn);
    actions.appendChild(buildAgentProposalCancelBtn(actions));
    card.appendChild(actions);
    elements.agentChatMessages.appendChild(card);
    elements.agentChatMessages.scrollTop = elements.agentChatMessages.scrollHeight;
}

async function confirmAgentActionProposal(proposal, btn, actions) {
    try {
        setButtonLoading(btn, true, 'Выполняем…');
        const currentUser = firebase.auth().currentUser;
        if (!currentUser) throw new Error('Не авторизован');
        const idToken = await currentUser.getIdToken();
        const res = await fetch('/api/agent-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({
                action: 'execute_agent_action',
                proposalId: proposal.proposalId || '',
                agentAction: proposal.action,
                payload: proposal.payload || {},
            }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data?.ok) {
            throw new Error(typeof data?.error === 'string' ? data.error : 'Действие не выполнено');
        }
        if (actions) setAgentProposalCardStatus(actions, '✓ Действие выполнено', 'agent-task-proposal-status-done');
        else btn?.remove();
        const resultText = typeof data.result === 'string' ? `✅ ${data.result}` : '✅ Действие выполнено.';
        appendAgentChatMessage('assistant', resultText);
        agentChatState.history.push({ role: 'assistant', content: resultText });
        agentChatState.history = truncateAgentChatHistory(agentChatState.history);
    } catch (error) {
        setButtonLoading(btn, false);
        setAgentProposalActionsEnabled(actions, true);
        const failText = `Не удалось выполнить действие: ${error.message || 'попробуйте ещё раз'}`;
        if (actions) showAgentProposalCardError(actions, failText);
        else appendAgentChatMessage('error', failText);
    }
}

function setAgentChatInputDisabled(disabled) {
    // A 429 lockout owns the disabled state until it expires: suppress any
    // re-enable attempt (submit finally-block, org-switch reset, …) while the
    // countdown is still running. startAgentChatRateLimitCountdown clears
    // rateLimitedUntil first, so its own re-enable call passes through.
    if (!disabled && agentChatState.rateLimitedUntil && Date.now() < agentChatState.rateLimitedUntil) {
        disabled = true;
    }
    if (elements.agentChatInput) elements.agentChatInput.disabled = disabled;
    if (elements.agentChatSendBtn) elements.agentChatSendBtn.disabled = disabled;
    if (elements.agentChatAttachBtn) elements.agentChatAttachBtn.disabled = disabled || !canUseAgentTaskFileUpload();
}

// Sends one message to the global agent endpoint. Attaches the current
// Firebase ID token fresh on every call (getIdToken() returns a cached token
// and silently refreshes it in the background when needed, so this is cheap
// and always current — no manual expiry tracking required).
async function sendAgentMessage(message, history) {
    const currentUser = firebase.auth().currentUser;
    if (!currentUser) {
        // Distinct from a 401 from the server: we never even attempt the
        // request if there's no signed-in user locally (e.g. auth state
        // flipped to signed-out while the chat panel was open).
        const err = new Error('not-authenticated');
        err.code = 'not-authenticated';
        throw err;
    }
    const idToken = await currentUser.getIdToken();
    // Hard client-side timeout: without it a stalled connection leaves
    // «Агент печатает…» hanging forever (the server itself answers in well
    // under a minute — 2 models × 9s OpenRouter timeout + Firestore reads).
    // Feature-detected: environments without AbortController (old browsers,
    // the vm test harness) just skip the timeout rather than crash.
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 75000) : null;
    const targetProject = getAgentTaskTargetProject();
    let res;
    try {
        res = await fetch('/api/agent-chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({
                message,
                history,
                projectId: targetProject.id || '',
                projectName: targetProject.name || '',
                // Явный выбор проекта в селекторе чата — жёсткая область:
                // агент отвечает только в рамках этого проекта.
                projectScope: document.getElementById('agent-project-select')?.value
                    && document.getElementById('agent-project-select').value !== 'all'
                    ? 'only' : '',
                clientPlatform: 'web',
                clientToday: localDateStr(new Date())
            }),
            ...(controller ? { signal: controller.signal } : {}),
        });
    } catch (error) {
        if (error && error.name === 'AbortError') {
            const err = new Error('timeout');
            err.code = 'timeout';
            throw err;
        }
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
    }
    let data = null;
    try {
        data = await res.json();
    } catch {
        // Non-JSON body (e.g. an upstream proxy error page) — treat as a
        // generic failure below rather than throwing a confusing parse error.
        data = null;
    }
    return { status: res.status, data };
}

async function performAgentNavigation(navigation) {
    if (!navigation || typeof navigation.target !== 'string') return false;
    const closeChat = () => elements.agentChatModal?.classList.remove('active');
    switch (navigation.target) {
        case 'projects':
            closeChat();
            closeSidebarOnMobile();
            return true;
        case 'my_tasks':
            closeChat();
            await openMyTasksModal();
            return true;
        case 'notifications':
            closeChat();
            renderAgentNotifyList();
            document.getElementById('agent-notify-modal')?.classList.add('active');
            return true;
        case 'profile':
            closeChat();
            openProfileModal();
            return true;
        case 'calendar':
            // Календарь теперь — вид рабочей области активного проекта
            if (!state.activeProjectId) return false;
            closeChat();
            setProjectView('calendar');
            return true;
        case 'help':
            closeChat();
            elements.helpModal?.classList.add('active');
            return true;
        case 'team':
            if (!hasPermission('manage_users')) return false;
            closeChat();
            elements.adminPanelModal?.classList.add('active');
            return true;
        case 'project':
            if (!navigation.projectId || !state.projects.some(project => project.id === navigation.projectId)) return false;
            closeChat();
            selectProject(navigation.projectId);
            return true;
        case 'task':
            if (!navigation.projectId || !navigation.taskId) return false;
            closeChat();
            await navigateToTask(navigation.projectId, navigation.taskId);
            return true;
        default:
            return false;
    }
}

async function sendAgentTaskFileMessage(message, file) {
    const currentUser = firebase.auth().currentUser;
    if (!currentUser) {
        const err = new Error('not-authenticated');
        err.code = 'not-authenticated';
        throw err;
    }
    if (!file) throw new Error('file-required');

    const idToken = await currentUser.getIdToken();
    const base64 = await readFileAsBase64(file);
    const targetProject = getAgentTaskTargetProject();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 75000) : null;
    let res;
    try {
        res = await fetch('/api/agent-task-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
            body: JSON.stringify({
                message,
                projectId: targetProject.id || '',
                projectName: targetProject.name || '',
                file: {
                    filename: file.name,
                    mimeType: file.type || '',
                    sizeBytes: file.size,
                    base64
                }
            }),
            ...(controller ? { signal: controller.signal } : {}),
        });
    } catch (error) {
        if (error && error.name === 'AbortError') {
            const err = new Error('timeout');
            err.code = 'timeout';
            throw err;
        }
        throw error;
    } finally {
        if (timer) clearTimeout(timer);
    }
    let data = null;
    try {
        data = await res.json();
    } catch {
        data = null;
    }
    return { status: res.status, data };
}

async function handleAgentChatSubmit(event) {
    event.preventDefault();
    if (!elements.agentChatInput) return;

    // Re-entrancy guard: setAgentChatInputDisabled(true) below disables the
    // textarea/button while a request is in flight, which stops real user
    // interaction (clicks, typed Enter) from re-triggering submit — but
    // form.requestSubmit() (used by the Enter-key handler) can still fire
    // programmatically regardless of the disabled attribute, so check
    // explicitly rather than relying on the DOM disabled state alone.
    if (elements.agentChatInput.disabled) return;

    const message = elements.agentChatInput.value.trim();
    const fileForRequest = agentChatState.pendingFile;
    if (!message && !fileForRequest) return;
    if (fileForRequest && !canUseAgentTaskFileUpload()) {
        appendAgentChatMessage('error', 'Создавать задачи через файл может владелец, админ или модератор.');
        clearAgentChatFileSelection();
        return;
    }

    // Bump the generation counter for this send. Any previously in-flight
    // send's callback will see its captured generation is now stale and bail
    // out before touching the DOM/state below.
    agentChatState.generation += 1;
    const myGeneration = agentChatState.generation;

    const renderedUserMessage = fileForRequest
        ? (message ? `${message}\n\nФайл: ${fileForRequest.name}` : `Файл: ${fileForRequest.name}`)
        : message;

    appendAgentChatMessage('user', renderedUserMessage);
    agentChatState.history.push({ role: 'user', content: renderedUserMessage });
    agentChatState.history = truncateAgentChatHistory(agentChatState.history);

    elements.agentChatInput.value = '';
    if (fileForRequest) clearAgentChatFileSelection();
    autoResizeAgentChatInput();
    setAgentChatInputDisabled(true);
    const pendingBubble = appendAgentChatMessage('pending', fileForRequest ? 'Агент анализирует файл…' : 'Агент печатает…');

    // History sent to the server is everything BEFORE this user turn (the
    // server appends the current `message` itself) — matches the shape
    // api/agent-chat.js expects: `messages = [system, ...history, user]`.
    const historyForRequest = truncateAgentChatHistory(agentChatState.history.slice(0, -1));

    try {
        const { status, data } = fileForRequest
            ? await sendAgentTaskFileMessage(message, fileForRequest)
            : await sendAgentMessage(message, historyForRequest);

        // Staleness guard: if a newer send has started (or the chat was
        // reset/closed) since this request went out, drop the result. Do NOT
        // re-enable the input here either — the newer send already owns that.
        if (myGeneration !== agentChatState.generation) return;

        if (status === 200 && data && data.ok) {
            if (data.navigation && typeof data.navigation === 'object') {
                const opened = await performAgentNavigation(data.navigation);
                const answer = opened
                    ? (typeof data.answer === 'string' && data.answer.trim() ? data.answer : 'Раздел открыт.')
                    : 'Не удалось открыть раздел: доступ изменился или объект больше не существует.';
                appendAgentChatMessage(opened ? 'assistant' : 'error', answer);
                agentChatState.history.push({ role: 'assistant', content: answer });
                agentChatState.history = truncateAgentChatHistory(agentChatState.history);
            } else if (data.actionProposal && typeof data.actionProposal === 'object') {
                appendAgentActionProposal(data.actionProposal);
                const summary = `Подготовлено действие: ${data.actionProposal.title || data.actionProposal.action}. Ожидается подтверждение.`;
                agentChatState.history.push({ role: 'assistant', content: summary });
                agentChatState.history = truncateAgentChatHistory(agentChatState.history);
            } else if (data.taskProposal && typeof data.taskProposal === 'object') {
                // Предпросмотр задач из текста/документа: карточка + кнопка. В историю
                // для LLM кладём компактный текст, а не карточку.
                appendAgentTaskProposal(data.taskProposal);
                const total = Array.isArray(data.taskProposal.tasks) ? data.taskProposal.tasks.length : 0;
                const okCount = Array.isArray(data.taskProposal.tasks)
                    ? data.taskProposal.tasks.filter(t => t.ok).length : 0;
                const proposalSource = data.taskProposal.source === 'text'
                    ? 'из текстового запроса'
                    : `из документа «${data.taskProposal.file || ''}»`;
                const summary = `Предложены задачи ${proposalSource}: к созданию ${okCount} из ${total}.`;
                agentChatState.history.push({ role: 'assistant', content: summary });
                agentChatState.history = truncateAgentChatHistory(agentChatState.history);
            } else if (data.deleteProposal && typeof data.deleteProposal === 'object') {
                appendAgentDeleteProposal(data.deleteProposal);
                const total = Array.isArray(data.deleteProposal.tasks) ? data.deleteProposal.tasks.length : 0;
                const summary = `Предложено удаление задач: ${total}. Проект «${data.deleteProposal.projectName || ''}».`;
                agentChatState.history.push({ role: 'assistant', content: summary });
                agentChatState.history = truncateAgentChatHistory(agentChatState.history);
            } else {
                const answer = typeof data.answer === 'string' && data.answer.trim()
                    ? data.answer
                    : 'Агент не смог сформировать ответ. Попробуйте переформулировать вопрос.';
                appendAgentChatMessage('assistant', answer);
                agentChatState.history.push({ role: 'assistant', content: answer });
                agentChatState.history = truncateAgentChatHistory(agentChatState.history);
            }
        } else if (status === 401) {
            // Token expired/invalid server-side — a generic error message
            // would be misleading here since retrying with the same (stale)
            // client-side auth state will just 401 again. Show the notice
            // briefly, then actually sign the user out: a server 401 doesn't
            // flip local Firebase auth state on its own, so without this the
            // app UI behind the still-open chat modal would keep rendering
            // as if fully authenticated with no way to discover how to
            // re-login now that Task 12 replaced the login form with the
            // Telegram Login Widget in #auth-overlay. Calling auth.signOut()
            // (same cached `auth` reference logout() uses, not a fresh
            // firebase.auth() call) triggers the existing onAuthStateChanged
            // handler, which calls showAuthScreen() and routes the user back
            // to the Telegram widget automatically.
            appendAgentChatMessage('error', 'Сессия истекла. Пожалуйста, войдите заново, чтобы продолжить общение с агентом.');
            // Drop the user's turn from history since the server never
            // actually processed it — resending it later as prior "history"
            // context would misrepresent what the agent has seen.
            agentChatState.history.pop();
            // Use the full logout() path (not a bare auth.signOut()) so presence
            // heartbeat + Firestore listeners are torn down — otherwise they kept
            // running after sign-out. Small delay so the notice is readable before
            // logout() reloads the page back to the login screen.
            setTimeout(() => { logout(); }, 1500);
        } else if (status === 429) {
            // Server-side rate limit (api/agent-chat.js returns the Russian
            // explanation in data.error). Show THAT text instead of the
            // generic failure, drop the unprocessed user turn from history,
            // and lock the input for a minute with a visible countdown —
            // without the lockout users kept hammering Send into more 429s.
            // The retry button stays inert while the lockout owns the input.
            const detail = data && typeof data.error === 'string' && data.error.trim()
                ? data.error
                : 'Слишком много запросов подряд. Подождите минуту и попробуйте снова.';
            appendAgentChatMessage('error', detail, { retryMessage: message || null });
            agentChatState.history.pop();
            startAgentChatRateLimitCountdown(AGENT_CHAT_RATE_LIMIT_SECONDS);
        } else if (status === 400) {
            // Validation error from a well-formed client call "shouldn't"
            // happen, but defend anyway (e.g. a future server-side change
            // tightens validation in a way this client hasn't caught up to).
            const detail = data && typeof data.error === 'string' ? data.error : null;
            appendAgentChatMessage('error', detail
                ? `Не удалось отправить сообщение: ${detail}`
                : 'Не удалось отправить сообщение. Попробуйте ещё раз.',
                { retryMessage: message || null });
            agentChatState.history.pop();
        } else {
            appendAgentChatMessage('error', 'Не удалось получить ответ от агента. Попробуйте ещё раз.',
                { retryMessage: message || null });
            agentChatState.history.pop();
        }
    } catch (error) {
        if (myGeneration !== agentChatState.generation) return;

        if (error && error.code === 'not-authenticated') {
            appendAgentChatMessage('error', 'Вы вышли из аккаунта. Войдите заново, чтобы продолжить общение с агентом.');
        } else if (error && error.code === 'timeout') {
            appendAgentChatMessage('error', 'Агент отвечает слишком долго. Запрос прерван — попробуйте ещё раз (при большом документе сформулируйте запрос точнее).',
                { retryMessage: message || null });
        } else {
            // fetch() itself rejected — network failure (offline, DNS, CORS,
            // timeout before headers, etc.), not a server-returned status.
            console.error('agent-chat: network error', error);
            appendAgentChatMessage('error', 'Ошибка сети. Проверьте подключение к интернету и попробуйте ещё раз.',
                { retryMessage: message || null });
        }
        agentChatState.history.pop();
    } finally {
        // Always clear THIS send's "Агент печатает…" bubble — even if the result
        // was discarded above because the chat was closed/reset mid-request
        // (which bumps the generation). Otherwise the pending bubble is orphaned
        // and shows forever on reopen. Removing our own bubble never affects a
        // newer send's bubble.
        if (pendingBubble) pendingBubble.remove();
        // Only the send that "owns" the current generation re-enables input —
        // if a newer generation has already started, it's already managing
        // its own disabled/enabled lifecycle and this stale call must not
        // interfere (e.g. flipping the input back to enabled mid-way through
        // a newer, still-in-flight request).
        if (myGeneration === agentChatState.generation) {
            setAgentChatInputDisabled(false);
            elements.agentChatInput?.focus();
        }
    }
}

function autoResizeAgentChatInput() {
    const input = elements.agentChatInput;
    if (!input) return;
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}

function initAgentChat() {
    if (!elements.agentChatBtn || !elements.agentChatModal) return;

    renderAgentChatEmptyState();
    updateAgentChatAttachVisibility();

    elements.agentChatBtn.addEventListener('click', () => {
        // Исполнителям агент недоступен (см. applyRoleRestrictions) — клик
        // игнорируется; сервер в любом случае ответит 403.
        if (!canManageTasks()) return;
        playClickSound();
        closeSidebarOnMobile(); // otherwise the chat opens behind the open mobile sidebar
        populateAgentProjectSelect();
        elements.agentChatModal.classList.add('active');
        elements.agentChatInput?.focus();
    });

    if (elements.agentChatAttachBtn && elements.agentChatFileInput) {
        elements.agentChatAttachBtn.addEventListener('click', () => {
            if (!canUseAgentTaskFileUpload()) return;
            elements.agentChatFileInput.click();
        });
        elements.agentChatFileInput.addEventListener('change', handleAgentChatFileSelect);
    }


    if (elements.agentChatForm) {
        elements.agentChatForm.addEventListener('submit', handleAgentChatSubmit);
    }

    if (elements.agentChatInput) {
        elements.agentChatInput.addEventListener('input', autoResizeAgentChatInput);
        // Enter sends, Shift+Enter inserts a newline (standard chat-input convention).
        elements.agentChatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                elements.agentChatForm?.requestSubmit();
            }
        });
    }
}

// ========== END GLOBAL AI AGENT CHAT ==========
