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

function proceedToApp() {
    // DON'T hide loading screen here - let it stay until fully loaded
    // Just initialize Firebase - onAuthStateChanged will handle the rest
    initFirebase();
}

// Button loading state helper
function setButtonLoading(button, isLoading, originalText) {
    if (isLoading) {
        button.disabled = true;
        button.dataset.originalText = originalText;
        button.innerHTML = '<span class="btn-spinner"></span>';
    } else {
        button.disabled = false;
        button.innerHTML = originalText || button.dataset.originalText;
    }
}

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
                <div class="attachment-name">${attachment.name}</div>
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

    // 1. OFFICE DOCUMENTS (Word, Excel) -> Download directly (most reliable)
    if (['word', 'excel'].includes(fileType)) {
        // Create download link
        const link = document.createElement('a');
        link.href = attachment.url;
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
    const newWindow = window.open(attachment.url, '_blank');

    if (!newWindow) {
        alert('Не удалось открыть файл. Возможно, заблокировано всплывающее окно.');
    }

    playClickSound();
}

// Show no preview available
function showNoPreview(container, attachment) {
    const fileType = attachment.type || getFileType(attachment.name);
    const iconClass = getFileIcon(fileType);

    container.innerHTML = `
        <div class="no-preview">
            <i class="fa-solid ${iconClass}"></i>
            <p>Предпросмотр недоступен для этого типа файла</p>
            <a href="${attachment.url}" download="${attachment.name}" class="primary-btn">
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
        // Force download URL (clean)
        let downloadUrl = attachment.url;

        // Google Docs Viewer URL for Office files
        let viewUrl = attachment.url;
        let isViewable = true;

        if (['word', 'excel', 'ppt'].includes(fileType)) {
            viewUrl = `https://docs.google.com/viewer?url=${encodeURIComponent(attachment.url)}&embedded=false`;
        } else if (!['pdf', 'image'].includes(fileType)) {
            // For archives etc, view acts same as download
            isViewable = false;
        }

        item.innerHTML = `
            <div class="attachment-icon ${fileType}">
                <i class="fa-solid ${iconClass}"></i>
            </div>
            <div class="attachment-info">
                <div class="attachment-name">${attachment.name}</div>
                <div class="attachment-size">${formatFileSize(attachment.size || 0)}</div>
            </div>
            <div class="file-actions" style="display: flex; gap: 10px; align-items: center;">
                ${isViewable ? `
                <div class="action-btn view-btn" title="Просмотреть">
                    <i class="fa-solid fa-eye"></i>
                </div>` : ''}
                <a href="${downloadUrl}" target="_blank" download="${attachment.name}" class="action-btn download-link" title="Скачать">
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

// Generate random invite code
function generateInviteCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No confusing chars like 0/O, 1/I
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Check if invite code is unique
async function isInviteCodeUnique(code) {
    const snapshot = await db.collection('organizations').where('inviteCode', '==', code).get();
    return snapshot.empty;
}

// Generate unique invite code
async function generateUniqueInviteCode() {
    let code = generateInviteCode();
    let attempts = 0;
    while (!(await isInviteCodeUnique(code)) && attempts < 10) {
        code = generateInviteCode();
        attempts++;
    }
    return code;
}

// Create organization
async function createOrganization(name) {
    if (!state.currentUser) throw new Error('Не авторизован');

    const inviteCode = await generateUniqueInviteCode();

    const orgData = {
        name: name.trim(),
        inviteCode: inviteCode,
        ownerId: state.currentUser.uid,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        membersCount: 1,
        plan: 'free',
        settings: {
            maxUsers: 100,
            allowInvites: true
        }
    };

    const orgRef = await db.collection('organizations').add(orgData);

    // Update user with organization (use set with merge to handle missing docs)
    await db.collection('users').doc(state.currentUser.uid).set({
        organizationId: orgRef.id,
        orgRole: 'owner',
        email: state.currentUser.email,
        displayName: state.currentUser.displayName || state.currentUser.email?.split('@')[0] || 'User'
    }, { merge: true });

    return { id: orgRef.id, ...orgData };
}

// Join organization by invite code
async function joinOrganization(inviteCode) {
    if (!state.currentUser) throw new Error('Не авторизован');

    const code = inviteCode.toUpperCase().trim();

    // Find organization by invite code
    const snapshot = await db.collection('organizations').where('inviteCode', '==', code).get();

    if (snapshot.empty) {
        throw new Error('Организация не найдена');
    }

    const orgDoc = snapshot.docs[0];
    const orgData = orgDoc.data();

    // Check if already member - fetch fresh data from Firestore
    const userDoc = await db.collection('users').doc(state.currentUser.uid).get();
    const userData = userDoc.exists ? userDoc.data() : {};

    if (userData.organizationId === orgDoc.id) {
        throw new Error('Вы уже в этой организации');
    }

    // Check if user is in another organization (one org per user)
    if (userData.organizationId && userData.organizationId !== orgDoc.id) {
        throw new Error('Вы уже состоите в другой организации. Сначала покиньте её.');
    }

    // Build update data - preserve existing firstName/lastName if they exist
    const updateData = {
        organizationId: orgDoc.id,
        orgRole: 'employee',
        email: state.currentUser.email
    };

    // If user document exists but has no firstName, try to get from state or displayName
    if (!userData.firstName) {
        // Try to get name from current state (from recent login)
        if (state.currentUser.firstName) {
            updateData.firstName = state.currentUser.firstName;
            updateData.lastName = state.currentUser.lastName || '';
        } else {
            // Fallback: parse from displayName or email
            const displayName = state.currentUser.displayName || state.currentUser.email?.split('@')[0] || 'User';
            updateData.displayName = displayName;
        }
    }

    await db.collection('users').doc(state.currentUser.uid).set(updateData, { merge: true });

    // Update local state with the name
    if (userData.firstName) {
        state.currentUser.firstName = userData.firstName;
        state.currentUser.lastName = userData.lastName || '';
    }

    // Increment members count
    await db.collection('organizations').doc(orgDoc.id).update({
        membersCount: firebase.firestore.FieldValue.increment(1)
    });

    return { id: orgDoc.id, ...orgData };
}

// Leave organization (for non-owners)
async function leaveOrganization() {
    if (!state.currentUser || !state.organization) return;

    // Owner can't leave
    if (state.orgRole === 'owner') {
        throw new Error('Владелец не может покинуть организацию. Используйте "Удалить организацию".');
    }

    const orgId = state.organization.id;

    // Update user - use set with merge to handle any edge cases
    await db.collection('users').doc(state.currentUser.uid).set({
        organizationId: null,
        orgRole: null
    }, { merge: true });

    // Decrement members count
    await db.collection('organizations').doc(orgId).update({
        membersCount: firebase.firestore.FieldValue.increment(-1)
    });

    // Clear local state
    state.organization = null;
    state.orgRole = null;
    state.currentUser.organizationId = null;
    state.currentUser.orgRole = null;
}

// Delete organization (only for owner)
async function deleteOrganization() {
    if (!state.currentUser || !state.organization) return;

    if (state.orgRole !== 'owner') {
        throw new Error('Только владелец может удалить организацию');
    }

    const orgId = state.organization.id;

    // Remove all users from this organization
    const usersSnapshot = await db.collection('users').where('organizationId', '==', orgId).get();
    const batch = db.batch();

    usersSnapshot.forEach(doc => {
        batch.update(doc.ref, { organizationId: null, orgRole: null });
    });

    // Delete the organization document
    batch.delete(db.collection('organizations').doc(orgId));

    await batch.commit();

    // Clear local state
    state.organization = null;
    state.orgRole = null;
    state.currentUser.organizationId = null;
    state.currentUser.orgRole = null;
}

// Regenerate invite code (invalidates old code)
async function regenerateInviteCode() {
    if (!state.organization) throw new Error('Нет организации');
    if (!hasPermission('regenerate_invite')) {
        throw new Error('Недостаточно прав');
    }

    const newCode = await generateUniqueInviteCode();

    await db.collection('organizations').doc(state.organization.id).update({
        inviteCode: newCode
    });

    state.organization.inviteCode = newCode;
    return newCode;
}

// Get organization by ID
async function getOrganization(orgId) {
    const doc = await db.collection('organizations').doc(orgId).get();
    if (!doc.exists) return null;
    return { id: doc.id, ...doc.data() };
}

// Find organization by invite code (for preview)
async function findOrganizationByCode(code) {
    const snapshot = await db.collection('organizations').where('inviteCode', '==', code.toUpperCase().trim()).get();
    if (snapshot.empty) return null;
    const doc = snapshot.docs[0];
    const orgData = { id: doc.id, ...doc.data() };

    // Count actual members for accurate display
    try {
        const membersSnapshot = await db.collection('users').where('organizationId', '==', doc.id).get();
        orgData.membersCount = membersSnapshot.size;
    } catch (e) {
        console.error('Error counting members:', e);
    }

    return orgData;
}

// Show organization selection screen
function showOrgSelectionScreen(clearOrg = false) {
    // Remove read-only class to enable buttons
    document.body.classList.remove('read-only');

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
    }

    // Show welcome message
    if (state.currentUser) {
        const name = state.currentUser.firstName || state.currentUser.email;
        elements.orgWelcomeName.textContent = `Привет, ${name}!`;
    }

    // Apply pending invite code if exists (may auto-join and skip this screen)
    applyPendingInviteCode();

    // Hide loading screen after org screen is ready
    setTimeout(() => hideLoadingScreen(), 100);
}

// Check URL for invite code on page load (call early!)
function captureInviteCodeFromUrl() {
    const urlParams = new URLSearchParams(window.location.search);
    const inviteCode = urlParams.get('invite');

    if (inviteCode) {
        pendingInviteCode = inviteCode.toUpperCase();
        // Store in sessionStorage as backup
        sessionStorage.setItem('pendingInviteCode', pendingInviteCode);
        // Clean URL without reload
        window.history.replaceState({}, document.title, window.location.pathname);
    } else {
        // Check sessionStorage for pending code
        const stored = sessionStorage.getItem('pendingInviteCode');
        if (stored) {
            pendingInviteCode = stored;
        }
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

    // Check if user is already in an organization
    if (state.currentUser?.organizationId) {
        alert('Вы уже состоите в организации.\n\nЧтобы присоединиться к другой, сначала покиньте текущую.');
        return;
    }

    // Try to auto-join the organization
    try {
        const org = await findOrganizationByCode(code);
        if (org) {
            // Auto join!
            const joinedOrg = await joinOrganization(code);
            state.organization = joinedOrg;
            state.orgRole = 'employee';
            state.currentUser.organizationId = joinedOrg.id;
            state.currentUser.orgRole = 'employee';

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
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Создание...';
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
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fa-solid fa-plus"></i> Создать организацию';
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

            const originalHtml = submitBtn.innerHTML;
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Вход...';

            const joinError = document.getElementById('org-join-error');
            if (joinError) joinError.style.display = 'none';

            try {
                const org = await joinOrganization(code);
                state.organization = org;
                state.orgRole = 'employee';
                state.currentUser.organizationId = org.id;
                state.currentUser.orgRole = 'employee';

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
                submitBtn.disabled = false;
                submitBtn.innerHTML = originalHtml;
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
    if (elements.orgLeaveBtn) {
        elements.orgLeaveBtn.addEventListener('click', async () => {
            if (state.orgRole === 'owner') {
                alert('Владелец не может покинуть организацию. Используйте "Удалить организацию".');
                return;
            }

            if (!confirm('Вы уверены, что хотите покинуть организацию?\n\nВы потеряете доступ ко всем проектам и задачам.')) return;

            try {
                await leaveOrganization();
                elements.orgDropdown.style.display = 'none';
                elements.orgHeader.classList.remove('open');
                showOrgSelectionScreen(true);
            } catch (error) {
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
                btn.disabled = true;
                btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Удаление...';

                await deleteOrganization();

                elements.orgDropdown.style.display = 'none';
                elements.orgHeader.classList.remove('open');
                showOrgSelectionScreen(true);

                alert('Организация удалена.');
            } catch (error) {
                console.error('Error deleting organization:', error);
                alert('Ошибка: ' + error.message);
                elements.orgDeleteBtn.disabled = false;
                elements.orgDeleteBtn.innerHTML = '<i class="fa-solid fa-trash"></i> Удалить организацию';
            }
        });
    }

    // Regenerate invite code
    if (elements.orgRegenerateCode) {
        elements.orgRegenerateCode.addEventListener('click', async () => {
            if (!confirm('Сменить код приглашения?\n\nСтарый код перестанет работать.')) return;

            const btn = elements.orgRegenerateCode;
            btn.disabled = true;
            btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Смена...';

            try {
                const newCode = await regenerateInviteCode();
                if (elements.orgInviteCodeDisplay) {
                    elements.orgInviteCodeDisplay.textContent = newCode;
                }
                btn.innerHTML = '<i class="fa-solid fa-check"></i> Готово!';
                setTimeout(() => {
                    btn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Сменить код';
                    btn.disabled = false;
                }, 2000);
            } catch (error) {
                alert(error.message);
                btn.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i> Сменить код';
                btn.disabled = false;
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
        employee: 'Сотрудник'
    };
    if (elements.orgDropdownRole) {
        elements.orgDropdownRole.textContent = roleNames[state.orgRole] || 'Сотрудник';
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
        employee: 'Сотрудник'
    };
    return names[role] || 'Сотрудник';
}

// Permission system
// Owner: can do everything
// Admin: everything except delete org and change owner's role
// Moderator: create/edit/delete/assign tasks only
// Employee: view and complete own tasks only

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

function canChangeUserRole(targetRole) {
    // Owner can change anyone's role (except owner - that's themselves)
    if (state.orgRole === 'owner') {
        return targetRole !== 'owner';
    }
    // Admin can ONLY change employee ↔ moderator (NOT admin roles)
    if (state.orgRole === 'admin') {
        return ['employee', 'moderator'].includes(targetRole);
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
        return ['employee', 'moderator'].includes(targetRole);
    }
    return false;
}

// Enter app after organization is set
function enterApp() {
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


    // Start presence tracking (used for admin "who is online" / last seen)
    startPresenceHeartbeat();
}

// Apply role-based UI restrictions
function applyRoleRestrictions() {
    const role = state.orgRole || 'employee';

    // Remove all role classes first
    document.body.classList.remove('read-only', 'role-owner', 'role-admin', 'role-moderator', 'role-employee');

    // Add current role class
    document.body.classList.add(`role-${role}`);

    // read-only for employees (can only view and complete own tasks)
    if (role === 'employee') {
        document.body.classList.add('read-only');
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
}

// ========== END ORGANIZATION FUNCTIONS ==========

// Initialize Firebase when ready
let db;
let auth;
let firebaseInitAttempts = 0;
let isFirebaseInitialized = false;
let taskListenerUnsubscribe = null; // To manage real-time listener for tasks
let myTasksListenerUnsubscribe = null; // To manage real-time listener for my tasks count

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
                auth.onAuthStateChanged(onAuthStateChanged);
            })
            .catch((error) => {
                console.error("Persistence error:", error);
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
    boardView: 'assigned', // 'assigned' | 'in-progress' | 'done' (single-column board)
    role: 'guest', // Legacy role, now use orgRole
    orgRole: 'employee', // owner / admin / moderator / employee
    initialLoadDone: false, // To prevent selecting first project on every update
    currentUser: null, // { uid, email, firstName, lastName, role, allowedProjects, organizationId, orgRole }
    organization: null, // { id, name, inviteCode, ownerId, ... }
};

// DOM Elements
const elements = {
    projectList: document.getElementById('project-list'),
    boardContainer: document.getElementById('board-container'),
    emptyState: document.getElementById('empty-state'),
    projectTitle: document.getElementById('project-title'),
    projectDesc: document.getElementById('project-desc'),
    addTaskBtn: document.getElementById('add-task-btn'),
    deleteProjectBtn: document.getElementById('delete-project-btn'),

    // Columns
    listAssigned: document.getElementById('list-assigned'),
    listInProgress: document.getElementById('list-in-progress'),
    listReview: document.getElementById('list-review'),
    listDone: document.getElementById('list-done'),

    // Counts
    countAssigned: document.getElementById('count-assigned'),
    countInProgress: document.getElementById('count-in-progress'),
    countReview: document.getElementById('count-review'),
    countDone: document.getElementById('count-done'),

    // Board Tabs (single-column view)
    boardTabs: document.getElementById('board-tabs'),
    tabCountAssigned: document.getElementById('tab-count-assigned'),
    tabCountInProgress: document.getElementById('tab-count-in-progress'),
    tabCountReview: document.getElementById('tab-count-review'),
    tabCountDone: document.getElementById('tab-count-done'),

    // Board selector (mobile)
    categoryPicker: document.getElementById('category-picker'),
    categoryBtn: document.getElementById('category-btn'),
    categoryBtnText: document.getElementById('category-btn-text'),
    categoryModal: document.getElementById('category-modal'),

    // Modals
    projectModal: document.getElementById('project-modal'),
    taskModal: document.getElementById('task-modal'),
    helpModal: document.getElementById('help-modal'),



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
    adminVerifyScreen: document.getElementById('admin-verify-screen'),
    loginForm: document.getElementById('login-form'),
    registerForm: document.getElementById('register-form'),
    loginError: document.getElementById('login-error'),
    registerError: document.getElementById('register-error'),
    adminVerifyError: document.getElementById('admin-verify-error'),
    userEmailDisplay: document.getElementById('user-email-display'),

    // Mobile
    mobileMenuBtn: document.getElementById('mobile-menu-btn'),
    sidebar: document.querySelector('.sidebar'),

    // Admin Panel
    adminPanelBtn: document.getElementById('admin-panel-btn'),
    adminPanelModal: document.getElementById('admin-panel-modal'),
    usersList: document.getElementById('users-list'),
    usersCount: document.getElementById('users-count'),
    accessUserSelect: document.getElementById('access-user-select'),
    allowAllProjects: document.getElementById('allow-all-projects'),
    projectsCheckboxes: document.getElementById('projects-checkboxes'),
    saveAccessBtn: document.getElementById('save-access-btn'),
    userAccessInfo: document.getElementById('user-access-info'),

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
    orgLeaveBtn: document.getElementById('org-leave-btn'),
    orgDeleteBtn: document.getElementById('org-delete-btn'),
    orgRegenerateCode: document.getElementById('org-regenerate-code'),
    brandLogo: document.getElementById('brand-logo'),
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
                })
                .catch(err => {
                    console.log('ServiceWorker registration failed: ', err);
                });

            // Reload when controller changes (new SW activated)
            navigator.serviceWorker.addEventListener('controllerchange', () => {
                window.location.reload();
            });

            // Periodic update check (every hour)
            setInterval(() => {
                registration.update();
            }, 60 * 60 * 1000);
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
    const CURRENT_VERSION = '5.7'; // FIX DATE FORMATTING FOR FIREBASE TIMESTAMPS
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


function setupRealtimeListeners() {
    // Unsubscribe from previous listeners
    if (projectsListenerUnsubscribe) projectsListenerUnsubscribe();
    if (usersListenerUnsubscribe) usersListenerUnsubscribe();


    const orgId = state.organization?.id;

    // Listen for ALL Projects and filter client-side
    projectsListenerUnsubscribe = db.collection('projects').orderBy('createdAt').onSnapshot(snapshot => {
        const projects = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            // Include projects ONLY if:
            // 1. We have orgId AND project's organizationId matches exactly
            // 2. OR we don't have orgId (legacy mode - include all)
            if (orgId) {
                // Strict filter: only projects in THIS organization
                if (data.organizationId === orgId) {
                    projects.push({ id: doc.id, ...data });
                }
            } else {
                // Legacy mode: include all projects
                projects.push({ id: doc.id, ...data });
            }
        });
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
        }

        renderProjects();
        renderBoard();
    }, error => {
        console.error("Error listening to projects:", error);
    });

    // Listen for Users (filtered by organization)
    // We listen to ALL users and filter client-side to avoid index requirements
    usersListenerUnsubscribe = db.collection('users').onSnapshot(snapshot => {
        const users = [];
        const seenIds = new Set(); // Prevent duplicates

        snapshot.forEach(doc => {
            const data = doc.data();

            // Skip if we've already seen this ID (shouldn't happen, but safeguard)
            if (seenIds.has(doc.id)) {
                console.warn('Duplicate user detected:', doc.id);
                return;
            }
            seenIds.add(doc.id);

            // Include users ONLY if:
            // 1. We have orgId AND user's organizationId matches exactly
            // 2. OR we don't have orgId (legacy mode - include all)
            if (orgId) {
                // Strict filter: only users in THIS organization
                if (data.organizationId === orgId) {
                    users.push({ id: doc.id, ...data });
                }
            } else {
                // Legacy mode: include all users
                users.push({ id: doc.id, ...data });
            }
        });
        state.users = users;
        console.log('Users loaded:', users.length, 'for org:', orgId); // Debug
        // Re-render projects and admin panel if user's access changes
        renderProjects();
        renderUsersList(); // Update admin panel - users list
        updateAccessUserSelect(); // Update admin panel - access dropdown
        renderLoginHistoryTab(); // Update admin panel - logins/online
        renderAdminUsersStatsPanel(); // Update admin panel - users stats
    }, error => {
        console.error("Error listening to users:", error);
    });


}

function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

function selectProject(id) {
    state.activeProjectId = id;
    state.boardView = 'assigned'; // Always open "Assigned" first
    renderProjects(); // To update active class
    subscribeToProjectTasks(id); // Fetch tasks for this project only

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
    elements.listDone.innerHTML = '';

    // Subscribe to new project tasks
    taskListenerUnsubscribe = db.collection('tasks')
        .where('projectId', '==', projectId)
        .onSnapshot(snapshot => {
            const tasks = [];
            snapshot.forEach(doc => {
                tasks.push({ id: doc.id, ...doc.data() });
            });
            state.tasks = tasks;
            checkReminders(tasks);
            renderBoard();
        }, error => {
            console.error("Error fetching tasks:", error);
            const errHtml = '<p style="color: var(--text-secondary); text-align: center;">Ошибка загрузки задач</p>';
            if (elements.listAssigned) elements.listAssigned.innerHTML = errHtml;
            elements.listInProgress.innerHTML = errHtml;
            if (elements.listReview) elements.listReview.innerHTML = '';
            elements.listDone.innerHTML = '';
        });
}

function deleteTask(id) {
    // Check permission - owner, admin, or moderator can delete tasks
    if (!canManageTasks()) return;
    if (!confirm('Вы уверены, что хотите удалить эту задачу?')) return;
    db.collection('tasks').doc(id).delete();
}

function deleteProject(id) {
    // Check permission - only owner or admin can delete projects
    if (!canManageProjects()) return;

    if (!confirm('Вы уверены? Все задачи этого проекта будут удалены.')) return;

    // Delete project
    db.collection('projects').doc(id).delete();

    // Delete associated tasks
    const projectTasks = state.tasks.filter(t => t.projectId === id);
    projectTasks.forEach(t => {
        db.collection('tasks').doc(t.id).delete();
    });

    if (state.activeProjectId === id) {
        state.activeProjectId = null;
        renderBoard();
    }
}

function updateTask(id, data) {
    // Check permission - owner, admin, or moderator can update tasks
    if (!canManageTasks()) return;

    // Show loading state (button may be outside form)
    const submitBtn = document.querySelector('button[form="task-form"]') ||
        elements.taskForm.querySelector('button[type="submit"]');
    if (submitBtn) setButtonLoading(submitBtn, true, 'Сохранить');

    db.collection('tasks').doc(id).update(data)
        .then(() => {
            console.log("✅ Задача успешно обновлена!");
            elements.taskModal.classList.remove('active');
            elements.taskForm.reset();
            if (submitBtn) setButtonLoading(submitBtn, false, 'Сохранить');
        })
        .catch((error) => {
            console.error("Error updating task:", error);
            alert("❌ Ошибка при обновлении задачи:\n\n" + error.message);
            if (submitBtn) setButtonLoading(submitBtn, false, 'Сохранить');
        });
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

    // Set selected assignees from task
    if (task.assigneeEmail && task.assignee) {
        setSelectedAssignees(task.assigneeEmail, task.assignee);
    }

    // Load existing attachments
    pendingAttachments = task.attachments ? [...task.attachments] : [];
    renderAttachmentsList();
    updateAddAttachmentBtn();

    elements.taskModal.classList.add('active');
}

// Rendering
function renderProjects() {
    elements.projectList.innerHTML = '';
    const filteredProjects = getFilteredProjects();

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

            const formattedDate = deadlineDate.toLocaleDateString('ru-RU', {
                day: 'numeric',
                month: 'short'
            });

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
        li.onclick = () => {
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
        elements.emptyState.style.display = 'flex';
        elements.projectTitle.textContent = 'Выберите проект';
        elements.projectDesc.textContent = 'или создайте новый';
        elements.addTaskBtn.disabled = true;
        elements.deleteProjectBtn.style.display = 'none';
        return;
    }

    elements.boardContainer.classList.add('active');
    elements.emptyState.style.display = 'none';
    elements.projectTitle.textContent = activeProject.name;

    // Show deadline in description if exists
    let descText = activeProject.description || '';
    if (activeProject.deadline) {
        const deadlineDate = new Date(activeProject.deadline);
        const now = new Date();
        const daysLeft = Math.ceil((deadlineDate - now) / (1000 * 60 * 60 * 24));
        const formattedDate = deadlineDate.toLocaleDateString('ru-RU', {
            day: 'numeric',
            month: 'long',
            year: 'numeric'
        });

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

    elements.addTaskBtn.disabled = false;
    elements.deleteProjectBtn.style.display = 'flex';
    elements.deleteProjectBtn.onclick = () => {
        playClickSound();
        deleteProject(activeProject.id);
    };

    // Clear lists
    if (elements.listAssigned) elements.listAssigned.innerHTML = '';
    elements.listInProgress.innerHTML = '';
    if (elements.listReview) elements.listReview.innerHTML = '';
    elements.listDone.innerHTML = '';

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
    if (elements.countDone) elements.countDone.textContent = String(doneTasks.length);

    // Update tab counts (if present)
    if (elements.tabCountAssigned) elements.tabCountAssigned.textContent = String(assignedTasks.length);
    if (elements.tabCountInProgress) elements.tabCountInProgress.textContent = String(inProgressTasks.length);
    if (elements.tabCountReview) elements.tabCountReview.textContent = String(reviewTasks.length);
    if (elements.tabCountDone) elements.tabCountDone.textContent = String(doneTasks.length);

    projectTasks.forEach(task => {
        const card = createTaskCard(task);
        const sub = getTaskSubStatusForBoard(task);

        if (task.status === 'done') {
            elements.listDone.appendChild(card);
            return;
        }

        // status === in-progress
        if (sub === 'assigned') {
            if (elements.listAssigned) elements.listAssigned.appendChild(card);
            else elements.listInProgress.appendChild(card); // Fallback
        } else if (sub === 'completed') {
            if (elements.listReview) elements.listReview.appendChild(card);
            else elements.listInProgress.appendChild(card); // Fallback
        } else {
            // in_work
            elements.listInProgress.appendChild(card);
        }
    });

    // Keep the correct visible column (single-column view)
    setBoardView(state.boardView || 'assigned');
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

function openStatusMenu(event, task, currentSubStatus) {
    event.stopPropagation();
    playClickSound();
    createGlobalStatusMenu();

    globalStatusMenu.innerHTML = '';

    const canManage = canManageTasks();
    const isMobile = window.innerWidth <= 768;

    // Check if user is assignee
    let isAssignee = false;
    if (state.currentUser) {
        if (state.currentUser.email && task.assigneeEmail) {
            const emails = task.assigneeEmail.toLowerCase().split(',').map(e => e.trim());
            isAssignee = emails.includes(state.currentUser.email.toLowerCase());
        }
        if (!isAssignee && task.assignee) {
            const name = state.currentUser.fullName || `${state.currentUser.firstName || ''} ${state.currentUser.lastName || ''}`.trim();
            if (name && task.assignee.split(',').map(n => n.trim()).includes(name)) {
                isAssignee = true;
            }
        }
    }

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
            addOption('Подтвердить', 'Отправить в архив', 'fa-check-double', 'done', 'done');
            addOption('На доработку', 'Вернуть исполнителю', 'fa-rotate-left', 'revision', 'in_work', false, true);
        }
    }

    // Position menu
    if (isMobile) {
        // Mobile: bottom sheet
        globalStatusOverlay.classList.add('active');
        globalStatusMenu.removeAttribute('style');
    } else {
        // PC: position directly below badge - ALWAYS below
        const badge = event.target.closest('.status-badge');
        if (!badge) return;

        const rect = badge.getBoundingClientRect();

        // Menu dimensions
        const menuWidth = 240;
        const menuHeight = 200;
        const gap = 6;

        // Always position below badge
        let top = rect.bottom + gap;
        let left = rect.left;

        // Keep on screen horizontally
        if (left + menuWidth > window.innerWidth - 16) {
            left = window.innerWidth - menuWidth - 16;
        }
        if (left < 16) {
            left = 16;
        }

        // Calculate available space below
        const availableBelow = window.innerHeight - top - 16;
        let maxHeight = null;

        // If not enough space below, limit height and add scroll
        if (availableBelow < menuHeight) {
            maxHeight = Math.max(120, availableBelow);
        }

        // Build style string
        let styleStr = `
            position: fixed !important;
            top: ${top}px !important;
            left: ${left}px !important;
            right: auto !important;
            bottom: auto !important;
            width: ${menuWidth}px !important;
            transform: translateY(0) !important;
            -webkit-transform: translateY(0) !important;
        `;

        if (maxHeight) {
            styleStr += `
                max-height: ${maxHeight}px !important;
                overflow-y: auto !important;
                -webkit-overflow-scrolling: touch !important;
            `;
        }

        globalStatusMenu.setAttribute('style', styleStr);
    }

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
    const assignees = task.assignee.split(',').map(name => name.trim()).filter(name => name.length > 0);

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
            badgeText = 'Задача завершена';
            badgeIcon = '<i class="fa-solid fa-check"></i>';
            badgeClass = 'status-completed';
            break;
        case 'done':
            badgeText = 'Готово (Архив)';
            badgeIcon = '<i class="fa-solid fa-check-double"></i>';
            badgeClass = 'status-completed'; // Keep green
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

    // Check assignee logic for interactivity check
    let isAssignee = false;
    if (state.currentUser) {
        if (state.currentUser.email && task.assigneeEmail) {
            const assigneeEmails = task.assigneeEmail.toLowerCase().split(',');
            isAssignee = assigneeEmails.map(e => e.trim()).includes(state.currentUser.email.toLowerCase());
        }
        if (!isAssignee && !task.assigneeEmail && task.assignee) {
            const currentUserFullName = state.currentUser.fullName || `${state.currentUser.firstName || ''} ${state.currentUser.lastName || ''}`.trim();
            const assigneeNames = task.assignee.split(',').map(n => n.trim());
            if (currentUserFullName && assigneeNames.includes(currentUserFullName)) {
                isAssignee = true;
            }
        }
    }

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
            avatar.innerHTML = `<img src="${assigneeUser.profilePhotoUrl}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;">`;
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
    } else if (currentSubStatus !== 'done') {
        if (diffDays < 0) addTag('Просрочено', 'tag-overdue');
        else if (diffDays === 0) addTag('Сегодня', 'tag-today');
        else addTag(`${diffDays} дн.`, 'tag-days');
    }

    if (tagsWrap.childNodes.length > 0) {
        deadlineDiv.appendChild(tagsWrap);
    }

    const timeLeft = deadlineDate - now;
    if (task.status !== 'done') {
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
    deadlineText.textContent = formatDate(task.deadline);

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

    // Right side: Edit & Delete buttons (admin only)
    const toolbarRight = document.createElement('div');
    toolbarRight.className = 'toolbar-right';


    if (state.role === 'admin') {
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
        updates.completedAt = new Date().toISOString();

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
                    const creatorEmail = taskData.createdByEmail;
                    if (creatorEmail) {
                        const project = state.projects.find(p => p.id === taskData.projectId);
                        const projectName = project?.name || 'Проект';
                        await sendTelegramCompletionNotification(creatorEmail, taskData.title, projectName, completedByName);
                        console.log('Completion notification sent to:', creatorEmail);
                    } else {
                        console.log('No createdByEmail for task, notification not sent');
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

        // Award XP when task is moved to done (archive)
        if (newSubStatus === 'done') {
            try {
                const taskDoc = await db.collection('tasks').doc(taskId).get();
                if (taskDoc.exists) {
                    const task = taskDoc.data();

                    // Check if completed on time (use completedAt, not current time)
                    let deadlineDate = null;
                    if (task.deadline) {
                        deadlineDate = new Date(task.deadline);
                        // Set deadline to end of day (23:59:59) for fair comparison
                        deadlineDate.setHours(23, 59, 59, 999);
                    }

                    let completedDate = new Date(); // fallback to now

                    // Get the actual completion date
                    if (task.completedAt) {
                        if (task.completedAt.toDate) {
                            completedDate = task.completedAt.toDate();
                        } else {
                            completedDate = new Date(task.completedAt);
                        }
                    }

                    const wasOnTime = deadlineDate ? completedDate <= deadlineDate : true;

                    // Check if was returned for revision
                    const wasReturned = task.wasReturned || task.revisionReason ? true : false;

                    // Update completedOnTime field
                    await db.collection('tasks').doc(taskId).update({
                        completedOnTime: wasOnTime
                    });

                    // Find assignee user and award XP
                    if (task.assigneeEmail) {
                        const assigneeEmails = task.assigneeEmail.toLowerCase().split(',');
                        for (const email of assigneeEmails) {
                            const user = state.users.find(u =>
                                u.email?.toLowerCase() === email.trim()
                            );
                            if (user) {
                                await awardXP(user.id, taskId, wasOnTime, wasReturned);
                            }
                        }
                    }
                }
            } catch (error) {
                console.error('Error awarding XP:', error);
            }
        }
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
                <div class="attachment-name">${attachment.name}</div>
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

    // Find task to get assignee info for notifications
    const task = state.tasks.find(t => t.id === taskId);
    if (task && task.assigneeEmail) {
        // Send notifications to all assignees
        const emails = task.assigneeEmail.split(',');
        const names = task.assignee ? task.assignee.split(', ') : [];

        emails.forEach((email, index) => {
            if (email && email.trim()) {
                // Send Telegram notification
                sendTelegramRevisionNotification(email.trim(), task.title, reason, returnedBy);
            }
        });
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
    const deadline = task.deadline ? new Date(task.deadline).toLocaleDateString('ru-RU', {
        day: 'numeric',
        month: 'long',
        year: 'numeric'
    }) : 'Не указан';

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
                <div class="timeline-icon completed"><i class="fa-solid fa-check"></i></div>
                <div class="timeline-content">
                    <div class="timeline-label">Завершена${task.completedBy ? ' <span class="timeline-user">| ' + escapeHtml(task.completedBy) + '</span>' : ''}</div>
                    <div class="timeline-date">${completedAt}</div>
                </div>
            </div>
        `;
    } else if (task.subStatus === 'in_work') {
        timelineHTML += `
            <div class="timeline-item pending">
                <div class="timeline-icon completed"><i class="fa-solid fa-check"></i></div>
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
                <div class="timeline-icon archived"><i class="fa-solid fa-check-double"></i></div>
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
                    <div class="completion-proof-file" data-proof='${JSON.stringify(proof).replace(/'/g, "\\'")}'>
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
                        <i class="fa-solid fa-comment-dots"></i> Комментарий руководителя
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

    // Assignees
    const assignees = task.assignee ? task.assignee.split(',').map(n => n.trim()).filter(n => n) : [];
    const assigneesHTML = assignees.length > 0
        ? assignees.map(name => `<span style="background: rgba(99, 102, 241, 0.1); padding: 0.25rem 0.75rem; border-radius: 20px; font-size: 0.85rem;">${escapeHtml(name)}</span>`).join(' ')
        : '<span style="color: var(--text-secondary);">Не назначены</span>';

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
            </div>
        </div>
        
        <div class="task-details-section">
            <h3><i class="fa-solid fa-clock-rotate-left"></i> История задачи</h3>
            <div class="task-timeline">
                ${timelineHTML}
            </div>
        </div>
        
        ${revisionHTML}
        
        ${proofHTML}
    `;

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

    modal.classList.add('active');
}

