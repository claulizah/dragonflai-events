// ══════════════════════════════════════════════════════════════
//  DragonflAI Events — Service Worker (PWA)
//
//  Estrategia:
//  - HTML / navegación → RED PRIMERO. Así cada deploy llega de inmediato
//    a todos; el caché solo entra si no hay internet. (La versión anterior
//    era caché-primero y la gente se quedaba viendo HTML viejo después de
//    cada actualización.)
//  - Íconos y assets estáticos → caché primero, refresco en segundo plano.
//  - Todo lo que no sea GET del mismo origen (Supabase, Stripe, Worker de
//    IA, fuentes) va directo a la red, sin tocar el caché.
// ══════════════════════════════════════════════════════════════

const CACHE_NAME = 'dflai-shell-v2';
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
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) {
    return;
  }

  const isHTML = request.mode === 'navigate' ||
    (request.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    // RED PRIMERO: siempre la versión más nueva; caché solo sin conexión.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match('/dragonflai-v2.html'))
        )
    );
    return;
  }

  // Assets: caché primero para respuesta instantánea, refresco en fondo.
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
        .catch(() => cached);
      return cached || network;
    })
  );
});
