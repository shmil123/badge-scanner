// Cache-first app shell so the scanner works on dead event WiFi.
// Bump CACHE_VERSION whenever any shell file changes — that's the deploy signal.
const CACHE_VERSION = "v6";
const CACHE_NAME = "badge-scanner-" + CACHE_VERSION;
const SHELL = ["./", "index.html", "jsqr.min.js", "manifest.webmanifest", "icon.svg", "fonts/lato-400.woff2", "fonts/lato-700.woff2", "fonts/lato-900.woff2"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return; // POSTs to Apps Script go straight to network
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return; // Apps Script doGet etc.
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(
      (hit) =>
        hit ||
        fetch(e.request).then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((c) => c.put(e.request, copy));
          return resp;
        })
    )
  );
});
