'use strict';

var CACHE_NAME   = 'lobby-cleaning-v2';
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

  /* Static assets → cache-first, then network + update cache (skip chrome-extension) */
  if (!url.protocol.startsWith('http')) return;

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

/* ── PUSH ───────────────────────────────────────── */
self.addEventListener('push', function (event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) {}

  var title   = data.title || 'LOBBY Limpeza';
  var options = {
    body:     data.body  || 'Nova tarefa disponível',
    icon:     '/icon.svg',
    badge:    '/icon.svg',
    tag:      'lobby-task',
    renotify: true,
    data:     { url: data.url || '/cleaning-app.html' },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

/* ── NOTIFICATION CLICK ─────────────────────────── */
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || '/cleaning-app.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].url.includes('cleaning-app') && 'focus' in list[i]) {
          return list[i].focus();
        }
      }
      return clients.openWindow(target);
    })
  );
});
