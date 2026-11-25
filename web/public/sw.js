// Service worker mínimo: hace la app instalable y guarda la "cáscara" para abrir rápido.
// Los datos (/api) siempre van a la red. Las páginas se guardan como "/" o, la del Bloc como app, "/app/bloc".
const CACHE = "memolucas-v2";

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(["/", "/icono.svg", "/manifest.webmanifest"])));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

const pagina = (url) => (url.pathname.startsWith("/app/bloc") ? "/app/bloc" : "/");

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api") || url.pathname === "/health") return;
  // Red primero; si no hay conexión, lo guardado.
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r.ok && (url.pathname.startsWith("/assets/") || e.request.mode === "navigate")) {
          const copia = r.clone();
          caches.open(CACHE).then((c) => c.put(e.request.mode === "navigate" ? pagina(url) : e.request, copia));
        }
        return r;
      })
      .catch(() => caches.match(e.request.mode === "navigate" ? pagina(url) : e.request).then((r) => r || Response.error())),
  );
});
