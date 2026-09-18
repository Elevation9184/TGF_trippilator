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

const CACHE = "tgo-20260918-2055";
const ASSETS = [
  "./",
  "./index.html",
  "./help.html",
  "./style.css",
  "./app.js",
  "./engine.js",
  "./notes.js",
  "./map.js",
  "./maplogic.js",
  "./preselect.js",
  "./editor.js",
  "./opening.js",
  "./position.js",
  "./handoff.js",
  "./testmode.js",
  "./nearby.js",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
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
  // Only our own old copies. Every GitHub Pages project of one account shares
  // an origin, and so a cache list: anything else in it belongs to another site.
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key.startsWith("tgo-") && key !== CACHE).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    // Opening the app with ?tm=y is the same page: match it without the query.
    caches.match(request, { ignoreSearch: request.mode === "navigate" }).then(
      (cached) =>
        cached ||
        fetch(request)
          .then((response) => {
            // A 404 kept offline would be served until the next publish.
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy));
            }
            return response;
          })
          // Offline and never cached: fall back to the shell so the app still opens.
          .catch(() => caches.match("./index.html"))
    )
  );
});
