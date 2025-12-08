// Firebase Config
const firebaseConfig = {
    apiKey: "AIzaSyBqNCgLUmlxfIKlDCwmx0-9D-JJm63RpuU",
    authDomain: "projectman-96d3c.firebaseapp.com",
    projectId: "projectman-96d3c",
    storageBucket: "projectman-96d3c.firebasestorage.app",
    messagingSenderId: "52414300696",
    appId: "1:52414300696:web:8dd04516cfd1c9668b796d"
};

// EmailJS Config (Get these from https://dashboard.emailjs.com/)
const emailConfig = {
    serviceID: "service_o3iwf1c",
    templateID: "template_3my1eym",
    publicKey: "LaM7YOc0hZIkPFIFl" // Updated
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

// Initialize EmailJS
(function () {
    // We check if emailjs is loaded to avoid errors if script fails
    if (typeof emailjs !== 'undefined') {
        emailjs.init(emailConfig.publicKey);
    }
})();

// Sound Effect - DISABLED
function playClickSound() {
    // Sound removed per user request
}

// ========== SECRET PIN CODE ==========
const SECRET_PIN = '1733';
let currentPin = '';
let pinVerified = false;

function initPinScreen() {
    const pinScreen = document.getElementById('pin-screen');
    const pinKeys = document.querySelectorAll('.pin-key[data-value]');
    const pinDelete = document.getElementById('pin-delete');
    const pinDots = document.querySelectorAll('.pin-dot');
    const pinError = document.getElementById('pin-error');
    
    if (!pinScreen) return;
    
    // Show PIN screen
    pinScreen.style.display = 'flex';
    
    // Handle number keys
    pinKeys.forEach(key => {
        key.addEventListener('click', () => {
            if (currentPin.length < 4) {
                currentPin += key.dataset.value;
                updatePinDots();
                
                // Check PIN when 4 digits entered
                if (currentPin.length === 4) {
                    setTimeout(checkPin, 200);
                }
            }
        });
    });
    
    // Handle delete key
    if (pinDelete) {
        pinDelete.addEventListener('click', () => {
            if (currentPin.length > 0) {
                currentPin = currentPin.slice(0, -1);
                updatePinDots();
                hidePinError();
            }
        });
    }
    
    // Handle keyboard input
    document.addEventListener('keydown', handlePinKeyboard);
    
    function updatePinDots() {
        pinDots.forEach((dot, index) => {
            dot.classList.remove('filled', 'error');
            if (index < currentPin.length) {
                dot.classList.add('filled');
            }
        });
    }
    
    function checkPin() {
        if (currentPin === SECRET_PIN) {
            // Success!
            pinVerified = true;
            pinDots.forEach(dot => dot.classList.add('filled'));
            
            setTimeout(() => {
                pinScreen.style.opacity = '0';
                pinScreen.style.transition = 'opacity 0.4s ease';
                
                setTimeout(() => {
                    pinScreen.style.display = 'none';
                    document.removeEventListener('keydown', handlePinKeyboard);
                    // Continue with normal app flow
                    proceedAfterPin();
                }, 400);
            }, 300);
        } else {
            // Wrong PIN
            pinDots.forEach(dot => dot.classList.add('error'));
            showPinError('Неверный код доступа');
            
            setTimeout(() => {
                currentPin = '';
                updatePinDots();
            }, 600);
        }
    }
    
    function showPinError(message) {
        if (pinError) {
            pinError.textContent = message;
            pinError.classList.add('visible');
        }
    }
    
    function hidePinError() {
        if (pinError) {
            pinError.classList.remove('visible');
        }
    }
    
    function handlePinKeyboard(e) {
        if (pinVerified) return;
        
        if (e.key >= '0' && e.key <= '9' && currentPin.length < 4) {
            currentPin += e.key;
            updatePinDots();
            
            if (currentPin.length === 4) {
                setTimeout(checkPin, 200);
            }
        } else if (e.key === 'Backspace' && currentPin.length > 0) {
            currentPin = currentPin.slice(0, -1);
            updatePinDots();
            hidePinError();
        }
    }
}

function proceedAfterPin() {
    // Hide loading screen if visible
    const loadingScreen = document.getElementById('loading-screen');
    if (loadingScreen) {
        loadingScreen.classList.add('hidden');
    }
    
    // Now trigger auth flow based on current state
    if (typeof auth !== 'undefined' && auth.currentUser) {
        // User already logged in, load their role and proceed
        loadUserRole(auth.currentUser);
    } else {
        // Need to login - show auth screen
        showAuthScreen();
    }
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

// Start tips immediately and init PIN screen
document.addEventListener('DOMContentLoaded', () => {
    startLoadingTips();
    
    // Short delay to ensure CSS is loaded, then show PIN screen
    setTimeout(() => {
        hideLoadingScreen();
        initPinScreen();
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
    
    const response = await fetch(
        `https://api.cloudinary.com/v1_1/${cloudinaryConfig.cloudName}/auto/upload`,
        { method: 'POST', body: formData }
    );
    
    if (!response.ok) {
        const errorData = await response.json();
        console.error('Cloudinary error:', errorData);
        throw new Error('Ошибка загрузки файла: ' + (errorData.error?.message || response.statusText));
    }
    
    return await response.json();
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

    // 1. OFFICE DOCUMENTS (Word, Excel) -> Google Docs Viewer
    if (['word', 'excel'].includes(fileType)) {
        const viewerUrl = `https://docs.google.com/viewer?url=${encodeURIComponent(attachment.url)}&embedded=false`;
        window.open(viewerUrl, '_blank');
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
    role: 'guest', // 'admin' or 'reader'
    initialLoadDone: false, // To prevent selecting first project on every update
    currentUser: null, // { uid, email, firstName, lastName, role, allowedProjects }
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
    listInProgress: document.getElementById('list-in-progress'),
    listDone: document.getElementById('list-done'),

    // Counts
    countInProgress: document.getElementById('count-in-progress'),
    countDone: document.getElementById('count-done'),

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
    themeToggle: document.getElementById('theme-toggle'),

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
    
    // My Tasks
    myTasksBtn: document.getElementById('my-tasks-btn'),
    myTasksModal: document.getElementById('my-tasks-modal'),
    myTasksList: document.getElementById('my-tasks-list'),
    myTasksCount: document.getElementById('my-tasks-count'),
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
function setupRealtimeListeners() {
    // Listen for Projects
    db.collection('projects').orderBy('createdAt').onSnapshot(snapshot => {
        const projects = [];
        snapshot.forEach(doc => {
            projects.push({ id: doc.id, ...doc.data() });
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

        // Don't auto-select first project - let user choose
        // if (!state.activeProjectId && state.projects.length > 0 && !state.initialLoadDone) {
        //     selectProject(state.projects[0].id);
        //     state.initialLoadDone = true;
        // }

        renderProjects();
        renderBoard();
    });

    // Listen for Users (needed for project filtering)
    db.collection('users').onSnapshot(snapshot => {
        const users = [];
        snapshot.forEach(doc => {
            users.push({ id: doc.id, ...doc.data() });
        });
        state.users = users;
        // Re-render projects if user's access changes
        renderProjects();
    });
}

function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

function selectProject(id) {
    state.activeProjectId = id;
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
    elements.listInProgress.innerHTML = '<div class="spinner" style="margin: 2rem auto;"></div>';
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
            elements.listInProgress.innerHTML = '<p style="color: var(--text-secondary); text-align: center;">Ошибка загрузки задач</p>';
        });
}

function deleteTask(id) {
    if (state.role !== 'admin') return;
    if (!confirm('Вы уверены, что хотите удалить эту задачу?')) return;
    db.collection('tasks').doc(id).delete();
}

function deleteProject(id) {
    if (state.role !== 'admin') return;
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
    if (state.role !== 'admin') return;

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

    // Populate assignees
    populateAssigneeDropdown();

    // Check assigned users
    if (task.assigneeEmail) {
        const emails = task.assigneeEmail.split(',').map(e => e.trim());
        emails.forEach(email => {
            const checkbox = document.querySelector(`input[name="assignee-select"][value="${email}"]`);
            if (checkbox) checkbox.checked = true;
        });
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
        li.innerHTML = `
            <i class="fa-solid fa-folder"></i>
            <span>${project.name}</span>
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
    elements.projectDesc.textContent = activeProject.description || '';
    elements.addTaskBtn.disabled = false;
    elements.deleteProjectBtn.style.display = 'flex';
    elements.deleteProjectBtn.onclick = () => {
        playClickSound();
        deleteProject(activeProject.id);
    };

    // Clear lists
    elements.listInProgress.innerHTML = '';
    elements.listDone.innerHTML = '';

    const projectTasks = state.tasks.filter(t => t.projectId === activeProject.id);

    // Sort: In-progress tasks by deadline (closest first)
    projectTasks.sort((a, b) => {
        if (a.status === 'in-progress' && b.status === 'in-progress') {
            return new Date(a.deadline) - new Date(b.deadline);
        }
        return 0;
    });

    // Update counts
    elements.countInProgress.textContent = projectTasks.filter(t => t.status === 'in-progress').length;
    elements.countDone.textContent = projectTasks.filter(t => t.status === 'done').length;

    projectTasks.forEach(task => {
        const card = createTaskCard(task);
        if (task.status === 'in-progress') elements.listInProgress.appendChild(card);
        else if (task.status === 'done') elements.listDone.appendChild(card);
    });
}

// --- NEW TASK CARD WITH STATUS BADGES ---
// Global Status Menu
let globalStatusMenu = null;

function createGlobalStatusMenu() {
    if (globalStatusMenu) return;
    
    globalStatusMenu = document.createElement('div');
    globalStatusMenu.className = 'status-dropdown global-dropdown';
    globalStatusMenu.style.position = 'fixed';
    globalStatusMenu.style.zIndex = '10000';
    globalStatusMenu.style.marginTop = '0';
    globalStatusMenu.style.minWidth = '220px';
    document.body.appendChild(globalStatusMenu);
    
    // Close on click outside
    document.addEventListener('click', (e) => {
        if (globalStatusMenu && globalStatusMenu.style.display !== 'none' && !globalStatusMenu.contains(e.target) && !e.target.closest('.status-badge')) {
            globalStatusMenu.style.display = 'none';
        }
    });
    
    // Close on scroll
    window.addEventListener('scroll', () => {
        if (globalStatusMenu) globalStatusMenu.style.display = 'none';
    }, { capture: true, passive: true });
}

function openStatusMenu(event, task, currentSubStatus) {
    event.stopPropagation();
    playClickSound();
    createGlobalStatusMenu();
    
    // Clear previous options
    globalStatusMenu.innerHTML = '';
    globalStatusMenu.style.display = 'flex';
    
    const isAdmin = state.role === 'admin';
    
    // Determine assignee status again
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
    
    const addOption = (label, icon, newStatus, requiresProof = false) => {
        const opt = document.createElement('div');
        opt.className = 'status-option';
        opt.innerHTML = `${icon} ${label}`;
        opt.onclick = (e) => {
            e.stopPropagation();
            playClickSound();
            globalStatusMenu.style.display = 'none';
            
            // If completing task, require proof first
            if (requiresProof) {
                openCompletionProofModal(task.id);
            } else {
                updateTaskSubStatus(task.id, newStatus);
            }
        };
        globalStatusMenu.appendChild(opt);
    };

    // Populate options based on permissions
    if (currentSubStatus !== 'done') {
        if (isAssignee) {
            if (currentSubStatus === 'assigned') {
                addOption('Принять в работу', '<i class="fa-solid fa-person-digging"></i>', 'in_work');
            } else if (currentSubStatus === 'in_work') {
                // Require proof when completing task
                addOption('Задача завершена', '<i class="fa-solid fa-check"></i>', 'completed', true);
            }
        }
        
        if (isAdmin) {
             if (currentSubStatus === 'completed') {
                 addOption('Подтвердить (В архив)', '<i class="fa-solid fa-check-double"></i>', 'done');
                 addOption('Вернуть на доработку', '<i class="fa-solid fa-rotate-left"></i>', 'in_work');
             } 
        }
    } else {
        if (isAdmin) {
            addOption('Вернуть в работу', '<i class="fa-solid fa-rotate-left"></i>', 'in_work');
        }
    }
    
    // Position menu
    const badge = event.target.closest('.status-badge');
    const rect = badge.getBoundingClientRect();
    
    globalStatusMenu.style.top = (rect.bottom + 6) + 'px';
    globalStatusMenu.style.left = rect.left + 'px';
    
    // Ensure it doesn't go off screen right
    const menuWidth = 220;
    if (rect.left + menuWidth > window.innerWidth) {
        globalStatusMenu.style.left = (window.innerWidth - menuWidth - 10) + 'px';
    }
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

    switch(currentSubStatus) {
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
    const isAdmin = state.role === 'admin';
    
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

    // Simplify permission check just for cursor style
    if (currentSubStatus !== 'done') {
        if (isAssignee) {
            if (currentSubStatus === 'assigned' || currentSubStatus === 'in_work') canInteract = true;
        }
        if (isAdmin && currentSubStatus === 'completed') canInteract = true;
    } else {
        if (isAdmin) canInteract = true;
    }

    if (canInteract) {
        badge.onclick = (e) => {
            openStatusMenu(e, task, currentSubStatus);
        };
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
        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.textContent = initials;
        avatar.title = assignee; 

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

    let daysLeftText = '';
    if (diffDays < 0) {
        daysLeftText = 'ПРОСРОЧЕНО';
    } else if (diffDays === 0) {
        daysLeftText = 'Сегодня';
    } else {
        daysLeftText = `${diffDays} дн.`;
    }

    const daysLeftSpan = document.createElement('span');
    daysLeftSpan.className = 'days-left';
    daysLeftSpan.textContent = daysLeftText;

    if (diffDays < 0) {
        daysLeftSpan.style.color = 'var(--danger)';
        daysLeftSpan.style.fontWeight = '700';
    }

    deadlineDiv.appendChild(daysLeftSpan);

    const timeLeft = deadlineDate - now;
    if (task.status !== 'done') {
        if (timeLeft < 0) {
            deadlineDiv.classList.add('deadline-red');
        } else {
            deadlineDiv.classList.add('deadline-green');
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
function updateTaskSubStatus(taskId, newSubStatus, completionData = null) {
    const updates = {
        subStatus: newSubStatus
    };

    if (newSubStatus === 'done') {
        updates.status = 'done';
        updates.subStatus = 'completed'; // Keep visual state but move to done list
        updates.archivedAt = new Date().toISOString();
    } else {
        updates.status = 'in-progress';
    }
    
    // Save timestamps for status changes
    if (newSubStatus === 'in_work') {
        updates.takenToWorkAt = new Date().toISOString();
        
        // Clear completion data when returning to work
        updates.completedAt = null;
        updates.completionComment = null;
        updates.completionProof = null;
        updates.completedBy = null;
        updates.archivedAt = null;
    }
    
    // Sync legacy fields for backward compatibility if needed, 
    // but new UI relies on subStatus mostly.
    if (newSubStatus === 'completed') {
        updates.assigneeCompleted = true;
        updates.completedAt = new Date().toISOString();
        
        // Add completion proof data if provided
        if (completionData) {
            updates.completionComment = completionData.comment;
            updates.completionProof = completionData.proof;
            updates.completedBy = state.currentUser ? 
                `${state.currentUser.firstName || ''} ${state.currentUser.lastName || ''}`.trim() : 'Unknown';
        }
    } else {
        updates.assigneeCompleted = false;
    }

    db.collection('tasks').doc(taskId).update(updates).then(() => {
        playClickSound();
        console.log("Status updated to:", newSubStatus);
    }).catch(error => {
        console.error("Error updating status:", error);
        alert("Ошибка: " + error.message);
    });
}

// ========== COMPLETION PROOF MODAL ==========
let completionProofAttachment = null;

function openCompletionProofModal(taskId) {
    const modal = document.getElementById('completion-proof-modal');
    document.getElementById('completion-task-id').value = taskId;
    document.getElementById('completion-comment').value = '';
    completionProofAttachment = null;
    renderCompletionAttachment();
    modal.classList.add('active');
}

function renderCompletionAttachment() {
    const list = document.getElementById('completion-attachments-list');
    const btn = document.getElementById('add-completion-file-btn');
    
    if (!list) return;
    list.innerHTML = '';
    
    if (completionProofAttachment) {
        const item = document.createElement('div');
        item.className = 'attachment-item' + (completionProofAttachment.uploading ? ' uploading' : '');
        
        const iconClass = getFileIcon(completionProofAttachment.type || 'other');
        
        item.innerHTML = `
            <div class="attachment-icon ${completionProofAttachment.type || 'other'}">
                <i class="fa-solid ${iconClass}"></i>
            </div>
            <div class="attachment-info">
                <div class="attachment-name">${completionProofAttachment.name}</div>
                <div class="attachment-size">${completionProofAttachment.uploading ? 'Загрузка...' : formatFileSize(completionProofAttachment.size)}</div>
            </div>
            ${!completionProofAttachment.uploading ? `
                <button type="button" class="attachment-remove" onclick="removeCompletionAttachment()">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            ` : ''}
        `;
        
        list.appendChild(item);
        btn.style.display = 'none';
    } else {
        btn.style.display = 'flex';
    }
}

function removeCompletionAttachment() {
    completionProofAttachment = null;
    renderCompletionAttachment();
}

async function handleCompletionFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    event.target.value = '';
    
    if (file.size > cloudinaryConfig.maxFileSize) {
        alert(`Файл слишком большой. Максимум ${formatFileSize(cloudinaryConfig.maxFileSize)}`);
        return;
    }
    
    const fileType = getFileType(file.name);
    completionProofAttachment = {
        name: file.name,
        size: file.size,
        type: fileType,
        uploading: true
    };
    
    renderCompletionAttachment();
    
    try {
        const result = await uploadToCloudinary(file);
        
        completionProofAttachment = {
            name: file.name,
            url: result.secure_url,
            type: fileType,
            size: file.size,
            publicId: result.public_id,
            uploadedAt: new Date().toISOString()
        };
        
        renderCompletionAttachment();
        playClickSound();
    } catch (error) {
        console.error('Upload error:', error);
        alert('Ошибка при загрузке файла: ' + error.message);
        completionProofAttachment = null;
        renderCompletionAttachment();
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
    
    if (!completionProofAttachment || !completionProofAttachment.url) {
        alert('Пожалуйста, прикрепите файл-подтверждение');
        return;
    }
    
    const completionData = {
        comment: comment,
        proof: completionProofAttachment
    };
    
    updateTaskSubStatus(taskId, 'completed', completionData);
    
    // Close modal
    document.getElementById('completion-proof-modal').classList.remove('active');
    completionProofAttachment = null;
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
                <div class="timeline-label">Задача создана</div>
                <div class="timeline-date">${createdAt || 'Дата не сохранена'}</div>
            </div>
        </div>
    `;
    
    if (takenToWorkAt) {
        timelineHTML += `
            <div class="timeline-item">
                <div class="timeline-icon in-work"><i class="fa-solid fa-person-digging"></i></div>
                <div class="timeline-content">
                    <div class="timeline-label">Взята в работу</div>
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
                    <div class="timeline-label">Завершена исполнителем${task.completedBy ? ' (' + task.completedBy + ')' : ''}</div>
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
                    <div class="timeline-label">Подтверждена администратором (архив)</div>
                    <div class="timeline-date">${archivedAt}</div>
                </div>
            </div>
        `;
    }
    
    // Completion proof section
    let proofHTML = '';
    if (task.completionComment || task.completionProof) {
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
                    ${task.completionProof && task.completionProof.url ? `
                        <div class="completion-proof-file" data-proof='${JSON.stringify(task.completionProof).replace(/'/g, "\\'")}'>
                            <i class="fa-solid ${getFileIcon(task.completionProof.type || 'other')}"></i>
                            <div class="completion-proof-file-info">
                                <div class="completion-proof-file-name">${escapeHtml(task.completionProof.name)}</div>
                                <div class="completion-proof-file-size">${formatFileSize(task.completionProof.size || 0)}</div>
                            </div>
                            <i class="fa-solid fa-external-link" style="color: var(--text-secondary);"></i>
                        </div>
                    ` : ''}
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
        
        ${proofHTML}
    `;
    
    // Add click handler for proof file
    const proofFileEl = content.querySelector('.completion-proof-file');
    if (proofFileEl) {
        proofFileEl.addEventListener('click', () => {
            try {
                const proofData = JSON.parse(proofFileEl.dataset.proof);
                openFilePreview(proofData);
            } catch (e) {
                console.error('Error parsing proof data:', e);
            }
        });
    }
    
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
    if (theme === 'light') {
        document.body.classList.add('light-mode');
        updateThemeIcon(true);
    }
}

function toggleTheme() {
    const isLight = document.body.classList.toggle('light-mode');
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
    updateThemeIcon(isLight);
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

function updateThemeIcon(isLight) {
    const btn = elements.themeToggle;
    if (isLight) {
        btn.innerHTML = '<i class="fa-regular fa-moon"></i> <span>Темная тема</span>';
    } else {
        btn.innerHTML = '<i class="fa-regular fa-sun"></i> <span>Светлая тема</span>';
    }
}

// Event Listeners
function setupEventListeners() {
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

    // Forms
    elements.projectForm.addEventListener('submit', (e) => {
        e.preventDefault();
        playClickSound();
        const name = document.getElementById('p-name').value;
        const desc = document.getElementById('p-desc').value;
        createProject(name, desc);
        elements.projectModal.classList.remove('active');
    });

    // Logic
    function createProject(name, description) {
        if (state.role !== 'admin') return;

        db.collection('projects').add({
            name,
            description,
            createdAt: firebase.firestore.FieldValue.serverTimestamp()
        }).then((docRef) => {
            selectProject(docRef.id);
            closeSidebarOnMobile();
        });
    }

    async function createTask(title, assignee, deadline, status, assigneeEmail, description) {
        if (state.role !== 'admin') return;
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
            
            await db.collection('tasks').add({
                projectId: state.activeProjectId,
                title,
                description: description || '',
                assignee: assignee || 'Не назначен',
                assigneeEmail: assigneeEmail || '',
                deadline,
                status,
                subStatus: 'assigned', // Default status for new system
                assigneeCompleted: false,
                attachments: attachments, // Add attachments array
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            if (assigneeEmail) {
                // Send email to all assignees
                const emails = assigneeEmail.split(',');
                const names = assignee.split(', ');

                emails.forEach((email, index) => {
                    if (email && email.trim()) {
                        const name = names[index] || 'Коллега';
                        sendEmailNotification(email.trim(), name, title, deadline);
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

        // Get selected assignees
        const checkboxes = document.querySelectorAll('input[name="assignee-select"]:checked');
        const selectedNames = [];
        const selectedEmails = [];

        checkboxes.forEach(cb => {
            selectedNames.push(cb.dataset.name);
            selectedEmails.push(cb.value);
        });

        const assignee = selectedNames.length > 0 ? selectedNames.join(', ') : 'Не назначен';
        const assigneeEmail = selectedEmails.join(','); // Comma separated emails

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

    elements.themeToggle.addEventListener('click', () => {
        playClickSound();
        toggleTheme();
        closeSidebarOnMobile();
    });

    // Auth - Login/Register toggle
    document.getElementById('show-register').addEventListener('click', (e) => {
        playClickSound();
        e.preventDefault();
        elements.loginForm.style.display = 'none';
        elements.registerForm.style.display = 'block';
        document.getElementById('auth-title').textContent = 'Регистрация';
        document.getElementById('auth-subtitle').textContent = 'Создайте новый аккаунт';
    });

    document.getElementById('show-login').addEventListener('click', (e) => {
        playClickSound();
        e.preventDefault();
        elements.registerForm.style.display = 'none';
        elements.loginForm.style.display = 'block';
        document.getElementById('auth-title').textContent = 'Вход в систему';
        document.getElementById('auth-subtitle').textContent = 'Войдите или зарегистрируйтесь';
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
        });
    });

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

                    document.getElementById('selected-user-avatar').textContent = initials.toUpperCase() || 'U';
                    document.getElementById('selected-user-name').textContent = fullName;
                    document.getElementById('selected-user-email').textContent = user.email;

                    const hasAllAccess = !user.allowedProjects || user.allowedProjects.length === 0;
                    elements.allowAllProjects.checked = hasAllAccess;

                    if (!hasAllAccess) {
                        elements.projectsCheckboxes.parentElement.style.display = 'block';
                    }

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
        role: 'reader' // Default
    };

    // Timeout promise to prevent infinite loading
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Request timed out')), 5000)
    );

    // Fetch user profile to get name and role
    try {
        const userDocPromise = db.collection('users').doc(user.uid).get();
        
        // Race between fetch and timeout
        const userDoc = await Promise.race([userDocPromise, timeoutPromise]);

        if (userDoc.exists) {
            const userData = userDoc.data();
            state.currentUser.firstName = userData.firstName;
            state.currentUser.lastName = userData.lastName;
            state.currentUser.fullName = `${userData.firstName} ${userData.lastName}`.trim();
            state.currentUser.role = userData.role || 'reader'; // Get role from DB
            state.currentUser.allowedProjects = userData.allowedProjects || [];
        }
    } catch (e) {
        console.error("Error fetching user profile (using default role):", e);
        // Even on error, we proceed with default 'reader' role to unblock UI
    }

    // Always finish auth
    finishAuth(state.currentUser.role);
}

function finishAuth(role) {
    // Only proceed if PIN is verified
    if (!pinVerified) return;
    
    console.log("Auth finished. Role:", role); // Debug
    state.role = role;
    state.currentUser.role = role;

    hideAuthScreen();

    if (role === 'reader') {
        document.body.classList.add('read-only');
    } else {
        document.body.classList.remove('read-only');
    }

    // Setup admin panel if admin
    setupAdminPanel();

    // Don't auto-select first project - let user choose
    // if (state.projects.length > 0 && !state.activeProjectId) {
    //     selectProject(state.projects[0].id);
    // } 
    
    // Force re-render of everything now that we have permissions
    renderProjects();
    if (state.activeProjectId) {
        renderBoard();
    }
    
    // Subscribe to real-time My Tasks updates
    subscribeToMyTasks();
}

function showAuthScreen() {
    // Only show auth screen if PIN is verified
    if (!pinVerified) return;
    
    // Hide loading screen first
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
        
        await auth.signOut();
        state.activeProjectId = null;
        document.body.classList.remove('read-only');
        
        // Close sidebar on mobile
        closeSidebarOnMobile();
        
        // Hide my tasks badge
        if (elements.myTasksCount) {
            elements.myTasksCount.style.display = 'none';
        }

        // Reset PIN verification - require PIN again on next login
        pinVerified = false;
        currentPin = '';
        
        // Show PIN screen again
        const pinScreen = document.getElementById('pin-screen');
        if (pinScreen) {
            pinScreen.style.display = 'flex';
            pinScreen.style.opacity = '1';
            // Reset dots
            document.querySelectorAll('.pin-dot').forEach(dot => {
                dot.classList.remove('filled', 'error');
            });
        }
        
        // Hide app container
        document.getElementById('app-container').style.display = 'none';
        document.getElementById('auth-overlay').style.display = 'none';
        
        // Re-initialize PIN keyboard handler
        initPinScreen();
    } catch (error) {
        console.error('Error signing out:', error);
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
    // Only load when user is admin
    if (state.role !== 'admin') {
        elements.adminPanelBtn.style.display = 'none';
        return;
    }

    elements.adminPanelBtn.style.display = 'flex';

    // Load users from Firestore
    db.collection('users').onSnapshot(snapshot => {
        const users = [];
        snapshot.forEach(doc => {
            users.push({ id: doc.id, ...doc.data() });
        });
        state.users = users;
        renderUsersList();
        updateAccessUserSelect();
    });
}

function renderUsersList() {
    if (!elements.usersList) return;

    elements.usersList.innerHTML = '';
    elements.usersCount.textContent = `${state.users.length} ${state.users.length === 1 ? 'пользователь' : 'пользователей'}`;

    state.users.forEach(user => {
        const userItem = document.createElement('div');
        userItem.className = 'user-item';

        const initials = ((user.firstName || '')[0] || '') + ((user.lastName || '')[0] || '');
        const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Без имени';

        userItem.innerHTML = `
            <div class="user-info">
                <div class="avatar" style="width: 40px; height: 40px; font-size: 1rem;">${initials.toUpperCase() || 'U'}</div>
                <div class="user-details">
                    <div class="user-name">${fullName}</div>
                    <div class="user-email">${user.email}</div>
                </div>
            </div>
            <div class="user-actions">
                ${user.id !== state.currentUser.uid ? `
                    <button class="delete-user-btn" data-user-id="${user.id}">
                        <i class="fa-solid fa-trash"></i> Удалить
                    </button>
                ` : '<span style="color: var(--text-secondary); font-size: 0.85rem;">Это вы</span>'}
            </div>
        `;

        // Add delete handler
        const deleteBtn = userItem.querySelector('.delete-user-btn');
        if (deleteBtn) {
            deleteBtn.addEventListener('click', () => {
                playClickSound();
                deleteUser(user.id, fullName);
            });
        }

        elements.usersList.appendChild(userItem);
    });
}

function populateAssigneeDropdown() {
    const container = document.getElementById('t-assignee-container');
    if (!container) return;

    container.innerHTML = '';

    if (state.users.length === 0) {
        container.innerHTML = '<div style="padding:0.5rem; color:var(--text-secondary);">Нет пользователей</div>';
        return;
    }

    state.users.forEach(user => {
        const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;

        const div = document.createElement('div');
        div.className = 'assignee-option';

        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.name = 'assignee-select';
        checkbox.value = user.email;
        checkbox.id = `assignee-${user.id}`;
        checkbox.dataset.name = fullName;

        const label = document.createElement('label');
        label.htmlFor = `assignee-${user.id}`;
        label.textContent = fullName;

        div.appendChild(checkbox);
        div.appendChild(label);
        container.appendChild(div);
    });
}

function sendEmailNotification(email, name, taskTitle, deadline) {
    console.log(`[EmailJS] Preparing to send email to: ${email} (Name: ${name})`);

    // Check if EmailJS is configured
    if (!emailConfig.serviceID || emailConfig.serviceID === "YOUR_SERVICE_ID") {
        console.error("EmailJS not configured correctly");
        return;
    }

    const templateParams = {
        to_email: email,
        to_name: name,
        task_title: taskTitle,
        task_deadline: deadline,
        project_name: document.getElementById('project-title').textContent
    };

    emailjs.send(emailConfig.serviceID, emailConfig.templateID, templateParams)
        .then(function (response) {
            console.log('SUCCESS!', response.status, response.text);
            // alert(`Задача создана и уведомление отправлено на ${email}`);
        }, function (error) {
            console.log('FAILED...', error);
            alert('Задача создана, но не удалось отправить email: ' + JSON.stringify(error));
        });
}

function sendReminderEmail(email, name, taskTitle, deadline) {
    if (!emailConfig.serviceID) return;

    const templateParams = {
        to_email: email,
        to_name: name,
        task_title: taskTitle,
        task_deadline: deadline,
        project_name: "ProjectMan (Напоминание)",
        message: "Внимание! Срок выполнения задачи истекает (менее 20% времени)."
    };

    emailjs.send(emailConfig.serviceID, emailConfig.templateID, templateParams)
        .then(function (response) {
            console.log('Reminder sent!', response.status, response.text);
        }, function (error) {
            console.log('Reminder failed...', error);
        });
}

function checkReminders(tasks) {
    // Only run if we have users loaded to find emails
    if (!state.users || state.users.length === 0) return;

    tasks.forEach(task => {
        if (task.status === 'done') return;
        if (task.reminderSent) return;

        const now = new Date();
        const deadlineDate = new Date(task.deadline);

        // Handle createdAt
        let createdAtDate;
        if (task.createdAt && task.createdAt.toDate) {
            createdAtDate = task.createdAt.toDate();
        } else if (task.createdAt) {
            createdAtDate = new Date(task.createdAt);
        } else {
            return;
        }

        const totalDuration = deadlineDate - createdAtDate;
        const timeLeft = deadlineDate - now;

        if (totalDuration <= 0) return;

        const percentage = (timeLeft / totalDuration) * 100;

        if (percentage < 20) {
            // Find user emails from task.assigneeEmail
            if (task.assigneeEmail) {
                const emails = task.assigneeEmail.split(',');
                const names = task.assignee.split(', ');

                emails.forEach((email, index) => {
                    if (email && email.trim()) {
                        const name = names[index] || 'Коллега';
                        sendReminderEmail(email.trim(), name, task.title, task.deadline);
                    }
                });

                // Mark as sent
                db.collection('tasks').doc(task.id).update({ reminderSent: true });
            }
        }
    });
}

async function deleteUser(userId, userName) {
    if (state.role !== 'admin') return;

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
        const fullName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Без имени';
        const option = document.createElement('option');
        option.value = user.id;
        option.textContent = `${fullName} (${user.email})`;
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
    const hasAllAccess = allowedProjects.length === 0;

    state.projects.forEach(project => {
        const isChecked = hasAllAccess || allowedProjects.includes(project.id);

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
        await db.collection('users').doc(selectedUserId).update({
            allowedProjects: allowedProjects
        });

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
                
                if (isAssignee) {
                    myTasks.push({
                        ...task,
                        projectName: project.name,
                        projectId: project.id
                    });
                }
            });
        });
        
        // Sort by deadline (closest first) and status
        myTasks.sort((a, b) => {
            // Completed tasks at the end
            if (a.status === 'done' && b.status !== 'done') return 1;
            if (b.status === 'done' && a.status !== 'done') return -1;
            
            // Then by deadline
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
        
        // Status info
        const subStatus = task.subStatus || 'assigned';
        let statusText = '';
        let statusClass = '';
        let statusIcon = '';
        
        switch (subStatus) {
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
            default:
                if (task.status === 'done') {
                    statusText = 'Готово';
                    statusClass = 'status-completed';
                    statusIcon = 'fa-check-double';
                } else {
                    statusText = 'Поставлена';
                    statusClass = 'status-assigned';
                    statusIcon = 'fa-circle-exclamation';
                }
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
            
            if (daysLeft < 0) {
                deadlineClass = 'overdue';
            } else if (daysLeft <= 2) {
                deadlineClass = 'soon';
            }
            
            deadlineHtml = `
                <span class="my-task-deadline ${deadlineClass}">
                    <i class="fa-regular fa-calendar"></i> ${formattedDate}
                    ${daysLeft < 0 ? ' (просрочено)' : daysLeft === 0 ? ' (сегодня)' : daysLeft === 1 ? ' (завтра)' : ''}
                </span>
            `;
        }
        
        taskEl.innerHTML = `
            <div class="my-task-header">
                <span class="my-task-project">
                    <i class="fa-solid fa-folder"></i> ${task.projectName}
                </span>
                <span class="my-task-status ${statusClass}">
                    <i class="fa-solid ${statusIcon}"></i> ${statusText}
                </span>
            </div>
            <div class="my-task-title">${task.title}</div>
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

// Start
document.addEventListener('DOMContentLoaded', init);

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
