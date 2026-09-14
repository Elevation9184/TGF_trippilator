/**
 * Offline cache for the field app.
 *
 * Rural Taranaki has patchy coverage, so the app must work with no signal at
 * all. Everything is cached on install and served cache-first; the bundle is
 * static reference data that only changes when it is re-baked, so staleness is
 * bounded by the version below.
 *
 * Bump CACHE when publishing a new bundle. Old caches are removed on activate.
 */

const CACHE = "tgo-20260914-2222";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./engine.js",
  "./notes.js",
  "./map.js",
  "./maplogic.js",
  "./icon.svg",
  "./manifest.webmanifest",
  "./data/bundle.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request)
          .then((response) => {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
            return response;
          })
          // Offline and never cached: fall back to the shell so the app still opens.
          .catch(() => caches.match("./index.html"))
    )
  );
});
