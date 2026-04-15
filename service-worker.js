const CACHE_NAME = "pdf-mask-app-v24";

const ASSETS = [
  "/pdf-mask-app/",
  "/pdf-mask-app/index.html",
  "/pdf-mask-app/style.css?v=24",
  "/pdf-mask-app/app.js?v=24",
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
          return Promise.resolve();
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const req = event.request;

  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // HTMLナビゲーションは network-first
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put("/pdf-mask-app/index.html", copy);
          });
          return response;
        })
        .catch(() => caches.match("/pdf-mask-app/index.html"))
    );
    return;
  }

  // バージョン付き静的ファイル
  if (
    url.pathname.startsWith("/pdf-mask-app/style.css") ||
    url.pathname.startsWith("/pdf-mask-app/app.js") ||
    url.pathname.startsWith("/pdf-mask-app/pdf.mjs") ||
    url.pathname.startsWith("/pdf-mask-app/pdf.worker.mjs") ||
    url.pathname.startsWith("/pdf-mask-app/manifest.json")
  ) {
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
    return;
  }

  // その他は network-first fallback
  event.respondWith(
    fetch(req).catch(() => caches.match(req))
  );
});