const CACHE_NAME = 'dflai-shell-v1';
const SHELL_URLS = [
  '/dragonflai-v2.html',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_URLS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Solo intervenimos peticiones GET del mismo origen. Todo lo demás
  // (Supabase, Stripe, el Worker de IA, fuentes de Google) va directo a
  // la red sin pasar por el service worker — nunca queremos servir una
  // respuesta vieja/cacheada de un endpoint que genera datos en vivo.
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() => cached || caches.match('/dragonflai-v2.html'));
      // Cache-first para respuesta instantánea; se actualiza en segundo plano.
      return cached || network;
    })
  );
});
