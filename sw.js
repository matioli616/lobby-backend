'use strict';

var CACHE_NAME   = 'lobby-cleaning-v1';
var STATIC_FILES = [
  '/cleaning-app.html',
  '/manifest.json'
];

/* ── INSTALL: pre-cache static assets ──────────── */
self.addEventListener('install', function (event) {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(STATIC_FILES);
    })
  );
});

/* ── ACTIVATE: remove old caches ───────────────── */
self.addEventListener('activate', function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (k) { return k !== CACHE_NAME; })
          .map(function (k) { return caches.delete(k); })
      );
    }).then(function () {
      return self.clients.claim();
    })
  );
});

/* ── FETCH ──────────────────────────────────────── */
self.addEventListener('fetch', function (event) {
  var req = event.request;
  var url = new URL(req.url);

  /* API calls → network-first, never cache */
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(req).catch(function () {
        return new Response(
          JSON.stringify({ error: 'Sem conexão', offline: true }),
          {
            status: 503,
            headers: { 'Content-Type': 'application/json' }
          }
        );
      })
    );
    return;
  }

  /* Static assets → cache-first, then network + update cache */
  event.respondWith(
    caches.match(req).then(function (cached) {
      if (cached) return cached;

      return fetch(req).then(function (response) {
        if (response && response.ok) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(req, clone);
          });
        }
        return response;
      }).catch(function () {
        /* Offline fallback for navigation requests */
        if (req.mode === 'navigate') {
          return caches.match('/cleaning-app.html');
        }
        return new Response('', { status: 503 });
      });
    })
  );
});
