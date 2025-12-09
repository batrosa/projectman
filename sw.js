const CACHE_NAME = 'projectman-v45';
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
  const url = new URL(event.request.url);
  
  // Skip caching for external APIs (Cloudinary, Firebase, etc.) and non-GET requests
  const skipDomains = ['cloudinary.com', 'cloudinary', 'firebaseio.com', 'googleapis.com', 'firebase', 'emailjs.com', 'res.cloudinary.com', 'api.cloudinary.com'];
  const shouldSkip = skipDomains.some(domain => url.hostname.includes(domain)) || event.request.method !== 'GET';
  
  if (shouldSkip) {
    // Don't intercept - let browser handle it directly
    return;
  }

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
            // Network failed, return cached or nothing
            return cachedResponse;
        });

        return cachedResponse || fetchPromise;
    })
  );
});

