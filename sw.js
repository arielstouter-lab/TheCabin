// Lives at the site ROOT so its scope covers every page.
const CACHE_NAME = 'thecabin-v9';
const NAV_TIMEOUT_MS = 3500;

const STATIC_ASSETS = [
    './',
    'index.html',
    'login.html',
    'login.js',
    'app.html',
    'app.js',
    'calendar.html',
    'calendar.js',
    'chores.html',
    'chores.js',
    'moving.html',
    'moving.js',
    'weather.html',
    'weather.js',
    'creditcards.html',
    'lists.html',
    'managegroceries.html',
    'settings.html',
    'styles.css',
    'manifest.json',
    'SharedJS/head-loader.js',
    'SharedJS/config.js',
    'SharedJS/dom.js',
    'SharedJS/sync.js',
    'SharedJS/settings.js',
    'SharedJS/summary-card.js',
    'SharedJS/speech-to-text.js',
    'Financial/category-row.js',
    'Financial/creditcards.js',
    'Financial/debt-engine-v2.js',
    'Financial/debts.js',
    'Lists/lists.js',
    'Lists/lists-panel.js',
    'Lists/lists-pantry.js',
    'Lists/lists-recipes.js',
    'Lists/lists-state.js',
    'Lists/managegroceries.js',
    'Images/pinecone.png',
    'Images/spring.jpg',
    'Images/summer.jpg',
    'Images/fall.jpg',
    'Images/winter.jpg'
];

// Third-party files every page needs. supabase-js is a blocking <script> in
// <head>, and the Google Fonts stylesheet is render-blocking: if either hangs
// on a weak connection the page never paints.
const CDN_ASSETS = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];
const CDN_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com'];

function stripSearch(urlString) {
    const u = new URL(urlString);
    u.search = '';
    return u.toString();
}

// cache.add() rejects opaque (cross-origin, no-cors) responses, so use put().
async function cacheCdnAsset(cache, url) {
    const response = await fetch(new Request(url, { mode: 'no-cors' }));
    await cache.put(url, response);
}

self.addEventListener('install', (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);

        // addAll() is all-or-nothing: one missing file aborts the whole install.
        // Add each file on its own and report what failed instead.
        const jobs = [
            ...STATIC_ASSETS.map((url) => ({ url, run: () => cache.add(url) })),
            ...CDN_ASSETS.map((url) => ({ url, run: () => cacheCdnAsset(cache, url) }))
        ];
        const results = await Promise.allSettled(jobs.map((j) => j.run()));
        results.forEach((r, i) => {
            if (r.status === 'rejected') console.warn('SW precache failed:', jobs[i].url, r.reason);
        });

        await self.skipWaiting();
    })());
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

// Pages: the cached copy is used if the network fails or takes longer than
// NAV_TIMEOUT_MS (a weak signal often hangs instead of failing). The network
// response still finishes in the background and refreshes the cache.
async function handleNavigate(event) {
    const req = event.request;
    const cache = await caches.open(CACHE_NAME);
    // Key pages without their query string so managegroceries.html?section=…
    // is served from the one cached managegroceries.html.
    const key = stripSearch(req.url);
    const cached = await cache.match(key, { ignoreSearch: true });

    const network = fetch(req).then((response) => {
        if (response.status === 200) cache.put(key, response.clone());
        return response;
    });
    event.waitUntil(network.catch(() => {}));

    if (!cached) {
        try {
            return await network;
        } catch (e) {
            return (await cache.match('index.html')) || Response.error();
        }
    }

    return Promise.race([
        network,
        new Promise((resolve) => setTimeout(() => resolve(cached), NAV_TIMEOUT_MS))
    ]).catch(() => cached);
}

// Same-origin assets: serve cache immediately, refresh in the background.
async function staleWhileRevalidate(event) {
    const req = event.request;
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });

    const network = fetch(req).then((response) => {
        if (response && response.status === 200 && response.type === 'basic') {
            cache.put(req, response.clone());
        }
        return response;
    });
    event.waitUntil(network.catch(() => {}));

    if (cached) return cached;
    try {
        return await network;
    } catch (e) {
        return Response.error();
    }
}

// Third-party scripts/fonts: cache-first, and accept opaque responses (a plain
// <script src> or <link rel=stylesheet> without crossorigin comes back opaque).
async function cdnCacheFirst(event) {
    const req = event.request;
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req.url);
    if (cached) return cached;

    try {
        const response = await fetch(req);
        if (response && (response.ok || response.type === 'opaque')) {
            cache.put(req.url, response.clone());
        }
        return response;
    } catch (e) {
        return Response.error();
    }
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    const url = new URL(req.url);

    // Bypass API calls, Supabase endpoints, and non-GET requests
    if (req.method !== 'GET' || url.hostname.includes('supabase.co') || url.pathname.includes('/rest/v1/') || url.pathname.includes('/auth/v1/')) {
        return;
    }

    if (url.origin !== self.location.origin) {
        if (CDN_HOSTS.includes(url.hostname)) event.respondWith(cdnCacheFirst(event));
        return;
    }

    if (req.mode === 'navigate') {
        event.respondWith(handleNavigate(event));
        return;
    }

    event.respondWith(staleWhileRevalidate(event));
});