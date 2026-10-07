const CACHE_NAME = 'thecabin-v6';
const STATIC_ASSETS = [
  '../',
  '../index.html',
  '../app.html',
  '../calendar.html',
  '../chores.html',
  '../creditcards.html',
  '../lists.html',
  '../login.html',
  '../managegroceries.html',
  '../settings.html',
  '../weather.html',
  '../styles.css',
  '../manifest.json',
  '../app.js',
  '../calendar.js',
  '../chores.js',
  '../login.js',
  '../weather.js',
  'head-loader.js',
  'config.js',
  'dom.js',
  'sync.js',
  'settings.js',
  'summary-card.js',
  '../Financial/category-row.js',
  '../Financial/creditcards.js',
  '../Financial/debt-engine-v2.js',
  '../Financial/debts.js',
  '../Lists/lists.js',
  '../Lists/lists-panel.js',
  '../Lists/lists-pantry.js',
  '../Lists/lists-recipes.js',
  '../Lists/lists-state.js',
  '../Lists/managegroceries.js',
  '../Images/pinecone.png',
  '../Images/spring.jpg',
  '../Images/summer.jpg',
  '../Images/fall.jpg',
  '../Images/winter.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Bypass API calls, Supabase endpoints, and non-GET requests
  if (event.request.method !== 'GET' || url.hostname.includes('supabase.co') || url.pathname.includes('/rest/v1/') || url.pathname.includes('/auth/v1/')) {
    return;
  }

  // Network-first with cache fallback for HTML navigation, Stale-while-revalidate for static assets
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          if (response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match('../index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
