// PAUSED (Oct 18 2026): kill switch. Replaces the cache-first app shell so every phone that
// installed the scanner drops it and shows the paused notice instead. Restore by reverting
// the "Pause" commit (the old sw.js has a new CACHE_VERSION, so phones pick it back up).
const CACHE_PREFIX = "badge-scanner-";
const OFFLINE_NOTICE =
  '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>Badge Scanner is paused</title>' +
  '<body style="background:#191919;color:#F4F9E9;font-family:Lato,-apple-system,sans-serif;text-align:center;padding:30vh 22px 0">' +
  '<h1 style="font-size:24px;margin-bottom:12px">Badge Scanner is paused</h1>' +
  '<p style="color:#C9CBC0">Booth lead capture with this app is turned off for now.</p></body>';

self.addEventListener("install", (e) => {
  e.waitUntil(self.skipWaiting());
});

// Drop this app's cached shell. Only our own prefix: both scanners and other dashboards
// share the shmil123.github.io origin, so they share Cache Storage.
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(CACHE_PREFIX) && !k.startsWith("badge-scanner-apac-")).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Page loads always go to the network (never the HTTP cache, which could still hold the
// old app for a few minutes); offline they get the inline notice.
self.addEventListener("fetch", (e) => {
  if (e.request.mode !== "navigate") return;
  e.respondWith(
    fetch(e.request, { cache: "no-store" }).catch(
      () => new Response(OFFLINE_NOTICE, { headers: { "Content-Type": "text/html; charset=utf-8" } })
    )
  );
});
