const CACHE_NAME = "pdf-mask-app-v32";

const ASSETS = [
  "./",
  "./index.html",
  "./style.css?v=32",
  "./app.js?v=32",
  "./manifest.json",
  "./pdf.mjs",
  "./pdf.worker.mjs",
  "./src/app-core.js",
  "./src/db.js",
  "./src/utils.js"
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
            cache.put("./index.html", copy);
          });
          return response;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // バージョン付き静的ファイル
  if (
    url.pathname.endsWith("/style.css") ||
    url.pathname.endsWith("/app.js") ||
    url.pathname.endsWith("/pdf.mjs") ||
    url.pathname.endsWith("/pdf.worker.mjs") ||
    url.pathname.endsWith("/manifest.json")
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
