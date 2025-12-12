const CACHE_NAME = 'projectman-v57';
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

// Fetch event - NETWORK FIRST for all app files to ensure fresh content
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  // Skip caching for external APIs (Cloudinary, Firebase, etc.) and non-GET requests
  const skipDomains = ['cloudinary.com', 'cloudinary', 'firebaseio.com', 'googleapis.com', 'firebase', 'emailjs.com', 'res.cloudinary.com', 'api.cloudinary.com'];
  const shouldSkip = skipDomains.some(domain => url.hostname.includes(domain)) || event.request.method !== 'GET';
  
  if (shouldSkip) {
    // Don't intercept - let browser handle it directly
    return;
  }

  // Network first strategy for ALL requests - always try to get fresh content
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // Got fresh response - update cache and return it
        if (networkResponse && networkResponse.status === 200) {
                const responseToCache = networkResponse.clone();
                caches.open(CACHE_NAME).then((cache) => {
                    cache.put(event.request, responseToCache);
                });
            }
            return networkResponse;
      })
      .catch(() => {
        // Network failed - try cache as fallback (offline mode)
        return caches.match(event.request).then((cachedResponse) => {
          if (cachedResponse) {
            return cachedResponse;
          }
          // For navigation, return index.html as fallback
          if (event.request.mode === 'navigate') {
            return caches.match('./index.html');
          }
          return new Response('Offline', { status: 503 });
        });
    })
  );
});

