const CACHE_NAME = "pdf-mask-app-v7";

const ASSETS = [
  "/pdf-mask-app/",
  "/pdf-mask-app/index.html",
  "/pdf-mask-app/style.css",
  "/pdf-mask-app/app.js",
  "/pdf-mask-app/manifest.json",
  "/pdf-mask-app/pdf.mjs",
  "/pdf-mask-app/pdf.worker.mjs"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  if (req.method !== "GET") return;

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;

      return fetch(req).then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(req, copy);
        });
        return response;
      });
    })
  );
});