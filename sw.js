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

const CACHE = "tgo-20260915-1542";
const ASSETS = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./engine.js",
  "./notes.js",
  "./map.js",
  "./maplogic.js",
  "./preselect.js",
  "./editor.js",
  "./opening.js",
  "./icon.svg",
  "./manifest.webmanifest",
  "./data/bundle.json",
];

self.addEventListener("install", (event) => {
  // Straight from the server, never the browser's own HTTP cache. GitHub Pages
  // lets browsers keep files for ten minutes, and without this a new version
  // could install carrying an old file, then serve it until the next publish.
  const fresh = ASSETS.map((url) => new Request(url, { cache: "reload" }));
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(fresh)));
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
