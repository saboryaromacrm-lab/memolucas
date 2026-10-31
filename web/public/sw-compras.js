// Service worker del panel de compras: hace la app instalable y abre aunque no haya señal.
// Los datos (/api) siempre van a la red; las fotos sin subir las guarda la página (IndexedDB).
const CACHE = "compras-coffit-v1";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/"])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api") || url.pathname === "/health") return;
  // Red primero; si no hay conexión, lo guardado.
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && (url.pathname.startsWith("/assets/") || e.request.mode === "navigate")) {
          const copia = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request.mode === "navigate" ? "/" : e.request, copia));
        }
        return r;
      })
      .catch(() => caches.match(e.request.mode === "navigate" ? "/" : e.request).then((r) => r || Response.error())),
  );
});
