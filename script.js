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

// Initialize EmailJS
(function () {
    // We check if emailjs is loaded to avoid errors if script fails
    if (typeof emailjs !== 'undefined') {
        emailjs.init(emailConfig.publicKey);
    }
})();

// Initialize Firebase when ready
let db;
let auth;
let firebaseInitAttempts = 0;
let taskListenerUnsubscribe = null; // To manage real-time listener for tasks

function initFirebase() {
    if (typeof firebase !== 'undefined' && firebase.app) {
        // Check if already initialized
        if (!firebase.apps.length) {
            firebase.initializeApp(firebaseConfig);
        }

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
    const CURRENT_VERSION = '2.8'; // Increment this manually on big updates
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
        // Optional: Reload once to ensure fresh assets
        // window.location.reload(); 
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
    // Show loading state if needed
    // elements.projectList.innerHTML = '<li style="padding: 1rem; color: var(--text-secondary);">Загрузка...</li>';

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

        // If no active project and we have projects, select first (optional, maybe only on first load)
        if (!state.activeProjectId && state.projects.length > 0 && !state.initialLoadDone) {
            selectProject(state.projects[0].id);
            state.initialLoadDone = true;
        }

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

// Removed local storage functions
// function loadState() { ... }
// function saveState() { ... }
// function seedData() { ... }

function generateId() {
    return Math.random().toString(36).substr(2, 9);
}

// Logic - Functions moved to bottom to avoid duplicates
// createProject and deleteProject are now defined later


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

function createTask(title, assignee, deadline, status, assigneeEmail) {
    if (state.role !== 'admin') return;
    if (!state.activeProjectId) return;

    db.collection('tasks').add({
        projectId: state.activeProjectId,
        title,
        assignee: assignee || 'Не назначен',
        deadline,
        status,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
    }).then(() => {
        if (assigneeEmail) {
            sendEmailNotification(assigneeEmail, assignee, title, deadline);
        }
    });
}

function deleteTask(id) {
    if (state.role !== 'admin') return;
    db.collection('tasks').doc(id).delete();
}

function updateTaskStatus(id, newStatus) {
    if (state.role !== 'admin') return;
    db.collection('tasks').doc(id).update({
        status: newStatus
    });
}

function updateTask(id, data) {
    if (state.role !== 'admin') return;

    // Show loading state
    const submitBtn = elements.taskForm.querySelector('button[type="submit"]');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Сохранение...';

    db.collection('tasks').doc(id).update(data)
        .then(() => {
            console.log("✅ Задача успешно обновлена!");
            elements.taskModal.classList.remove('active');
            elements.taskForm.reset();
        })
        .catch((error) => {
            console.error("Error updating task:", error);
            alert("❌ Ошибка при обновлении задачи:\n\n" + error.message);
        })
        .finally(() => {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
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
        li.onclick = () => selectProject(project.id);
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
    elements.deleteProjectBtn.onclick = () => deleteProject(activeProject.id);

    // Clear lists
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
    // Update counts
    elements.countInProgress.textContent = projectTasks.filter(t => t.status === 'in-progress').length;
    elements.countDone.textContent = projectTasks.filter(t => t.status === 'done').length;

    projectTasks.forEach(task => {
        const card = createTaskCard(task);
        if (task.status === 'in-progress') elements.listInProgress.appendChild(card);
        else if (task.status === 'done') elements.listDone.appendChild(card);
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
    div.draggable = true;
    div.dataset.id = task.id;

    // Parse multiple assignees (comma-separated)
    const assignees = task.assignee.split(',').map(name => name.trim()).filter(name => name.length > 0);

    // Create completion button
    const completeBtn = document.createElement('button');
    completeBtn.className = 'assignee-complete-btn';

    // Check if current user is assignee - USE EMAIL for reliable check
    let isAssignee = false;
    if (state.currentUser && state.currentUser.email && task.assigneeEmail) {
        // Check if user's email is in the comma-separated list of assignee emails
        const assigneeEmails = task.assigneeEmail.toLowerCase().split(',');
        isAssignee = assigneeEmails.map(e => e.trim()).includes(state.currentUser.email.toLowerCase());
    }

    if (task.assigneeCompleted) {
        completeBtn.classList.add('completed');
        completeBtn.innerHTML = '<i class="fa-solid fa-check"></i>';
        completeBtn.title = 'Выполнено исполнителем';
    } else {
        completeBtn.innerHTML = '<i class="fa-regular fa-circle"></i>';
        completeBtn.title = 'Отметить как выполненное';
    }

    // Show button for assignee regardless of status (can mark done anytime)
    if (isAssignee) {
        completeBtn.onclick = (e) => {
            e.stopPropagation();
            toggleAssigneeCompletion(task.id, task.assigneeCompleted);
        };
        completeBtn.style.cursor = 'pointer';
    } else {
        // Not assignee - show as disabled
        completeBtn.disabled = true;
        completeBtn.style.cursor = 'default';
        if (!task.assigneeCompleted) {
            completeBtn.style.opacity = '0.3';
        }
    }

    // Create delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.className = 'delete-task';
    const deleteIcon = document.createElement('i');
    deleteIcon.className = 'fa-solid fa-trash';
    deleteBtn.appendChild(deleteIcon);
    deleteBtn.onclick = (e) => {
        e.stopPropagation();
        deleteTask(task.id);
    };

    // Create edit button
    const editBtn = document.createElement('button');
    editBtn.className = 'edit-task'; // You might need to add CSS for this class if 'delete-task' has specific styles
    // Reuse delete-task styles for simplicity or add inline styles
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
        avatar.title = assignee; // Tooltip with full name

        // Offset multiple avatars slightly
        if (index > 0) {
            avatar.style.marginLeft = '-8px';
        }

        assigneeDiv.appendChild(avatar);
    });

    // Show assignee names
    const assigneeName = document.createElement('span');
    assigneeName.textContent = assignees.join(', ');
    assigneeDiv.appendChild(assigneeName);

    const deadlineDiv = document.createElement('div');
    deadlineDiv.className = 'deadline';

    // Calculate time percentage for color
    const now = new Date();
    const deadlineDate = new Date(task.deadline);

    // Reset time part for accurate day calculation
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

    // Add days left element
    const daysLeftSpan = document.createElement('span');
    daysLeftSpan.className = 'days-left';
    daysLeftSpan.textContent = daysLeftText;

    // Custom style for Overdue
    if (diffDays < 0) {
        daysLeftSpan.style.color = 'var(--danger)';
        daysLeftSpan.style.fontWeight = '700';
        daysLeftSpan.style.letterSpacing = '0.05em';
    }

    deadlineDiv.appendChild(daysLeftSpan);

    // Existing color logic...
    let createdAtDate;
    if (task.createdAt && task.createdAt.toDate) {
        createdAtDate = task.createdAt.toDate();
    } else if (task.createdAt) {
        createdAtDate = new Date(task.createdAt);
    } else {
        createdAtDate = new Date(); // Fallback
    }

    const totalDuration = deadlineDate - createdAtDate;
    const timeLeft = deadlineDate - now;
    let percentage = 100;

    if (totalDuration > 0) {
        percentage = (timeLeft / totalDuration) * 100;
    }

    // Logic: 
    // < 0 time left (overdue) -> Red
    // < 50% time left -> Yellow/Orange
    // >= 50% time left -> Green
    if (task.status !== 'done') {
        if (timeLeft < 0) {
            deadlineDiv.classList.add('deadline-red');
        } else if (percentage < 50) {
            deadlineDiv.classList.add('deadline-orange');
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

    div.appendChild(completeBtn); // Add complete button
    div.appendChild(editBtn); // Add edit button
    div.appendChild(deleteBtn);
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

    // Desktop drag and drop
    div.addEventListener('dragstart', handleDragStart);

    // Mobile touch drag and drop
    setupTouchDragAndDrop(div);

    return div;
}

function toggleAssigneeCompletion(taskId, currentStatus) {
    db.collection('tasks').doc(taskId).update({
        assigneeCompleted: !currentStatus
    }).catch(error => {
        console.error("Error updating task completion:", error);
        alert("Ошибка при обновлении статуса задачи");
    });
}

function formatDate(dateString) {
    const options = { month: 'short', day: 'numeric' };
    return new Date(dateString).toLocaleDateString('ru-RU', options);
}

// Drag and Drop
let draggedTaskId = null;

function handleDragStart(e) {
    if (state.role !== 'admin') {
        e.preventDefault();
        return;
    }
    draggedTaskId = this.dataset.id;
    e.dataTransfer.effectAllowed = 'move';
    setTimeout(() => this.style.opacity = '0.5', 0);
}

function setupDragAndDrop() {
    const columns = [elements.listInProgress, elements.listDone];

    columns.forEach(col => {
        col.parentElement.addEventListener('dragover', e => {
            if (state.role !== 'admin') return; // Disable drag for guests
            e.preventDefault(); // Allow drop
            e.dataTransfer.dropEffect = 'move';
        });

        col.parentElement.addEventListener('drop', e => {
            if (state.role !== 'admin') return; // Disable drop for guests
            e.preventDefault();
            const status = col.parentElement.dataset.status;

            if (status === 'done') {
                const task = state.tasks.find(t => t.id === draggedTaskId);
                if (task && !task.assigneeCompleted) {
                    alert('Исполнитель должен отметить задачу как выполненную перед перемещением в "Готово"!');
                    return;
                }
            }

            if (draggedTaskId) {
                updateTaskStatus(draggedTaskId, status);
            }
        });

        col.parentElement.addEventListener('dragend', (e) => {
            // Reset opacity
            const card = document.querySelector(`.task-card[data-id="${draggedTaskId}"]`);
            if (card) card.style.opacity = '1';
            draggedTaskId = null;
        });
    });
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
        elements.projectForm.reset();
        elements.projectModal.classList.add('active');
    });

    elements.addTaskBtn.addEventListener('click', () => {
        elements.taskForm.reset();
        document.getElementById('t-id').value = ''; // Clear ID for new task
        elements.taskModal.querySelector('h2').textContent = 'Новая задача'; // Reset title
        // Set default date to today
        document.getElementById('t-deadline').valueAsDate = new Date();
        populateAssigneeDropdown();
        elements.taskModal.classList.add('active');
    });

    // Help button
    elements.helpBtn.addEventListener('click', () => {
        elements.helpModal.classList.add('active');
    });

    elements.closeModalBtns.forEach(btn => {
        btn.addEventListener('click', () => {
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
        });
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

    async function createTask(title, assignee, deadline, status, assigneeEmail, description) {
        if (state.role !== 'admin') return;
        if (!state.activeProjectId) return;

        // Show loading state on button
        const submitBtn = elements.taskForm.querySelector('button[type="submit"]');
        const originalText = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = 'Сохранение...';

        try {
            await db.collection('tasks').add({
                projectId: state.activeProjectId,
                title,
                description: description || '',
                assignee: assignee || 'Не назначен',
                assigneeEmail: assigneeEmail || '',
                deadline,
                status,
                assigneeCompleted: false,
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
        } catch (error) {
            console.error("Error creating task:", error);
            alert("❌ Ошибка при создании задачи:\n\n" + error.message);
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    }

    // ... (rest of functions) ...

    // Event Listeners
    // ...
    elements.taskForm.addEventListener('submit', (e) => {
        e.preventDefault();
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
            // Update existing task
            updateTask(taskId, {
                title,
                description,
                assignee,
                assigneeEmail,
                deadline
                // We don't update status here as it's handled by drag and drop
            });
        } else {
            // Create new task
            createTask(title, assignee, deadline, status, assigneeEmail, description);
        }
    });

    setupDragAndDrop();

    elements.themeToggle.addEventListener('click', toggleTheme);

    // Auth - Login/Register toggle
    document.getElementById('show-register').addEventListener('click', (e) => {
        e.preventDefault();
        elements.loginForm.style.display = 'none';
        elements.registerForm.style.display = 'block';
        document.getElementById('auth-title').textContent = 'Регистрация';
        document.getElementById('auth-subtitle').textContent = 'Создайте новый аккаунт';
    });

    document.getElementById('show-login').addEventListener('click', (e) => {
        e.preventDefault();
        elements.registerForm.style.display = 'none';
        elements.loginForm.style.display = 'block';
        document.getElementById('auth-title').textContent = 'Вход в систему';
        document.getElementById('auth-subtitle').textContent = 'Войдите или зарегистрируйтесь';
    });

    // Login form
    elements.loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const email = document.getElementById('login-email').value;
        const password = document.getElementById('login-password').value;

        try {
            await auth.signInWithEmailAndPassword(email, password);
            elements.loginError.style.display = 'none';
        } catch (error) {
            elements.loginError.textContent = getAuthErrorMessage(error.code);
            elements.loginError.style.display = 'block';
        }
    });

    // Register form
    elements.registerForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const firstName = document.getElementById('register-first-name').value.trim();
        const lastName = document.getElementById('register-last-name').value.trim();
        const email = document.getElementById('register-email').value;
        const password = document.getElementById('register-password').value;
        const confirmPassword = document.getElementById('register-password-confirm').value;

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

        try {
            const userCredential = await auth.createUserWithEmailAndPassword(email, password);

            // Save user profile to Firestore
            await db.collection('users').doc(userCredential.user.uid).set({
                email: email,
                firstName: firstName,
                lastName: lastName,
                allowedProjects: [], // Empty means access to all projects
                createdAt: firebase.firestore.FieldValue.serverTimestamp()
            });

            elements.registerError.style.display = 'none';
            // User will be automatically signed in, onAuthStateChanged will handle the rest
        } catch (error) {
            elements.registerError.textContent = getAuthErrorMessage(error.code);
            elements.registerError.style.display = 'block';
        }
    });

    // Role selection
    document.getElementById('select-reader-btn').addEventListener('click', () => {
        selectRole('reader');
    });

    document.getElementById('select-admin-btn').addEventListener('click', () => {
        // Show admin password verification
        elements.roleScreen.style.display = 'none';
        elements.adminVerifyScreen.style.display = 'block';
        document.getElementById('admin-verify-password').value = '';
        elements.adminVerifyError.style.display = 'none';
    });

    // Admin password verification
    document.getElementById('admin-verify-submit').addEventListener('click', () => {
        const password = document.getElementById('admin-verify-password').value;
        if (password === '301098') {
            selectRole('admin');
        } else {
            elements.adminVerifyError.style.display = 'block';
        }
    });

    document.getElementById('admin-verify-cancel').addEventListener('click', () => {
        elements.adminVerifyScreen.style.display = 'none';
        elements.roleScreen.style.display = 'block';
    });

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
        logoutBtn.addEventListener('click', logout);
    }

    // Mobile Menu
    elements.mobileMenuBtn.addEventListener('click', () => {
        elements.sidebar.classList.add('active');
        elements.sidebarOverlay.classList.add('active');
    });

    // Close sidebar when clicking overlay
    elements.sidebarOverlay.addEventListener('click', () => {
        elements.sidebar.classList.remove('active');
        elements.sidebarOverlay.classList.remove('active');
    });

    // Admin Panel
    if (elements.adminPanelBtn) {
        elements.adminPanelBtn.addEventListener('click', () => {
            elements.adminPanelModal.classList.add('active');
        });
    }

    // Admin Panel Tabs
    document.querySelectorAll('.admin-tab').forEach(tab => {
        tab.addEventListener('click', () => {
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
        elements.saveAccessBtn.addEventListener('click', saveUserAccess);
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
        role: null
    };

    // Fetch user profile to get name
    try {
        const userDoc = await db.collection('users').doc(user.uid).get();
        if (userDoc.exists) {
            const userData = userDoc.data();
            state.currentUser.firstName = userData.firstName;
            state.currentUser.lastName = userData.lastName;
            state.currentUser.fullName = `${userData.firstName} ${userData.lastName}`.trim();
        }
    } catch (e) {
        console.error("Error fetching user profile", e);
    }

    // Always show role selection - don't auto-login with saved role
    // User must choose and verify role each time
    showRoleSelection(user.email);
}

async function selectRole(role) {
    if (!state.currentUser) return;

    // Set role in current session
    state.currentUser.role = role;
    state.role = role;

    // Save role to Firestore for persistence
    try {
        await db.collection('users').doc(state.currentUser.uid).set({
            email: state.currentUser.email,
            role: role,
            lastLogin: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
    } catch (error) {
        console.error('Error saving user role:', error);
    }

    hideAuthScreen();

    if (role === 'reader') {
        document.body.classList.add('read-only');
    } else {
        document.body.classList.remove('read-only');
    }

    // Setup admin panel if admin
    setupAdminPanel();

    if (state.projects.length > 0 && !state.activeProjectId) {
        selectProject(state.projects[0].id);
    }
}

function showAuthScreen() {
    const loader = document.getElementById('loading-overlay');
    if (loader) loader.classList.add('hidden');

    elements.authOverlay.style.display = 'flex';
    elements.authScreen.style.display = 'block';
    elements.roleScreen.style.display = 'none';
    elements.adminVerifyScreen.style.display = 'none';
}

function showRoleSelection(email) {
    const loader = document.getElementById('loading-overlay');
    if (loader) loader.classList.add('hidden');

    elements.authOverlay.style.display = 'flex';
    elements.authScreen.style.display = 'none';
    elements.roleScreen.style.display = 'block';
    elements.adminVerifyScreen.style.display = 'none';
    elements.userEmailDisplay.textContent = email;
}

function hideAuthScreen() {
    elements.authOverlay.style.display = 'none';
}

async function logout() {
    try {
        await auth.signOut();
        state.activeProjectId = null;
        document.body.classList.remove('read-only');
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

// Touch Drag and Drop for Mobile
let touchDragState = {
    isDragging: false,
    draggedElement: null,
    clone: null
};

function setupTouchDragAndDrop(taskCard) {
    let longPressTimer = null;
    let startY = 0;

    taskCard.addEventListener('touchstart', (e) => {
        if (state.role !== 'admin') return;

        const touch = e.touches[0];
        startY = touch.clientY;
        touchDragState.draggedElement = taskCard;

        // Long press to start dragging
        longPressTimer = setTimeout(() => {
            startTouchDrag(taskCard, touch);
        }, 300);
    }, { passive: true });

    taskCard.addEventListener('touchmove', (e) => {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }

        if (touchDragState.isDragging && touchDragState.draggedElement === taskCard) {
            e.preventDefault();
            const touch = e.touches[0];

            if (touchDragState.clone) {
                touchDragState.clone.style.left = touch.clientX - 50 + 'px';
                touchDragState.clone.style.top = touch.clientY - 50 + 'px';
            }
        }
    });

    taskCard.addEventListener('touchend', (e) => {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
            longPressTimer = null;
        }

        if (touchDragState.isDragging && touchDragState.draggedElement === taskCard) {
            endTouchDrag(e.changedTouches[0]);
        }
    }, { passive: true });

    taskCard.addEventListener('touchcancel', () => {
        if (longPressTimer) {
            clearTimeout(longPressTimer);
        }
        if (touchDragState.isDragging) {
            cancelTouchDrag();
        }
    }, { passive: true });
}

function startTouchDrag(element, touch) {
    touchDragState.isDragging = true;

    // Create visual clone
    const clone = element.cloneNode(true);
    clone.style.position = 'fixed';
    clone.style.left = touch.clientX - 50 + 'px';
    clone.style.top = touch.clientY - 50 + 'px';
    clone.style.width = element.offsetWidth + 'px';
    clone.style.opacity = '0.8';
    clone.style.zIndex = '10000';
    clone.style.pointerEvents = 'none';
    clone.style.transform = 'scale(1.05)';

    document.body.appendChild(clone);
    touchDragState.clone = clone;
    element.style.opacity = '0.3';

    // Haptic feedback
    if (navigator.vibrate) {
        navigator.vibrate(50);
    }
}

function endTouchDrag(touch) {
    const x = touch.clientX;
    const y = touch.clientY;

    // Find which column we're over
    const columns = document.querySelectorAll('.column');
    let targetColumn = null;

    columns.forEach(col => {
        const rect = col.getBoundingClientRect();
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
            targetColumn = col;
        }
    });

    if (targetColumn && touchDragState.draggedElement) {
        const newStatus = targetColumn.dataset.status;
        const taskId = touchDragState.draggedElement.dataset.id;
        updateTaskStatus(taskId, newStatus);

        if (navigator.vibrate) {
            navigator.vibrate(30);
        }
    }

    cancelTouchDrag();
}

function cancelTouchDrag() {
    if (touchDragState.clone) {
        touchDragState.clone.remove();
    }

    if (touchDragState.draggedElement) {
        touchDragState.draggedElement.style.opacity = '1';
    }

    touchDragState.isDragging = false;
    touchDragState.draggedElement = null;
    touchDragState.clone = null;
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
            deleteBtn.addEventListener('click', () => deleteUser(user.id, fullName));
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
