/**
 * BIST Terminal — Service Worker
 *
 * Strategy:
 *   · Pre-cache all same-origin static assets on install (shell + JS + CSS + data)
 *   · Cache-first for same-origin requests → instant loads after first visit
 *   · Network-first for CDN resources (LightweightCharts, Google Fonts)
 *   · Network-only for data proxy calls (Yahoo Finance) so prices are always fresh
 *   · Old cache versions are purged on activate
 */

const CACHE  = 'bist-terminal-v4';
const STATIC = [
  './analysis.html',
  './manifest.json',
  './icon.svg',
  './icon-maskable.svg',
  './data/bist-tickers.json',
  './assets/css/analysis.css',
  './assets/js/api.js',
  './assets/js/indicators.js',
  './assets/js/chart.js',
  './assets/js/cache.js',
  './assets/js/watchlist.js',
  './assets/js/tools.js',
  './assets/js/app.js',
];

// Hosts whose requests must always hit the network
const NETWORK_ONLY_HOSTS = [
  'query1.finance.yahoo.com',
  'query2.finance.yahoo.com',
  'corsproxy.io',
  'api.allorigins.win',
  'api.codetabs.com',
];

// ── Install: pre-cache shell ────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(STATIC))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: purge stale caches ────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ───────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch { return; }

  // Network-only: live data proxy endpoints
  if (NETWORK_ONLY_HOSTS.some(h => url.hostname.includes(h))) {
    event.respondWith(fetch(request));
    return;
  }

  // Network-first: CDN & Google Fonts (need fresh versions, but fall back offline)
  if (url.hostname !== self.location.hostname) {
    event.respondWith(
      fetch(request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(request, clone));
          }
          return res;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first: same-origin assets
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(request, clone));
        }
        return res;
      });
    })
  );
});
