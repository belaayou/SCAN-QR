// =====================================================================
// SCAN MGV APP - Service Worker (hors ligne)
// Rôle : rendre l'APPLICATION (coque + librairies) disponible sans réseau.
// Ne touche JAMAIS à Supabase (REST, Auth, Realtime) : aucune donnée métier en cache.
// =====================================================================
const CACHE_NAME = 'scan-mgv-app-v6';        // <- incrémenter (v2, v3...) à chaque publication
const RUNTIME_CACHE = 'scan-mgv-runtime-v1'; // polices Google + copies CDN
const OWN_CACHES = [CACHE_NAME, RUNTIME_CACHE];

const abs = (p) => new URL(p, self.location).href;

// Coque de l'application (chemins relatifs => compatible GitHub Pages en sous-dossier)
const CORE = ['./', './index.html', './manifest.json', './IMG_20260413_130653.png'];

// Librairies : copie locale (vendor/) en priorité, CDN en secours.
// Si le fichier local est absent du dépôt, le SW met en cache la version CDN sous l'URL locale.
const VENDOR = {
  'vendor/html5-qrcode.min.js': 'https://unpkg.com/html5-qrcode',
  'vendor/supabase.min.js': 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
};
const CDN_URLS = Object.values(VENDOR);

async function cacheVendor(cache, local, cdn) {
  const key = abs(local);
  try {
    const r = await fetch(key, { cache: 'reload' });
    if (r && r.ok && !/text\/html/i.test(r.headers.get('content-type') || '')) {
      await cache.put(key, r.clone());
      return;
    }
  } catch (e) { /* on tente le CDN */ }
  try {
    const r = await fetch(cdn, { mode: 'cors' });
    if (r && r.ok) await cache.put(key, r.clone());
  } catch (e) { console.warn('[SW] Librairie non pré-cachée :', local); }
}

// ---------------------------------------------------------------------
// INSTALL
// ---------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.allSettled(CORE.map((u) => cache.add(new Request(u, { cache: 'reload' }))));
    if (!(await cache.match(abs('./index.html'))) && !(await cache.match(abs('./')))) {
      throw new Error('index.html non mis en cache'); // l'installation sera retentée
    }
    for (const [local, cdn] of Object.entries(VENDOR)) await cacheVendor(cache, local, cdn);
    await self.skipWaiting();
  })());
});

// ---------------------------------------------------------------------
// ACTIVATE : suppression des anciens caches + prise de contrôle (sans recharger les pages)
// ---------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('scan-mgv-') && !OWN_CACHES.includes(k)).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

// ---------------------------------------------------------------------
// FETCH
// ---------------------------------------------------------------------
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function putIfOk(cacheName, req, res) {
  if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
    try { const c = await caches.open(cacheName); await c.put(req, res.clone()); } catch (e) {}
  }
  return res;
}

// Navigation : réseau d'abord (nouvelle version dès qu'Internet est là), cache sinon.
async function handleNavigate(req) {
  try {
    const net = await withTimeout(fetch(req), 4000);
    if (net && net.ok) await putIfOk(CACHE_NAME, abs('./index.html'), net);
    return net;
  } catch (e) {
    const cached = (await caches.match(abs('./index.html'), { ignoreSearch: true }))
                || (await caches.match(abs('./'), { ignoreSearch: true }));
    return cached || new Response('Hors ligne : ouvrez l\'application une fois avec Internet.',
      { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}

// Cache d'abord, réseau en rattrapage
async function cacheFirst(req, cacheName) {
  const hit = await caches.match(req, { ignoreSearch: false });
  if (hit) return hit;
  try { return await putIfOk(cacheName, req, await fetch(req)); }
  catch (e) { return new Response('', { status: 504 }); }
}

// Cache immédiat + mise à jour en arrière-plan
async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  const update = fetch(req).then((res) => putIfOk(cacheName, req, res)).catch(() => null);
  if (hit) { update.catch(() => {}); return hit; }
  const net = await update;
  return net || new Response('', { status: 504 });
}

// vendor/* : cache, puis local, puis CDN de secours
async function handleVendor(req, url) {
  const hit = await caches.match(req);
  if (hit) return hit;
  try {
    const r = await fetch(req);
    if (r && r.ok && !/text\/html/i.test(r.headers.get('content-type') || '')) return await putIfOk(CACHE_NAME, req, r);
  } catch (e) {}
  const name = Object.keys(VENDOR).find((k) => url.pathname.endsWith('/' + k));
  if (name) {
    try { const r = await fetch(VENDOR[name], { mode: 'cors' }); if (r && r.ok) return await putIfOk(CACHE_NAME, req, r); }
    catch (e) {}
  }
  return new Response('', { status: 504 });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return; // INSERT/UPDATE/POST : jamais interceptés
  const url = new URL(req.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Supabase (REST, Auth, Realtime, Storage) : JAMAIS en cache, JAMAIS interceptés
  if (/(^|\.)supabase\.(co|in|net)$/i.test(url.hostname)) return;

  if (req.mode === 'navigate') { event.respondWith(handleNavigate(req)); return; }

  if (url.origin === self.location.origin) {
    if (url.pathname.includes('/vendor/')) { event.respondWith(handleVendor(req, url)); return; }
    if (url.pathname.endsWith('/service-worker.js')) return;
    event.respondWith(staleWhileRevalidate(req, CACHE_NAME));
    return;
  }

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }

  if (CDN_URLS.some((u) => req.url === u || req.url.startsWith(u))) {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE));
    return;
  }
  // tout le reste : comportement réseau normal
});
