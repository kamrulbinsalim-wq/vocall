// sw.js — Combined PWA Cache Worker + FCM Background Messaging

// ══════════════════════════════════════════
// SECTION 1: PWA CACHE
// ══════════════════════════════════════════
const CACHE_NAME = 'vocall-v1';
const BASE = 'https://kamrulbinsalim.github.io';
const STATIC_ASSETS = [
  BASE + '/',
  BASE + '/index.html',
  BASE + '/app.css',
  BASE + '/app.js',
  BASE + '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  if (
    request.url.includes('firebaseio.com') ||
    request.url.includes('googleapis.com') ||
    request.url.includes('gstatic.com')
  ) return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(response => {
        if (!response || response.status !== 200 || response.type !== 'basic') return response;
        const clone = response.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        return response;
      }).catch(() => {
        if (request.destination === 'document') return caches.match('https://kamrulbinsalim.github.io/index.html');
      });
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

// ══════════════════════════════════════════
// SECTION 2: FCM BACKGROUND NOTIFICATIONS
// ══════════════════════════════════════════

// We can't use importScripts for FCM compat in a combined SW on GitHub Pages,
// so we handle push events natively using the Push API directly.

self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data?.json() || {}; } catch { payload = {}; }

  const data        = payload.data || payload.notification || {};
  const title       = data.title || 'VoCall';
  const body        = data.body  || 'You have a new notification';
  const isCall      = data.type  === 'call';

  const options = {
    body,
    icon:             'https://api.dicebear.com/7.x/shapes/svg?seed=vocall',
    badge:            'https://api.dicebear.com/7.x/shapes/svg?seed=badge',
    vibrate:          [200, 100, 200, 100, 200],
    tag:              isCall ? 'incoming-call' : 'new-message',
    requireInteraction: isCall,
    data,
    actions: isCall ? [
      { action: 'answer',  title: '📞 Answer'  },
      { action: 'decline', title: '❌ Decline' },
    ] : [
      { action: 'open', title: '💬 Open' },
    ],
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data   = event.notification.data || {};
  const action = event.action;

  if (action === 'decline') return;

  const url = action === 'answer'
    ? `https://kamrulbinsalim.github.io/?incoming=call&caller=${data.callerId || ''}`
    : 'https://kamrulbinsalim.github.io/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.postMessage({ type: 'NOTIFICATION_CLICK', data, action });
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});
