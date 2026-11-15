// LIFELINE service worker: after ONE online visit the app opens with no network.
//  - on install it caches the page and every file the page references
//  - pages: network first, cached copy when offline
//  - app files: cache first
//  - map tiles and fonts: cached as they are viewed (so the map area you have
//    looked at while online still shows offline)
//  - /api is never cached
const CACHE = "lifeline-shell-v1";
const RUNTIME = "lifeline-runtime-v1";
const CACHEABLE_HOSTS = ["tile.openstreetmap.org", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const page = await fetch("/", { cache: "reload" });
    const html = await page.clone().text();
    await cache.put("/", page);
    const files = new Set(["/favicon.svg"]);
    for (const match of html.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)) files.add(match[1]);
    await Promise.all([...files].map((file) => cache.add(file).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== CACHE && name !== RUNTIME) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        const cache = await caches.open(CACHE);
        cache.put("/", fresh.clone());
        return fresh;
      } catch {
        return (await caches.match("/")) || Response.error();
      }
    })());
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !CACHEABLE_HOSTS.includes(url.hostname)) return;

  event.respondWith((async () => {
    const cached = await caches.match(request);
    if (cached) return cached;
    try {
      const response = await fetch(request);
      if (response.ok || response.type === "opaque") {
        const cache = await caches.open(sameOrigin ? CACHE : RUNTIME);
        cache.put(request, response.clone());
      }
      return response;
    } catch {
      return Response.error();
    }
  })());
});