// Helper function to escape HTML
function escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function formatDate(dateString) {
    const options = { month: 'short', day: 'numeric' };
    return new Date(dateString).toLocaleDateString('ru-RU', options);
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

function startPresenceHeartbeat() {
    if (presenceIntervalId) return;
    // Do an immediate update, then keep alive
    updateMyPresence();
    presenceIntervalId = setInterval(updateMyPresence, PRESENCE_HEARTBEAT_MS);

    // Also update when tab becomes visible again
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            updateMyPresence();
        }
    });
    window.addEventListener('focus', updateMyPresence);
}

function stopPresenceHeartbeat() {
    if (presenceIntervalId) {
        clearInterval(presenceIntervalId);
        presenceIntervalId = null;
    }
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
    const allowed = new Set(['assigned', 'in-progress', 'review', 'done']);
    const next = allowed.has(view) ? view : 'assigned';
    state.boardView = next;

    // Update category button label (mobile)
    if (elements.categoryBtnText) {
        const labelMap = {
            'assigned': 'Назначенные',
            'in-progress': 'В процессе',
            'review': 'На проверке',
            'done': 'Готово'
        };
        elements.categoryBtnText.textContent = labelMap[next] || 'Назначенные';
    }

    // Tabs active state
    document.querySelectorAll('.board-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.view === next);
    });

    // Columns visibility
    document.querySelectorAll('.board-container .column').forEach(col => {
        col.classList.toggle('active', col.dataset.view === next);
    });

    // Keyboard navigation column sync (if enabled)
    if (keyboardNav?.mode === 'tasks') {
        keyboardNav.taskColumn = next;
        keyboardNav.focusIndex = -1;
        clearKeyboardFocus();
    }
}

