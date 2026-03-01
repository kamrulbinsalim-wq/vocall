// ============================================================
// VoCall — Main Service Worker (sw.js)
// GitHub Pages: https://kamrulbinsalim-wq.github.io/vocall/
// ============================================================

importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

// ── Base Path (GitHub Pages repo name) ────────────────────
const BASE = '/vocall';

// ── Cache ──────────────────────────────────────────────────
const CACHE = 'vocall-v3';
const CACHE_FILES = [
  BASE + '/index.html',
  BASE + '/manifest.json',
  BASE + '/sw.js',
  BASE + '/firebase-messaging-sw.js',
  BASE + '/icon-192.png',
  BASE + '/icon-512.png'
];

// ── Firebase Init ──────────────────────────────────────────
firebase.initializeApp({
  apiKey: "AIzaSyAMCmZBxZoha4gWB5elP0p3qz1LHjTXo9s",
  authDomain: "infobooks-4358d.firebaseapp.com",
  projectId: "infobooks-4358d",
  storageBucket: "infobooks-4358d.firebasestorage.app",
  messagingSenderId: "938954145740",
  appId: "1:938954145740:web:ee2a334f8f0e621f552769"
});

const messaging = firebase.messaging();

// ── Install ────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(CACHE_FILES))
  );
  self.skipWaiting();
});

// ── Activate ───────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch (Cache-first) ────────────────────────────────────
self.addEventListener('fetch', e => {
  if (e.request.url.includes('googleapis') || e.request.url.includes('gstatic')) {
    return;
  }
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match(BASE + '/index.html')))
  );
});

// ── Background Message (অ্যাপ বন্ধ থাকলে) ─────────────────
messaging.onBackgroundMessage(payload => {
  const callId = payload.data?.callId;
  const title  = payload.notification?.title || 'ইনকামিং কল 📞';
  const body   = payload.notification?.body  || 'কেউ কল করছে';

  return self.registration.showNotification(title, {
    body,
    icon:     BASE + '/icon-192.png',
    badge:    BASE + '/icon-192.png',
    vibrate:  [300, 100, 300, 100, 300],
    tag:      callId || 'vocall-notif',
    renotify: true,
    data:     { callId },
    actions: [
      { action: 'accept',  title: '📞 রিসিভ করুন' },
      { action: 'decline', title: '📵 রিজেক্ট করুন' }
    ]
  });
});

// ── Notification Click ─────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const callId = e.notification.data?.callId;

  if (e.action === 'accept' && callId) {
    const targetUrl = BASE + '/index.html?callId=' + callId + '&action=accept';

    e.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wcs => {
        const existing = wcs.find(w => w.url.includes('/vocall'));
        if (existing) {
          existing.postMessage({ type: 'notification-click', callId, action: 'accept' });
          existing.focus();
          return existing.navigate(targetUrl);
        }
        return clients.openWindow(targetUrl);
      })
    );

  } else if (e.action === 'decline' && callId) {
    e.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wcs => {
        if (wcs.length > 0) {
          wcs[0].postMessage({ type: 'call-dismissed', callId });
        }
      })
    );

  } else {
    e.waitUntil(
      clients.matchAll({ type: 'window', includeUncontrolled: true }).then(wcs => {
        if (wcs.length > 0) return wcs[0].focus();
        return clients.openWindow(BASE + '/index.html');
      })
    );
  }
});
