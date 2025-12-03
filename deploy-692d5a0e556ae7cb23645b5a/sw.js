const CACHE_NAME = 'projectman-v9';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './style.css',
  './mobile-additions.css',
  './script.js',
  './libs/firebase-app.js',
  './libs/firebase-firestore.js',
  './libs/firebase-auth.js',
  'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css'
];

// Install event - cache assets
self.addEventListener('install', (event) => {
  // Force waiting service worker to become active immediately
  self.skipWaiting();
  
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  // Claim any clients immediately, so they use this new SW
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            console.log('Deleting old cache:', cacheName);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => self.clients.claim()) // Ensure we control the page immediately
  );
});

// Fetch event - Network first for HTML, Cache first (stale-while-revalidate) for others
self.addEventListener('fetch', (event) => {
  // For navigation requests (HTML pages), try network first to ensure we get the latest version
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .catch(() => {
            return caches.match(event.request) || caches.match('./index.html');
        })
    );
    return;
  }

  // For other requests (CSS, JS, Images), try cache first, but update in background
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
        const fetchPromise = fetch(event.request).then((networkResponse) => {
            // Update cache with new version
            if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
                const responseToCache = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, responseToCache);
                });
            }
            return networkResponse;
        }).catch(() => {
            // Network failed, nothing to do (we have cached response hopefully)
        });

        return cachedResponse || fetchPromise;
    })
  );
});