// Board selector now opens modal on mobile

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

// Event Listeners
function setupEventListeners() {
    // Organization event listeners
    setupOrgEventListeners();

    // Modals
    elements.addProjectBtn.addEventListener('click', () => {
        playClickSound();
        closeSidebarOnMobile();
        elements.projectForm.reset();
        elements.projectModal.classList.add('active');
    });

    elements.addTaskBtn.addEventListener('click', () => {
        playClickSound();
        elements.taskForm.reset();
        document.getElementById('t-id').value = ''; // Clear ID for new task
        elements.taskModal.querySelector('h2').textContent = 'Новая задача'; // Reset title
        // Set default date to today
        document.getElementById('t-deadline').valueAsDate = new Date();
        populateAssigneeDropdown();

        // Reset attachments
        pendingAttachments = [];
        renderAttachmentsList();
        updateAddAttachmentBtn();

        elements.taskModal.classList.add('active');
    });

    // File attachment handlers
    const fileInput = document.getElementById('file-input');
    const addAttachmentBtn = document.getElementById('add-attachment-btn');

    if (fileInput) {
        fileInput.addEventListener('change', handleFileSelect);
    }

    if (addAttachmentBtn) {
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

    if (addCompletionFileBtn) {
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
    elements.helpBtn.addEventListener('click', () => {
        playClickSound();
        elements.helpModal.classList.add('active');
    });

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
                modal.classList.remove('active');
            }
        });
    });

    // Close on click outside
    window.addEventListener('click', (e) => {
        if (e.target.classList.contains('modal')) {
            e.target.classList.remove('active');
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
                if (!projectDeadlineInput.value) {
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
    elements.projectForm.addEventListener('submit', (e) => {
        e.preventDefault();
        playClickSound();
        const name = document.getElementById('p-name').value;
        const desc = document.getElementById('p-desc').value;
        const hasDeadline = document.getElementById('p-has-deadline').checked;
        const deadline = hasDeadline ? document.getElementById('p-deadline').value : null;

        createProject(name, desc, deadline);

        // Reset form
        elements.projectModal.classList.remove('active');
        document.getElementById('p-has-deadline').checked = false;
        document.getElementById('p-deadline-group').classList.remove('active');
    });

    // Logic
    function createProject(name, description, deadline = null) {
        // Check permission: only owner or admin can create projects
        if (!canManageProjects()) return;

        const projectData = {
            name,
            description,
            organizationId: state.organization?.id || null,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        };

        if (deadline) {
            projectData.deadline = deadline;
        }

        db.collection('projects').add(projectData).then((docRef) => {
            selectProject(docRef.id);
            closeSidebarOnMobile();
        });
    }

    async function createTask(title, assignee, deadline, status, assigneeEmail, description) {
        // Check permission: owner, admin, or moderator can create tasks
        if (!canManageTasks()) return;
        if (!state.activeProjectId) return;

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

            await db.collection('tasks').add({
                projectId: state.activeProjectId,
                organizationId: state.organization?.id || null,
                title,
                description: description || '',
                assignee: assignee || 'Не назначен',
                assigneeEmail: assigneeEmail || '',
                deadline,
                status,
                subStatus: 'assigned', // Default status for new system
                assigneeCompleted: false,
                attachments: attachments, // Add attachments array
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                createdBy: createdBy,
                createdByEmail: state.currentUser?.email || ''
            });

            if (assigneeEmail) {
                // Send notifications to all assignees
                const emails = assigneeEmail.split(',');
                const names = assignee.split(', ');
                const projectName = document.getElementById('project-title')?.textContent || 'Проект';

                emails.forEach((email, index) => {
                    if (email && email.trim()) {
                        // Send Telegram notification
                        sendTelegramTaskNotification(email.trim(), title, projectName, deadline);
                    }
                });
            }

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
    elements.taskForm.addEventListener('submit', (e) => {
        e.preventDefault();
        playClickSound();

        // Find submit button (may be outside form with form="task-form" attribute)
        const submitBtn = document.querySelector('button[form="task-form"]') ||
            elements.taskForm.querySelector('button[type="submit"]');

        const title = document.getElementById('t-title').value;
        const description = document.getElementById('t-description').value;
        const taskId = document.getElementById('t-id').value;

        // Get selected assignees from new picker
        const { names: assignee, emails: assigneeEmail } = getSelectedAssignees();

        const deadline = document.getElementById('t-deadline').value;
        const status = document.getElementById('t-status').value;

        if (taskId) {
            // Prepare attachments (filter out any still uploading)
            const attachments = pendingAttachments.filter(a => !a.uploading && a.url);

            // Update existing task
            updateTask(taskId, {
                title,
                description,
                assignee,
                assigneeEmail,
                deadline,
                attachments // Include attachments when updating
            });
        } else {
            // Create new task
            createTask(title, assignee, deadline, status, assigneeEmail, description);
        }
    });

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

    // Auth - Login/Register toggle
    document.getElementById('show-register').addEventListener('click', (e) => {
        playClickSound();
        e.preventDefault();
        elements.loginForm.style.display = 'none';
        elements.registerForm.style.display = 'flex';
        document.getElementById('auth-title').textContent = 'Регистрация';
        document.getElementById('auth-subtitle').textContent = 'Создайте новый аккаунт';
    });

    document.getElementById('show-login').addEventListener('click', (e) => {
        playClickSound();
        e.preventDefault();
        elements.registerForm.style.display = 'none';
        elements.loginForm.style.display = 'flex';
        document.getElementById('auth-title').textContent = 'Вход в систему';
        document.getElementById('auth-subtitle').textContent = 'Войдите в свой аккаунт для продолжения';
    });

    // Login form
    elements.loginForm.addEventListener('submit', async (e) => {
        playClickSound();
        e.preventDefault();
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;
        const submitBtn = elements.loginForm.querySelector('button[type="submit"]');

        // Show loading state
        setButtonLoading(submitBtn, true, 'Войти');

        try {
            await auth.signInWithEmailAndPassword(email, password);
            elements.loginError.style.display = 'none';
        } catch (error) {
            elements.loginError.textContent = getAuthErrorMessage(error.code);
            elements.loginError.style.display = 'block';
            setButtonLoading(submitBtn, false, 'Войти');
        }
    });

    // Register form
    elements.registerForm.addEventListener('submit', async (e) => {
        playClickSound();
        e.preventDefault();
        const firstName = document.getElementById('register-first-name').value.trim();
        const lastName = document.getElementById('register-last-name').value.trim();
        const email = document.getElementById('register-email').value;
        const password = document.getElementById('register-password').value;
        const confirmPassword = document.getElementById('register-password-confirm').value;
        const submitBtn = elements.registerForm.querySelector('button[type="submit"]');

        if (password !== confirmPassword) {
            elements.registerError.textContent = 'Пароли не совпадают';
            elements.registerError.style.display = 'block';
            return;
        }

        if (password.length < 6) {
            elements.registerError.textContent = 'Пароль должен содержать минимум 6 символов';
            elements.registerError.style.display = 'block';
            return;
        }

        // Show loading state
        setButtonLoading(submitBtn, true, 'Зарегистрироваться');

        try {
            const userCredential = await auth.createUserWithEmailAndPassword(email, password);

            // Save user profile to Firestore
            await db.collection('users').doc(userCredential.user.uid).set({
                email: email,
                firstName: firstName,
                lastName: lastName,
                role: 'reader', // Force role to reader
                allowedProjects: [], // Empty means access to all projects
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            elements.registerError.style.display = 'none';
            // User will be automatically signed in, onAuthStateChanged will handle the rest
        } catch (error) {
            elements.registerError.textContent = getAuthErrorMessage(error.code);
            elements.registerError.style.display = 'block';
            setButtonLoading(submitBtn, false, 'Зарегистрироваться');
        }
    });

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
    elements.mobileMenuBtn.addEventListener('click', () => {
        playClickSound();
        elements.sidebar.classList.add('active');
        elements.sidebarOverlay.classList.add('active');
    });

    // Close sidebar when clicking overlay
    elements.sidebarOverlay.addEventListener('click', () => {
        playClickSound();
        elements.sidebar.classList.remove('active');
        elements.sidebarOverlay.classList.remove('active');
    });

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
            if (tabName === 'logins') {
                renderLoginHistoryTab();
            }
            if (tabName === 'stats') {
                renderAdminUsersStatsPanel();
            }
        });
    });

    // Board tabs (single-column view for projects)
    if (elements.boardTabs) {
        elements.boardTabs.addEventListener('click', (e) => {
            const btn = e.target.closest('.board-tab');
            if (!btn) return;
            const view = btn.dataset.view;
            if (!view) return;
            playClickSound();
            setBoardView(view);
        });
    }

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

    // Access user select
    if (elements.accessUserSelect) {
        elements.accessUserSelect.addEventListener('change', (e) => {
            const userId = e.target.value;
            if (userId) {
                elements.userAccessInfo.style.display = 'block';

                const user = state.users.find(u => u.id === userId);
                if (user) {
                    const initials = ((user.firstName || '')[0] || '') + ((user.lastName || '')[0] || '');
                    const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Без имени';

                    const avatarEl = document.getElementById('selected-user-avatar');
                    if (user.profilePhotoUrl) {
                        avatarEl.innerHTML = `<img src="${user.profilePhotoUrl}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;">`;
                        avatarEl.style.overflow = 'hidden';
                    } else {
                        avatarEl.textContent = initials.toUpperCase() || 'U';
                        avatarEl.style.overflow = '';
                    }
                    document.getElementById('selected-user-name').textContent = fullName;
                    document.getElementById('selected-user-email').textContent = user.email;

                    const hasAllAccess = !user.allowedProjects || user.allowedProjects.length === 0;
                    elements.allowAllProjects.checked = hasAllAccess;

                    // Always hide project list by default, show only when admin unchecks
                    elements.projectsCheckboxes.parentElement.style.display = hasAllAccess ? 'none' : 'block';

                    renderProjectCheckboxes(userId);
                }
            } else {
                elements.userAccessInfo.style.display = 'none';
            }
        });
    }

    // Allow all projects checkbox
    if (elements.allowAllProjects) {
        elements.allowAllProjects.addEventListener('change', (e) => {
            if (e.target.checked) {
                elements.projectsCheckboxes.parentElement.style.display = 'none';
            } else {
                elements.projectsCheckboxes.parentElement.style.display = 'block';
                // Uncheck all project checkboxes when toggling off "all projects"
                const checkboxes = elements.projectsCheckboxes.querySelectorAll('input[type="checkbox"]');
                checkboxes.forEach(cb => cb.checked = false);
            }
        });
    }

    // Save access button
    if (elements.saveAccessBtn) {
        elements.saveAccessBtn.addEventListener('click', () => {
            playClickSound();
            saveUserAccess();
        });
    }
}


// Authentication Functions
function onAuthStateChanged(user) {
    if (user) {
        // User is signed in
        loadUserRole(user);
    } else {
        // User is signed out
        state.currentUser = null;
        state.role = 'guest';
        showAuthScreen();
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

            // Set state orgRole
            state.orgRole = state.currentUser.orgRole;

            // Load organization if user has one
            if (userData.organizationId) {
                try {
                    const org = await getOrganization(userData.organizationId);
                    if (org) {
                        state.organization = org;
                    } else {
                        // Organization was deleted, clear user's org
                        state.currentUser.organizationId = null;
                        await db.collection('users').doc(user.uid).set({
                            organizationId: null,
                            orgRole: null
                        }, { merge: true });
                    }
                } catch (orgError) {
                    console.error("Error loading organization:", orgError);
                }
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

    // Check if user needs to select/create organization
    if (!state.currentUser.organizationId || !state.organization) {
        // Show organization selection screen
        showOrgSelectionScreen();
        return;
    }

    // User has organization, proceed to app
    finishAuth(state.currentUser.role);

    // Update Telegram status and start listener after user data loaded
    window.updateTelegramStatus && window.updateTelegramStatus();
    window.startTelegramListener && window.startTelegramListener();
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
}

function showAuthScreen() {
    // Only hide loading screen when showing auth (user needs to login)
    hideLoadingScreen();

    elements.authOverlay.style.display = 'flex';
    elements.authScreen.style.display = 'block';
    if (elements.roleScreen) elements.roleScreen.style.display = 'none';
    if (elements.adminVerifyScreen) elements.adminVerifyScreen.style.display = 'none';
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

async function logout() {
    try {
        // Unsubscribe from my tasks listener
        unsubscribeFromMyTasks();
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

function getAuthErrorMessage(errorCode) {
    switch (errorCode) {
        case 'auth/email-already-in-use':
            return 'Этот email уже используется';
        case 'auth/invalid-email':
            return 'Неверный формат email';
        case 'auth/weak-password':
            return 'Слишком слабый пароль';
        case 'auth/user-not-found':
            return 'Пользователь не найден';
        case 'auth/wrong-password':
            return 'Неверный пароль';
        case 'auth/too-many-requests':
            return 'Слишком много попыток. Попробуйте позже';
        default:
            return 'Ошибка аутентификации. Попробуйте снова';
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
        updateAccessUserSelect();
        renderLoginHistoryTab();
        renderAdminUsersStatsPanel();
        renderAdminUsersStatsPanel();
    }
}

function renderUsersList() {
    if (!elements.usersList) return;

    elements.usersList.innerHTML = '';
    elements.usersCount.textContent = `${state.users.length} ${state.users.length === 1 ? 'пользователь' : 'пользователей'}`;

    // Sort: owner first, then by name
    const sortedUsers = [...state.users].sort((a, b) => {
        const roleOrder = { owner: 0, admin: 1, moderator: 2, employee: 3 };
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
            employee: '<i class="fa-solid fa-user"></i>'
        };
        const roleNames = {
            owner: 'Владелец',
            admin: 'Админ',
            moderator: 'Модератор',
            employee: 'Сотрудник'
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
                    <option value="employee" ${userRole === 'employee' ? 'selected' : ''}>Сотрудник</option>
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
            ? `<div class="avatar" style="width: 40px; height: 40px; font-size: 1rem; overflow: hidden;"><img src="${user.profilePhotoUrl}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;"></div>`
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
                    await db.collection('users').doc(userId).set({ orgRole: newRole }, { merge: true });
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
            ? `<div class="avatar" style="width: 40px; height: 40px; font-size: 1rem; overflow: hidden;"><img src="${user.profilePhotoUrl}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;"></div>`
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
            ? `<div class="avatar" style="width: 40px; height: 40px; font-size: 1rem; overflow: hidden;"><img src="${user.profilePhotoUrl}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;"></div>`
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
                    <i class="fa-solid fa-check-double"></i> ${completed}
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
        // Remove user from organization
        await db.collection('users').doc(userId).set({
            organizationId: null,
            orgRole: null
        }, { merge: true });

        // Decrement members count
        if (state.organization?.id) {
            await db.collection('organizations').doc(state.organization.id).update({
                membersCount: firebase.firestore.FieldValue.increment(-1)
            });
        }

        playClickSound();
    } catch (error) {
        console.error('Error removing user:', error);
        alert('Ошибка при удалении пользователя');
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

    // Enable scrolling inside dropdown on mobile
    dropdown.addEventListener('touchmove', (e) => {
        e.stopPropagation();
    }, { passive: true });

    const query = searchInput.value.toLowerCase().trim();

    // Filter users
    const filteredUsers = state.users.filter(user => {
        let fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
        if (!fullName && user.displayName) fullName = user.displayName;
        if (!fullName && user.email) fullName = user.email.split('@')[0];
        fullName = fullName.toLowerCase();
        const email = (user.email || '').toLowerCase();

        // Check if already selected
        const isSelected = selectedAssignees.some(a => a.email === user.email);
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
                ? `<div class="assignee-dropdown-avatar" style="overflow: hidden;"><img src="${user.profilePhotoUrl}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;"></div>`
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

    // Check if already added
    if (selectedAssignees.some(a => a.email === user.email)) return;

    selectedAssignees.push({
        email: user.email,
        name: fullName
    });

    renderSelectedAssignees();
}

function removeAssignee(email) {
    selectedAssignees = selectedAssignees.filter(a => a.email !== email);
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

    selectedAssignees.forEach(assignee => {
        const initials = assignee.name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2);

        // Find user to get profile photo
        const user = state.users.find(u => u.email === assignee.email);
        const avatarHtml = user?.profilePhotoUrl
            ? `<div class="assignee-chip-avatar" style="overflow: hidden;"><img src="${user.profilePhotoUrl}" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;"></div>`
            : `<div class="assignee-chip-avatar">${initials}</div>`;

        const chip = document.createElement('div');
        chip.className = 'assignee-chip';
        chip.innerHTML = `
            ${avatarHtml}
            <span>${escapeHtml(assignee.name)}</span>
            <button type="button" class="assignee-chip-remove" data-email="${escapeHtml(assignee.email)}">
                <i class="fa-solid fa-xmark"></i>
            </button>
        `;

        chip.querySelector('.assignee-chip-remove').addEventListener('click', (e) => {
            e.stopPropagation();
            removeAssignee(assignee.email);
        });

        container.appendChild(chip);
    });
}

function setSelectedAssignees(emails, names) {
    // Set assignees when editing a task
    selectedAssignees = [];

    if (!emails || !names) return;

    const emailList = emails.split(',').map(e => e.trim()).filter(e => e);
    const nameList = names.split(',').map(n => n.trim()).filter(n => n);

    emailList.forEach((email, index) => {
        selectedAssignees.push({
            email: email,
            name: nameList[index] || email
        });
    });

    renderSelectedAssignees();
}

function getSelectedAssignees() {
    return {
        names: selectedAssignees.map(a => a.name).join(', ') || 'Не назначен',
        emails: selectedAssignees.map(a => a.email).join(',')
    };
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

async function awardXP(userId, taskId, wasOnTime, wasReturned) {
    if (!userId) return;

    let xpToAward = XP_CONFIG.baseTaskXP;

    if (wasOnTime) {
        xpToAward += XP_CONFIG.onTimeBonus;
    }

    if (wasReturned) {
        xpToAward -= XP_CONFIG.revisionPenalty;
    }

    // Minimum 1 XP
    xpToAward = Math.max(1, xpToAward);

    try {
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();

        if (userDoc.exists) {
            const userData = userDoc.data();
            const currentXP = userData.totalXP || 0;
            const newXP = currentXP + xpToAward;
            const newLevel = getLevelFromXP(newXP);

            // Increment task counters (persists even if task is deleted)
            const completedTasks = (userData.completedTasksCount || 0) + 1;
            const onTimeTasks = wasOnTime ? (userData.onTimeTasksCount || 0) + 1 : (userData.onTimeTasksCount || 0);
            const noRevisionTasks = !wasReturned ? (userData.noRevisionTasksCount || 0) + 1 : (userData.noRevisionTasksCount || 0);

            await userRef.update({
                totalXP: newXP,
                level: newLevel.level,
                completedTasksCount: completedTasks,
                onTimeTasksCount: onTimeTasks,
                noRevisionTasksCount: noRevisionTasks
            });
        }
    } catch (error) {
        console.error('Error awarding XP:', error);
    }
}

// ========== TELEGRAM NOTIFICATIONS ==========
const TELEGRAM_BOT_TOKEN = '8318306872:AAFQh2-XtMSMTe6StxJNMdy29l0UzbxD600';
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// Generate random code for Telegram verification
function generateTelegramCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

// Send Telegram notification directly
async function sendTelegramNotification(chatId, message) {
    if (!chatId) return;

    try {
        const response = await fetch(`${TELEGRAM_API}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'HTML'
            })
        });

        const result = await response.json();
        if (result.ok) {
            console.log('Telegram notification sent successfully');
        } else {
            console.error('Telegram notification failed:', result.description);
        }
    } catch (error) {
        console.error('Telegram notification error:', error);
    }
}

// Send task notification via Telegram
async function sendTelegramTaskNotification(userEmail, taskTitle, projectName, deadline) {
    // Find user by email
    const user = state.users.find(u => u.email?.toLowerCase() === userEmail?.toLowerCase());
    if (!user || !user.telegramChatId) return;

    const message = `📋 <b>Новая задача!</b>

<b>Задача:</b> ${escapeHtmlForTelegram(taskTitle)}
<b>Проект:</b> ${escapeHtmlForTelegram(projectName)}
<b>Срок:</b> ${deadline || 'Не указан'}

Откройте ProjectMan для подробностей.`;

    await sendTelegramNotification(user.telegramChatId, message);
}

// Send revision notification via Telegram
async function sendTelegramRevisionNotification(userEmail, taskTitle, revisionReason, returnedBy) {
    // Find user by email
    const user = state.users.find(u => u.email?.toLowerCase() === userEmail?.toLowerCase());
    if (!user || !user.telegramChatId) return;

    const message = `🔄 <b>Задача возвращена на доработку</b>

<b>Задача:</b> ${escapeHtmlForTelegram(taskTitle)}

<b>Причина:</b>
${escapeHtmlForTelegram(revisionReason)}

<b>Вернул:</b> ${escapeHtmlForTelegram(returnedBy)}

Пожалуйста, внесите изменения и отправьте на проверку.`;

    await sendTelegramNotification(user.telegramChatId, message);
}

// Send deadline reminder via Telegram
async function sendTelegramReminderNotification(userEmail, taskTitle, projectName, deadline) {
    // Find user by email
    const user = state.users.find(u => u.email?.toLowerCase() === userEmail?.toLowerCase());
    if (!user || !user.telegramChatId) return;

    const message = `⏰ <b>Напоминание о дедлайне!</b>

<b>Задача:</b> ${escapeHtmlForTelegram(taskTitle)}
<b>Проект:</b> ${escapeHtmlForTelegram(projectName)}
<b>Срок:</b> ${deadline}

Осталось менее 20% времени. Поторопитесь!`;

    await sendTelegramNotification(user.telegramChatId, message);
}

// Send "take task into work" reminder via Telegram
async function sendTelegramTakeTaskReminder(userEmail, taskTitle, projectName) {
    // Find user by email
    const user = state.users.find(u => u.email?.toLowerCase() === userEmail?.toLowerCase());
    if (!user || !user.telegramChatId) return;

    const message = `📋 <b>Напоминание!</b>

<b>Задача:</b> ${escapeHtmlForTelegram(taskTitle)}
<b>Проект:</b> ${escapeHtmlForTelegram(projectName)}

Пожалуйста, возьмите задачу в работу как можно скорее!`;

    await sendTelegramNotification(user.telegramChatId, message);
}

// Send overdue notification via Telegram
async function sendTelegramOverdueNotification(userEmail, taskTitle, projectName, deadline) {
    // Find user by email
    const user = state.users.find(u => u.email?.toLowerCase() === userEmail?.toLowerCase());
    if (!user || !user.telegramChatId) return;

    const message = `⚠️ <b>Просрочка!</b>

<b>Задача:</b> ${escapeHtmlForTelegram(taskTitle)}
<b>Проект:</b> ${escapeHtmlForTelegram(projectName)}
<b>Срок был:</b> ${deadline}

Срок выполнения задачи истёк! Пожалуйста, завершите её как можно скорее.`;

    await sendTelegramNotification(user.telegramChatId, message);
}

// Send task completion notification to creator/admin via Telegram
async function sendTelegramCompletionNotification(creatorEmail, taskTitle, projectName, completedByName) {
    // Find creator by email
    const creator = state.users.find(u => u.email?.toLowerCase() === creatorEmail?.toLowerCase());
    if (!creator || !creator.telegramChatId) return;

    const message = `✅ <b>Задача выполнена!</b>

<b>Проект:</b> ${escapeHtmlForTelegram(projectName)}
<b>Задача:</b> ${escapeHtmlForTelegram(taskTitle)}
<b>Исполнитель:</b> ${escapeHtmlForTelegram(completedByName)}

Пожалуйста, проверьте выполнение задачи.`;

    await sendTelegramNotification(creator.telegramChatId, message);
}

// Escape HTML for Telegram
function escapeHtmlForTelegram(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

// Save Telegram code to Firestore for bot verification
async function saveTelegramCode(code) {
    if (!state.currentUser?.uid) return;

    try {
        await db.collection('telegramCodes').doc(code).set({
            userId: state.currentUser.uid,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        });
    } catch (error) {
        console.error('Error saving Telegram code:', error);
    }
}

// Initialize Telegram connection UI (called on DOMContentLoaded)
function initTelegramConnection() {
    const connectBtn = document.getElementById('telegram-connect-btn');
    const modal = document.getElementById('telegram-modal');
    const codeEl = document.getElementById('telegram-code');
    const copyBtn = document.getElementById('copy-telegram-code');
    const disconnectBtn = document.getElementById('disconnect-telegram-btn');
    const connectScreen = document.getElementById('telegram-connect-screen');
    const connectedScreen = document.getElementById('telegram-connected-screen');
    const userInfoEl = document.getElementById('telegram-user-info');

    let currentCode = '';

    // Open modal
    if (connectBtn) {
        connectBtn.addEventListener('click', () => {
            playClickSound();

            // Open modal immediately
            modal.classList.add('active');

            // Check if already connected
            if (state.currentUser?.telegramChatId) {
                connectScreen.style.display = 'none';
                connectedScreen.style.display = 'block';
                userInfoEl.textContent = state.currentUser.telegramUsername ?
                    `@${state.currentUser.telegramUsername}` : 'Telegram подключен';
            } else {
                connectScreen.style.display = 'block';
                connectedScreen.style.display = 'none';
                // Generate new code
                currentCode = generateTelegramCode();
                codeEl.textContent = currentCode;
                // Save to Firestore in background (don't wait)
                saveTelegramCode(currentCode);
            }
        });
    }

    // Copy code
    if (copyBtn) {
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(currentCode).then(() => {
                copyBtn.innerHTML = '<i class="fa-solid fa-check"></i> Скопировано!';
                copyBtn.classList.add('copied');
                setTimeout(() => {
                    copyBtn.innerHTML = '<i class="fa-solid fa-copy"></i> Копировать';
                    copyBtn.classList.remove('copied');
                }, 2000);
            });
        });
    }

    // Verify connection
    const verifyBtn = document.getElementById('verify-telegram-btn');
    const errorEl = document.getElementById('telegram-error');

    if (verifyBtn) {
        verifyBtn.addEventListener('click', async () => {
            verifyBtn.disabled = true;
            verifyBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Проверяю...';
            if (errorEl) errorEl.style.display = 'none';

            try {
                // Temporarily delete webhook to use getUpdates
                await fetch(`${TELEGRAM_API}/deleteWebhook`);

                // Get updates
                const response = await fetch(`${TELEGRAM_API}/getUpdates?limit=100`);
                const result = await response.json();

                // Restore webhook
                await fetch(`${TELEGRAM_API}/setWebhook?url=https://projectman-git-main-batrosas-projects.vercel.app/api/webhook`);

                if (result.ok) {
                    // Find message with the code
                    const updates = result.result || [];
                    let found = null;

                    for (const update of updates.reverse()) {
                        const msg = update.message;
                        if (msg && msg.text && msg.text.toUpperCase().includes(currentCode)) {
                            found = {
                                chatId: msg.chat.id,
                                username: msg.from.username
                            };
                            break;
                        }
                    }

                    if (found) {
                        // Save to Firestore
                        await db.collection('users').doc(state.currentUser.uid).update({
                            telegramChatId: String(found.chatId),
                            telegramUsername: found.username || null
                        });

                        state.currentUser.telegramChatId = String(found.chatId);
                        state.currentUser.telegramUsername = found.username;

                        // Show success
                        connectScreen.style.display = 'none';
                        connectedScreen.style.display = 'block';
                        userInfoEl.textContent = found.username ? `@${found.username}` : 'Telegram подключен';
                        window.updateTelegramStatus && window.updateTelegramStatus();

                        // Send welcome message
                        await sendTelegramNotification(found.chatId,
                            '✅ <b>Telegram успешно подключен!</b>\n\nТеперь вы будете получать уведомления о новых задачах и возвратах на доработку.');

                        playClickSound();
                    } else {
                        if (errorEl) {
                            errorEl.textContent = 'Код не найден. Убедитесь, что отправили код боту.';
                            errorEl.style.display = 'block';
                        }
                    }
                } else {
                    if (errorEl) {
                        errorEl.textContent = 'Ошибка проверки. Попробуйте ещё раз.';
                        errorEl.style.display = 'block';
                    }
                }
            } catch (error) {
                console.error('Verify error:', error);
                if (errorEl) {
                    errorEl.textContent = 'Ошибка соединения. Попробуйте ещё раз.';
                    errorEl.style.display = 'block';
                }
            }

            verifyBtn.disabled = false;
            verifyBtn.innerHTML = '<i class="fa-solid fa-check"></i> Проверить подключение';
        });
    }

    // Disconnect
    if (disconnectBtn) {
        disconnectBtn.addEventListener('click', async () => {
            if (!confirm('Отключить Telegram уведомления?')) return;

            try {
                await db.collection('users').doc(state.currentUser.uid).update({
                    telegramChatId: null,
                    telegramUsername: null
                });

                state.currentUser.telegramChatId = null;
                state.currentUser.telegramUsername = null;

                modal.classList.remove('active');
                window.updateTelegramStatus && window.updateTelegramStatus();
                playClickSound();
            } catch (error) {
                console.error('Error disconnecting Telegram:', error);
                alert('Ошибка при отключении');
            }
        });
    }

    // Global function to update status
    window.updateTelegramStatus = function () {
        const statusEl = document.getElementById('telegram-status');
        if (!statusEl) return;

        if (state.currentUser?.telegramChatId) {
            statusEl.textContent = 'Подключен ✓';
            statusEl.style.color = 'var(--success)';
        } else {
            statusEl.textContent = 'Не подключен';
            statusEl.style.color = '';
        }
    };

    // Global function to start listening for Telegram changes (called after auth)
    window.startTelegramListener = function () {
        if (!state.currentUser?.uid) return;

        db.collection('users').doc(state.currentUser.uid).onSnapshot((doc) => {
            if (doc.exists) {
                const data = doc.data();
                const wasConnected = state.currentUser.telegramChatId;
                const isConnected = data.telegramChatId;

                // Update local state
                state.currentUser.telegramChatId = data.telegramChatId || null;
                state.currentUser.telegramUsername = data.telegramUsername || null;

                // If just connected, update UI
                if (isConnected && !wasConnected) {
                    const modal = document.getElementById('telegram-modal');
                    const connectScreen = document.getElementById('telegram-connect-screen');
                    const connectedScreen = document.getElementById('telegram-connected-screen');
                    const userInfoEl = document.getElementById('telegram-user-info');

                    if (modal?.classList.contains('active')) {
                        connectScreen.style.display = 'none';
                        connectedScreen.style.display = 'block';
                        if (userInfoEl) {
                            userInfoEl.textContent = data.telegramUsername ?
                                `@${data.telegramUsername}` : 'Telegram подключен';
                        }
                    }
                }

                // Always update status button
                window.updateTelegramStatus && window.updateTelegramStatus();
            }
        });
    };
}

function checkReminders(tasks) {
    // Only run if we have users loaded
    if (!state.users || state.users.length === 0) return;

    const now = new Date();
    const TWO_HOURS_MS = 2 * 60 * 60 * 1000; // 2 hours in milliseconds

    tasks.forEach(task => {
        if (task.status === 'done') return;

        const deadlineDate = new Date(task.deadline);
        const projectName = document.getElementById('project-title')?.textContent || 'Проект';

        // Handle createdAt
        let createdAtDate;
        if (task.createdAt && task.createdAt.toDate) {
            createdAtDate = task.createdAt.toDate();
        } else if (task.createdAt) {
            createdAtDate = new Date(task.createdAt);
        } else {
            return;
        }

        // Get current subStatus
        const currentSubStatus = task.subStatus || 'assigned';

        // 1. Check for "take task" reminder (status = assigned, 2+ hours passed)
        if (currentSubStatus === 'assigned' && task.assigneeEmail) {
            const timeSinceCreation = now - createdAtDate;

            // Check if 2+ hours since creation
            if (timeSinceCreation >= TWO_HOURS_MS) {
                // Check last reminder time
                let lastReminderTime = null;
                if (task.lastNotTakenReminder) {
                    if (task.lastNotTakenReminder.toDate) {
                        lastReminderTime = task.lastNotTakenReminder.toDate();
                    } else {
                        lastReminderTime = new Date(task.lastNotTakenReminder);
                    }
                }

                // Send if never sent or 2+ hours since last reminder
                const shouldSend = !lastReminderTime || (now - lastReminderTime >= TWO_HOURS_MS);

                if (shouldSend) {
                    const emails = task.assigneeEmail.split(',');
                    emails.forEach((email) => {
                        if (email && email.trim()) {
                            sendTelegramTakeTaskReminder(email.trim(), task.title, projectName);
                        }
                    });

                    // Update last reminder time
                    db.collection('tasks').doc(task.id).update({
                        lastNotTakenReminder: new Date().toISOString()
                    });
                }
            }
        }

        // 2. Check for overdue notification (status = in_work, deadline passed)
        // Send notification the day AFTER the deadline (not on the deadline day itself)
        // Also don't send if task was just taken into work (within last hour)
        if (currentSubStatus === 'in_work' && task.assigneeEmail && !task.overdueNotificationSent) {
            // Check if task was taken into work recently (within last hour) - don't notify yet
            let takenToWorkTime = null;
            if (task.takenToWorkAt) {
                if (task.takenToWorkAt.toDate) {
                    takenToWorkTime = task.takenToWorkAt.toDate();
                } else {
                    takenToWorkTime = new Date(task.takenToWorkAt);
                }
            }

            const ONE_HOUR_MS = 60 * 60 * 1000;
            const timeSinceTakenToWork = takenToWorkTime ? (now - takenToWorkTime) : Infinity;

            // Skip if task was taken into work less than 1 hour ago
            if (timeSinceTakenToWork < ONE_HOUR_MS) {
                return; // Don't send notification yet, give grace period
            }

            // Compare dates only (ignore time), using local timezone
            const todayDate = new Date();
            todayDate.setHours(0, 0, 0, 0);

            // Parse deadline as local date (not UTC)
            let deadlineDateLocal;
            if (typeof task.deadline === 'string' && task.deadline.match(/^\d{4}-\d{2}-\d{2}$/)) {
                const [year, month, day] = task.deadline.split('-').map(Number);
                deadlineDateLocal = new Date(year, month - 1, day);
            } else {
                deadlineDateLocal = new Date(task.deadline);
            }
            deadlineDateLocal.setHours(0, 0, 0, 0);

            // Calculate difference in days
            const diffDays = Math.floor((todayDate - deadlineDateLocal) / (1000 * 60 * 60 * 24));

            // Send notification only if we're at least 1 day AFTER the deadline
            if (diffDays >= 1) {
                const emails = task.assigneeEmail.split(',');
                emails.forEach((email) => {
                    if (email && email.trim()) {
                        sendTelegramOverdueNotification(email.trim(), task.title, projectName, task.deadline);
                    }
                });

                // Mark as sent
                db.collection('tasks').doc(task.id).update({ overdueNotificationSent: true });
            }
        }

        // 3. Original deadline reminder (less than 20% time left)
        if (!task.reminderSent && task.assigneeEmail) {
            const totalDuration = deadlineDate - createdAtDate;
            const timeLeft = deadlineDate - now;

            if (totalDuration > 0) {
                const percentage = (timeLeft / totalDuration) * 100;

                if (percentage < 20 && percentage > 0) {
                    const emails = task.assigneeEmail.split(',');
                    emails.forEach((email) => {
                        if (email && email.trim()) {
                            sendTelegramReminderNotification(email.trim(), task.title, projectName, task.deadline);
                        }
                    });

                    // Mark as sent
                    db.collection('tasks').doc(task.id).update({ reminderSent: true });
                }
            }
        }
    });
}

async function deleteUser(userId, userName) {
    // Check permission - only owner or admin can delete users
    if (!canAccessAdmin()) return;

    if (!confirm(`Вы уверены, что хотите удалить пользователя "${userName}"?\n\nЭто действие удалит данные пользователя из приложения, но технический аккаунт останется.`)) {
        return;
    }

    try {
        await db.collection('users').doc(userId).delete();
        alert(`Пользователь "${userName}" удален из базы данных.`);
    } catch (error) {
        console.error('Error deleting user:', error);
        alert('Ошибка при удалении пользователя: ' + error.message);
    }
}

function updateAccessUserSelect() {
    if (!elements.accessUserSelect) return;

    elements.accessUserSelect.innerHTML = '<option value="">Выберите пользователя...</option>';

    state.users.forEach(user => {
        let fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim();
        if (!fullName && user.displayName) fullName = user.displayName;
        if (!fullName && user.email) fullName = user.email.split('@')[0];
        if (!fullName) fullName = 'Без имени';

        const option = document.createElement('option');
        option.value = user.id;
        option.textContent = `${fullName} (${user.email || 'нет email'})`;
        elements.accessUserSelect.appendChild(option);
    });
}

function renderProjectCheckboxes(selectedUserId) {
    if (!elements.projectsCheckboxes) return;

    const user = state.users.find(u => u.id === selectedUserId);
    if (!user) return;

    elements.projectsCheckboxes.innerHTML = '';

    if (state.projects.length === 0) {
        elements.projectsCheckboxes.innerHTML = '<p style="color: var(--text-secondary); text-align: center; padding: 1rem;">Нет доступных проектов</p>';
        return;
    }

    const allowedProjects = user.allowedProjects || [];
    // Only check projects that are explicitly in the allowedProjects array
    // If user has all access (empty array), checkboxes will be unchecked when "all projects" is toggled off

    state.projects.forEach(project => {
        // Only check if project is explicitly in the list (not when hasAllAccess)
        const isChecked = allowedProjects.includes(project.id);

        const item = document.createElement('div');
        item.className = 'project-checkbox-item';
        item.innerHTML = `
            <input type="checkbox" id="project-${project.id}" ${isChecked ? 'checked' : ''} data-project-id="${project.id}">
            <label for="project-${project.id}">${project.name}</label>
        `;
        elements.projectsCheckboxes.appendChild(item);
    });
}

async function saveUserAccess() {
    const selectedUserId = elements.accessUserSelect.value;
    if (!selectedUserId) {
        alert('Выберите пользователя');
        return;
    }

    const allowAll = elements.allowAllProjects.checked;
    let allowedProjects = [];

    if (!allowAll) {
        // Get checked projects
        const checkboxes = elements.projectsCheckboxes.querySelectorAll('input[type="checkbox"]:checked');
        allowedProjects = Array.from(checkboxes).map(cb => cb.dataset.projectId);

        if (allowedProjects.length === 0) {
            if (!confirm('Вы не выбрали ни одного проекта. Пользователь не сможет видеть никакие проекты. Продолжить?')) {
                return;
            }
        }
    }

    try {
        await db.collection('users').doc(selectedUserId).set({
            allowedProjects: allowedProjects
        }, { merge: true });

        alert('Настройки доступа сохранены!');
    } catch (error) {
        console.error('Error saving access:', error);
        alert('Ошибка при сохранении: ' + error.message);
    }
}

// ========================================
// MY TASKS FUNCTIONALITY
// ========================================

// Fetch all tasks where current user is assignee
async function fetchMyTasks() {
    if (!state.currentUser) return [];

    const myTasks = [];
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

                // Check by email
                if (userEmail && task.assigneeEmail) {
                    const assigneeEmails = task.assigneeEmail.toLowerCase().split(',');
                    isAssignee = assigneeEmails.map(e => e.trim()).includes(userEmail);
                }

                // Check by name if email didn't match
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
    elements.myTasksList.innerHTML = `
        <div class="my-tasks-empty">
            <div class="spinner"></div>
            <p>Загрузка задач...</p>
        </div>
    `;

    const tasks = await fetchMyTasks();
    renderMyTasks(tasks);
}

// Render tasks in the My Tasks modal
function renderMyTasks(tasks) {
    if (tasks.length === 0) {
        elements.myTasksList.innerHTML = `
            <div class="my-tasks-empty">
                <i class="fa-solid fa-clipboard-check"></i>
                <p>У вас нет назначенных задач</p>
            </div>
        `;
        return;
    }

    elements.myTasksList.innerHTML = '';

    tasks.forEach(task => {
        const taskEl = document.createElement('div');
        taskEl.className = 'my-task-item';
        taskEl.dataset.projectId = task.projectId;
        taskEl.dataset.taskId = task.id;

        // Determine actual status (same logic as in createTaskCard)
        let currentSubStatus = task.subStatus || 'assigned';

        // Migration logic for old tasks without subStatus
        if (!task.subStatus) {
            if (task.assigneeCompleted) currentSubStatus = 'completed';
            else currentSubStatus = 'assigned';
        }

        // Override if global status is done
        if (task.status === 'done') {
            currentSubStatus = 'done';
        }

        // Status info
        let statusText = '';
        let statusClass = '';
        let statusIcon = '';

        switch (currentSubStatus) {
            case 'assigned':
                statusText = 'Поставлена';
                statusClass = 'status-assigned';
                statusIcon = 'fa-circle-exclamation';
                break;
            case 'in_work':
                statusText = 'В работе';
                statusClass = 'status-in-work';
                statusIcon = 'fa-person-digging';
                break;
            case 'completed':
                statusText = 'Завершена';
                statusClass = 'status-completed';
                statusIcon = 'fa-check';
                break;
            case 'done':
                statusText = 'В архиве';
                statusClass = 'status-done';
                statusIcon = 'fa-check-double';
                break;
            default:
                statusText = 'Поставлена';
                statusClass = 'status-assigned';
                statusIcon = 'fa-circle-exclamation';
        }

        // Deadline info
        let deadlineHtml = '';
        let deadlineClass = '';
        if (task.deadline) {
            const deadline = new Date(task.deadline);
            const now = new Date();
            const daysLeft = Math.ceil((deadline - now) / (1000 * 60 * 60 * 24));

            const formattedDate = deadline.toLocaleDateString('ru-RU', {
                day: 'numeric',
                month: 'short'
            });

            // Badges (same semantics as task card): "На проверке" + ("В срок" OR "Просрочено")
            let tags = [];
            if (currentSubStatus === 'completed') {
                tags.push(`<span class="deadline-tag tag-review">На проверке</span>`);
                const wasOnTime = getTaskWasCompletedOnTime(task);
                if (wasOnTime === true) tags.push(`<span class="deadline-tag tag-ontime">В срок</span>`);
                else if (wasOnTime === false) tags.push(`<span class="deadline-tag tag-overdue">Просрочено</span>`);
            } else {
                if (daysLeft < 0) {
                    deadlineClass = 'overdue';
                    tags.push(`<span class="deadline-tag tag-overdue">Просрочено</span>`);
                } else if (daysLeft === 0) {
                    tags.push(`<span class="deadline-tag tag-today">Сегодня</span>`);
                } else if (daysLeft > 0) {
                    tags.push(`<span class="deadline-tag tag-days">${daysLeft} дн.</span>`);
                }
            }

            deadlineHtml = `
                <span class="my-task-deadline ${deadlineClass}">
                    <i class="fa-regular fa-calendar"></i> ${formattedDate}
                </span>
                ${tags.length ? `<span class="deadline-tags-inline">${tags.join('')}</span>` : ''}
            `;
        }

        taskEl.innerHTML = `
            <div class="my-task-header">
                <span class="my-task-project">
                    <i class="fa-solid fa-folder"></i> ${escapeHtml(task.projectName)}
                </span>
                <span class="my-task-status ${statusClass}">
                    <i class="fa-solid ${statusIcon}"></i> ${statusText}
                </span>
            </div>
            <div class="my-task-title">${escapeHtml(task.title)}</div>
            <div class="my-task-meta">
                ${deadlineHtml}
                <span class="my-task-go">
                    Перейти к задаче <i class="fa-solid fa-arrow-right"></i>
                </span>
            </div>
        `;

        // Click handler - navigate to project
        taskEl.addEventListener('click', () => {
            playClickSound();
            navigateToTask(task.projectId, task.id);
        });

        elements.myTasksList.appendChild(taskEl);
    });
}

// Navigate to project containing the task
function navigateToTask(projectId, taskId) {
    // Close modal
    elements.myTasksModal.classList.remove('active');

    // Close sidebar on mobile
    if (window.innerWidth <= 768) {
        elements.sidebar.classList.remove('active');
        if (elements.sidebarOverlay) {
            elements.sidebarOverlay.classList.remove('active');
        }
    }

    // Select the project
    selectProject(projectId);

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

// Subscribe to real-time updates for My Tasks count
function subscribeToMyTasks() {
    // Unsubscribe from previous listener if exists
    if (myTasksListenerUnsubscribe) {
        myTasksListenerUnsubscribe();
        myTasksListenerUnsubscribe = null;
    }

    if (!state.currentUser) return;

    // Listen to all tasks and filter on client side
    myTasksListenerUnsubscribe = db.collection('tasks').onSnapshot(snapshot => {
        // Recalculate my tasks count when any task changes
        updateMyTasksCountFromSnapshot(snapshot);
    }, error => {
        console.error("Error listening to my tasks:", error);
    });
}

// Update count from snapshot (faster than fetching again)
function updateMyTasksCountFromSnapshot(snapshot) {
    if (!state.currentUser || !elements.myTasksCount) return;

    const userEmail = state.currentUser.email?.toLowerCase();
    const userFullName = state.currentUser.fullName ||
        `${state.currentUser.firstName || ''} ${state.currentUser.lastName || ''}`.trim();

    let activeCount = 0;

    snapshot.forEach(doc => {
        const task = doc.data();

        // Skip completed tasks
        if (task.status === 'done') return;

        let isAssignee = false;

        // Check by email
        if (userEmail && task.assigneeEmail) {
            const assigneeEmails = task.assigneeEmail.toLowerCase().split(',');
            isAssignee = assigneeEmails.map(e => e.trim()).includes(userEmail);
        }

        // Check by name if email didn't match
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

// Unsubscribe from my tasks listener
function unsubscribeFromMyTasks() {
    if (myTasksListenerUnsubscribe) {
        myTasksListenerUnsubscribe();
        myTasksListenerUnsubscribe = null;
    }
}

// Filter projects based on user access
function getFilteredProjects() {
    if (!state.currentUser) return [];

    // Admin sees all projects
    if (state.role === 'admin') {
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
    taskColumn: 'assigned', // 'assigned' | 'in-progress' | 'done'
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
            activeModal.classList.remove('active');
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
                    // Cycle columns left: done -> in-progress -> assigned -> projects
                    if (keyboardNav.taskColumn === 'done') {
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
                    // Cycle columns right: assigned -> in-progress -> done
                    if (keyboardNav.taskColumn === 'assigned') {
                        keyboardNav.taskColumn = 'in-progress';
                        setBoardView('in-progress');
                    } else if (keyboardNav.taskColumn === 'in-progress') {
                        keyboardNav.taskColumn = 'done';
                        setBoardView('done');
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
            'review': 'list-review',
            'done': 'list-done'
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
    initTelegramConnection();
    initProfileAndLeaderboard();
    initCalendarModule();

});

// ========== MIGRATION FUNCTION ==========
// Run this ONCE from browser console: migrateToOrganization('TEKO Group')
async function migrateToOrganization(orgName) {
    if (!auth.currentUser) {
        console.error('Please login first!');
        return;
    }

    console.log('Starting migration to organization:', orgName);

    try {
        // 1. Check if organization already exists with this name
        let orgId = null;
        let orgData = null;

        const existingOrgs = await db.collection('organizations').where('name', '==', orgName).get();

        if (!existingOrgs.empty) {
            // Use existing organization
            orgId = existingOrgs.docs[0].id;
            orgData = existingOrgs.docs[0].data();
            console.log('Found existing organization:', orgId);
        } else {
            // Create new organization
            const inviteCode = await generateUniqueInviteCode();
            orgData = {
                name: orgName,
                inviteCode: inviteCode,
                ownerId: auth.currentUser.uid,
                createdAt: firebase.firestore.FieldValue.serverTimestamp(),
                membersCount: 0,
                plan: 'free',
                settings: { maxUsers: 100, allowInvites: true }
            };
            const orgRef = await db.collection('organizations').add(orgData);
            orgId = orgRef.id;
            console.log('Created new organization:', orgId, 'Code:', inviteCode);
        }

        // 2. Migrate all users without organizationId
        const usersSnapshot = await db.collection('users').get();
        let userCount = 0;

        for (const userDoc of usersSnapshot.docs) {
            const userData = userDoc.data();
            if (!userData.organizationId) {
                const isOwner = userDoc.id === auth.currentUser.uid;
                await db.collection('users').doc(userDoc.id).set({
                    organizationId: orgId,
                    orgRole: isOwner ? 'owner' : (userData.role === 'admin' ? 'admin' : 'employee')
                }, { merge: true });
                userCount++;
                console.log('Migrated user:', userData.email, isOwner ? '(owner)' : '');
            }
        }

        // 3. Migrate all projects without organizationId
        const projectsSnapshot = await db.collection('projects').get();
        let projectCount = 0;

        for (const projectDoc of projectsSnapshot.docs) {
            const projectData = projectDoc.data();
            if (!projectData.organizationId) {
                await db.collection('projects').doc(projectDoc.id).update({
                    organizationId: orgId
                });
                projectCount++;
                console.log('Migrated project:', projectData.name);
            }
        }

        // 4. Migrate all tasks without organizationId
        const tasksSnapshot = await db.collection('tasks').get();
        let taskCount = 0;

        for (const taskDoc of tasksSnapshot.docs) {
            const taskData = taskDoc.data();
            if (!taskData.organizationId) {
                await db.collection('tasks').doc(taskDoc.id).update({
                    organizationId: orgId
                });
                taskCount++;
            }
        }
        console.log('Migrated tasks:', taskCount);

        // 5. Update members count
        await db.collection('organizations').doc(orgId).update({
            membersCount: userCount
        });

        console.log('=== MIGRATION COMPLETE ===');
        console.log('Organization:', orgName);
        console.log('Organization ID:', orgId);
        console.log('Invite Code:', orgData.inviteCode);
        console.log('Users migrated:', userCount);
        console.log('Projects migrated:', projectCount);
        console.log('Tasks migrated:', taskCount);
        console.log('');
        console.log('Reload the page to see changes!');

        return { orgId, inviteCode: orgData.inviteCode, userCount, projectCount, taskCount };
    } catch (error) {
        console.error('Migration failed:', error);
        throw error;
    }
}

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
        avatarImg.src = userData.profilePhotoUrl;
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
    countActiveTasks(userData.email).then(activeTasks => {
        document.getElementById('profile-active-tasks').textContent = activeTasks;
    });
}

async function countActiveTasks(userEmail) {
    if (!userEmail) return 0;

    const email = userEmail.toLowerCase();
    let activeTasks = 0;

    // Get all tasks from all projects
    const projectsSnapshot = await db.collection('projects')
        .where('organizationId', '==', state.organization?.id)
        .get();

    for (const projectDoc of projectsSnapshot.docs) {
        const tasksSnapshot = await db.collection('tasks')
            .where('projectId', '==', projectDoc.id)
            .get();

        tasksSnapshot.forEach(taskDoc => {
            const task = taskDoc.data();

            // Check if user is assignee and task is not done
            if (task.assigneeEmail && task.status !== 'done') {
                const assigneeEmails = task.assigneeEmail.toLowerCase().split(',').map(e => e.trim());
                if (assigneeEmails.includes(email)) {
                    activeTasks++;
                }
            }
        });
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
                ? `<img src="${user.profilePhotoUrl}" alt="${fullName}">`
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

    // Initialize photo crop
    initPhotoCrop();
}

// ========== CALENDAR MODULE ==========
let calendarState = {
    currentDate: new Date(),
    events: [],
    selectedUsers: new Set(),
    listenerUnsubscribe: null
};

const calElements = {
    btn: document.getElementById('calendar-btn'),
    modal: document.getElementById('calendar-modal'),
    grid: document.getElementById('calendar-grid'),
    monthTitle: document.getElementById('cal-current-month'),
    prevBtn: document.getElementById('cal-prev-month'),
    nextBtn: document.getElementById('cal-next-month'),
    todayBtn: document.getElementById('cal-today-btn'),

    eventModal: document.getElementById('cal-event-modal'),
    eventForm: document.getElementById('cal-event-form'),
    eventTitle: document.getElementById('ce-title'),
    eventDate: document.getElementById('ce-date'),
    eventTime: document.getElementById('ce-time'),
    eventDesc: document.getElementById('ce-desc'),
    eventId: document.getElementById('ce-id'),
    deleteBtn: document.getElementById('ce-delete-btn'),

    userSearch: document.getElementById('ce-user-search'),
    userDropdown: document.getElementById('ce-users-dropdown'),
    selectedUsersCont: document.getElementById('ce-selected-users')
};

function initCalendarModule() {
    calElements.btn?.addEventListener('click', () => {
        playClickSound();
        openCalendar();
    });

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

    calElements.eventForm?.addEventListener('submit', handleCalendarSubmit);
    calElements.deleteBtn?.addEventListener('click', deleteCalendarEvent);

    calElements.userSearch?.addEventListener('input', (e) => {
        const query = e.target.value.toLowerCase();
        renderCalUserDropdown(query);
    });

    calElements.userSearch?.addEventListener('focus', () => {
        renderCalUserDropdown(calElements.userSearch.value.toLowerCase());
    });

    document.addEventListener('click', (e) => {
        if (!calElements.userDropdown?.contains(e.target) && e.target !== calElements.userSearch) {
            calElements.userDropdown?.classList.remove('active');
        }
    });
}

function openCalendar() {
    calElements.modal?.classList.add('active');
    setupCalendarListener();
    renderCalendar();
}

function setupCalendarListener() {
    if (calendarState.listenerUnsubscribe) calendarState.listenerUnsubscribe();

    const orgId = state.organization?.id;
    if (!orgId) return;

    calendarState.listenerUnsubscribe = db.collection('calendar_events')
        .where('organizationId', '==', orgId)
        .onSnapshot(snapshot => {
            calendarState.events = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            renderCalendar();
        }, err => console.error("Calendar listener error:", err));
}

function renderCalendar() {
    if (!calElements.grid) return;

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

function addDayToGrid(num, otherMonth, fullDate) {
    const dayEl = document.createElement('div');
    dayEl.className = `calendar-day ${otherMonth ? 'other-month' : ''}`;

    const today = new Date();
    if (fullDate.toDateString() === today.toDateString()) {
        dayEl.classList.add('today');
    }

    dayEl.innerHTML = `
        <div class="day-number">${num}</div>
        <div class="calendar-events-container"></div>
    `;

    const eventsCont = dayEl.querySelector('.calendar-events-container');
    const dateStr = fullDate.toISOString().split('T')[0];

    const dayEvents = calendarState.events.filter(e => e.date === dateStr);
    dayEvents.forEach(evt => {
        const pill = document.createElement('div');
        pill.className = 'calendar-event-pill';
        pill.textContent = evt.title;
        pill.addEventListener('click', (e) => {
            e.stopPropagation();
            openEventModal(evt);
        });
        eventsCont.appendChild(pill);
    });

    dayEl.addEventListener('click', () => openEventModal(null, dateStr));
    calElements.grid.appendChild(dayEl);
}

function openEventModal(event = null, defaultDate = null) {
    calendarState.selectedUsers.clear();
    calElements.eventForm?.reset();
    calElements.eventId.value = event?.id || '';
    calElements.deleteBtn.style.display = event ? 'block' : 'none';

    if (event) {
        calElements.eventTitle.value = event.title;
        calElements.eventDate.value = event.date;
        calElements.eventTime.value = event.time;
        calElements.eventDesc.value = event.description || '';
        (event.participantIds || []).forEach(uid => calendarState.selectedUsers.add(uid));
    } else {
        calElements.eventDate.value = defaultDate || new Date().toISOString().split('T')[0];
        calElements.eventTime.value = "10:00";
        // Auto select current user
        if (state.currentUser?.uid) calendarState.selectedUsers.add(state.currentUser.uid);
    }

    renderCalSelectedUsers();
    calElements.eventModal?.classList.add('active');
}

function renderCalUserDropdown(query = '') {
    if (!calElements.userDropdown) return;

    const users = (state.users || []).filter(u => {
        const name = getUserDisplayName(u).toLowerCase();
        return name.includes(query) && !calendarState.selectedUsers.has(u.id);
    });

    if (users.length === 0) {
        calElements.userDropdown.classList.remove('active');
        return;
    }

    calElements.userDropdown.innerHTML = '';
    users.forEach(u => {
        const div = document.createElement('div');
        div.className = 'ce-user-option';
        div.innerHTML = `
            <div class="assignee-dropdown-avatar" style="width:24px;height:24px;font-size:0.7rem">
                ${getUserDisplayName(u).charAt(0)}
            </div>
            <span>${getUserDisplayName(u)}</span>
        `;
        div.onclick = () => {
            calendarState.selectedUsers.add(u.id);
            calElements.userSearch.value = '';
            calElements.userDropdown.classList.remove('active');
            renderCalSelectedUsers();
        };
        calElements.userDropdown.appendChild(div);
    });

    calElements.userDropdown.classList.add('active');
}

function renderCalSelectedUsers() {
    if (!calElements.selectedUsersCont) return;
    calElements.selectedUsersCont.innerHTML = '';

    calendarState.selectedUsers.forEach(uid => {
        const user = state.users.find(u => u.id === uid);
        if (!user) return;

        const chip = document.createElement('div');
        chip.className = 'ce-user-chip';
        chip.innerHTML = `
            <span>${getUserDisplayName(user)}</span>
            <i class="fa-solid fa-xmark"></i>
        `;
        chip.querySelector('i').onclick = () => {
            calendarState.selectedUsers.delete(uid);
            renderCalSelectedUsers();
        };
        calElements.selectedUsersCont.appendChild(chip);
    });
}

async function handleCalendarSubmit(e) {
    e.preventDefault();
    const id = calElements.eventId.value;
    const eventData = {
        title: calElements.eventTitle.value,
        date: calElements.eventDate.value,
        time: calElements.eventTime.value,
        description: calElements.eventDesc.value,
        participantIds: Array.from(calendarState.selectedUsers),
        organizationId: state.organization?.id,
        updatedAt: new Date().toISOString()
    };

    if (!db) {
        alert("Ошибка подключения к базе данных");
        return;
    }

    const orgId = state.organization?.id;
    if (!orgId) {
        alert("Ошибка: не найдена ваша организация. Попробуйте перезагрузить страницу.");
        return;
    }

    const submitBtn = document.querySelector(`button[type="submit"][form="cal-event-form"]`);
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Сохранение...';
    }

    try {
        if (id) {
            await db.collection('calendar_events').doc(id).update(eventData);
        } else {
            eventData.createdAt = new Date().toISOString();
            eventData.createdById = state.currentUser?.uid;
            await db.collection('calendar_events').add(eventData);

            // Notify participants via Telegram
            notifyCalendarParticipants(eventData);
        }
        calElements.eventModal?.classList.remove('active');
    } catch (err) {
        console.error("Error saving calendar event:", err);
        alert("Ошибка при сохранении события: " + err.message);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = '<i class="fa-solid fa-check"></i> Сохранить';
        }
    }
}

async function deleteCalendarEvent() {
    const id = calElements.eventId.value;
    if (!id || !confirm("Удалить эту встречу?")) return;

    try {
        await db.collection('calendar_events').doc(id).delete();
        calElements.eventModal?.classList.remove('active');
    } catch (err) {
        console.error("Error deleting event:", err);
    }
}

async function notifyCalendarParticipants(evt) {
    const participants = evt.participantIds.map(id => state.users.find(u => u.id === id)).filter(Boolean);
    const dateStr = new Date(evt.date).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long' });

    const message = `📅 <b>Новая встреча: ${evt.title}</b>\n\n` +
        `🗓 <b>Когда:</b> ${dateStr} в ${evt.time}\n` +
        `👥 <b>Участники:</b> ${participants.map(u => getUserDisplayName(u)).join(', ')}\n` +
        (evt.description ? `\n💬 <b>Описание:</b> ${evt.description}` : '');

    participants.forEach(u => {
        if (u.id !== state.currentUser?.uid && u.telegramChatId) {
            sendTelegramNotification(u.telegramChatId, message);
        }
    });
}




