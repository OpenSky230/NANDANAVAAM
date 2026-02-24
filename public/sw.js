// sw.js — cache-first + precache helpers (bounded size)
const VERSION = "v12";
const PANO_CACHE = `pano-cache-${VERSION}`;
const APP_CACHE = `app-cache-${VERSION}`;

// Support variant pano folders (e.g., panos-mobile, panos-mobile-6k).
const PANO_RE = /\/panos(?:-[^/]+)?\/.+\.(jpg|jpeg|png|webp|ktx2)$/i;
const APP_ASSET_RE = /\/assets\/.+\.(png|jpg|jpeg|webp|svg|ico|woff2?)$/i;
const KTX2_RUNTIME_RE = /\/ktx2\/.+\.(js|wasm)$/i;
const EXP_JSON_RE = /\/experiences\/.+\.json$/i;
const TOUR_JSON_RE = /\/tours\/.+\.json$/i;

const MAX_PANO_ENTRIES = 220;
const MAX_APP_ENTRIES = 120;
const MAX_PINNED = 60;

// url -> lastSeenMs (eviction protection hint)
const PINNED = new Map();

async function trimCache(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const toDelete = keys.length - maxEntries;
  for (let i = 0; i < toDelete; i++) await cache.delete(keys[i]);
}

async function trimCachePreferPinned(cache, maxEntries) {
  const keys = await cache.keys();
  if (keys.length <= maxEntries) return;
  const keep = new Set(PINNED.keys());
  let excess = keys.length - maxEntries;

  // Delete non-pinned entries first (best-effort)
  for (const req of keys) {
    if (excess <= 0) break;
    if (!keep.has(req.url)) {
      try { await cache.delete(req); } catch {}
      excess--;
    }
  }
  if (excess <= 0) return;

  // Still too big: delete oldest remaining
  const keys2 = await cache.keys();
  for (const req of keys2) {
    if (excess <= 0) break;
    try { await cache.delete(req); } catch {}
    excess--;
  }
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(APP_CACHE);
    const urls = [
      "/",
      "/index.html",
      "/manifest.webmanifest",
      "/assets/logo.png",
      "/assets/background.jpg",
      "/ktx2/babylon.ktx2Decoder.js",
      "/ktx2/msc_basis_transcoder.js",
      "/ktx2/msc_basis_transcoder.wasm",
      "/ktx2/zstddec.wasm",
      "/ktx2/uastc_astc.wasm",
      "/ktx2/uastc_bc7.wasm",
      "/ktx2/uastc_r8_unorm.wasm",
      "/ktx2/uastc_rg8_unorm.wasm",
      "/ktx2/uastc_rgba8_unorm_v2.wasm",
      "/ktx2/uastc_rgba8_srgb_v2.wasm",
      "/experiences/manifest.json",
      "/tours/default.json",
    ];
    for (const u of urls) {
      try {
        const req = new Request(u, { credentials: "same-origin", cache: "no-cache" });
        const resp = await fetch(req);
        if (resp && resp.ok) await cache.put(req, resp.clone());
      } catch {}
    }
    trimCache(cache, MAX_APP_ENTRIES).catch(() => {});
  })());
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.map((n) => {
        const isManaged = n.startsWith("pano-cache-") || n.startsWith("app-cache-");
        if (!isManaged) return Promise.resolve();
        if (n === PANO_CACHE || n === APP_CACHE) return Promise.resolve();
        return caches.delete(n);
      })
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  // Bypass cache if nocache=1 query is present
  if (url.searchParams.get("nocache") === "1") {
    event.respondWith(fetch(request, { cache: "no-store" }));
    return;
  }

  // Dev / module paths should never be cached (prevents stale bundles)
  if (
    url.pathname.startsWith("/@vite/") ||
    url.pathname.startsWith("/src/") ||
    url.pathname.startsWith("/node_modules/")
  ) {
    event.respondWith(fetch(request, { cache: "no-store" }));
    return;
  }

  // Navigations: network-first, fallback to cached index.html
  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(request);
        try {
          const cache = await caches.open(APP_CACHE);
          await cache.put(new Request("/index.html"), fresh.clone());
          trimCache(cache, MAX_APP_ENTRIES).catch(() => {});
        } catch {}
        return fresh;
      } catch {
        const cache = await caches.open(APP_CACHE);
        return (await cache.match("/index.html")) || Response.error();
      }
    })());
    return;
  }

  const isPano = PANO_RE.test(url.pathname);
  const isAppAsset =
    APP_ASSET_RE.test(url.pathname) ||
    KTX2_RUNTIME_RE.test(url.pathname) ||
    EXP_JSON_RE.test(url.pathname) ||
    TOUR_JSON_RE.test(url.pathname) ||
    request.destination === "manifest" ||
    url.pathname === "/manifest.webmanifest" ||
    request.destination === "script" ||
    request.destination === "style" ||
    request.destination === "font";

  if (!isPano && !isAppAsset) return;

  // Scripts/styles/fonts: network-first so updates apply immediately.
  // Other assets/panos: cache-first (fast + resilient).
  const isCode =
    request.destination === "script" ||
    request.destination === "style" ||
    request.destination === "font";
  if (isCode) {
    event.respondWith((async () => {
      const cache = await caches.open(APP_CACHE);
      try {
        const resp = await fetch(request, { credentials: "same-origin", cache: "no-cache" });
        if (resp && resp.ok) {
          await cache.put(request, resp.clone());
          trimCache(cache, MAX_APP_ENTRIES).catch(() => {});
        }
        return resp;
      } catch {
        return (await cache.match(request)) || Response.error();
      }
    })());
    return;
  }

  // Cache-first, background refresh
  event.respondWith((async () => {
    const cache = await caches.open(isPano ? PANO_CACHE : APP_CACHE);
    const cached = await cache.match(request);
    const fetchAndUpdate = (async () => {
      try {
        const resp = await fetch(request, { credentials: "same-origin", cache: "no-cache" });
        if (resp && resp.ok) {
          // Cache writes can throw (quota). Never fail the response due to cache.put.
          try {
            await cache.put(request, resp.clone());
            if (isPano) trimCachePreferPinned(cache, MAX_PANO_ENTRIES).catch(() => {});
            else trimCache(cache, MAX_APP_ENTRIES).catch(() => {});
          } catch {}
        }
        return resp;
      } catch {
        return null;
      }
    })();

    if (cached) {
      event.waitUntil(fetchAndUpdate);
      return cached;
    }
    const fresh = await fetchAndUpdate;
    return fresh || Response.error();
  })());
});

self.addEventListener("message", (event) => {
  const { type, urls } = event.data || {};

  if (type === "precache") {
    if (!Array.isArray(urls) || urls.length === 0) return;
    event.waitUntil((async () => {
      const panoCache = await caches.open(PANO_CACHE);
      const appCache = await caches.open(APP_CACHE);

      for (const u of urls) {
        try {
          const req = new Request(u, { credentials: "same-origin", cache: "no-cache" });
          const pathname = new URL(req.url).pathname;
          const isPano = PANO_RE.test(pathname);
          const cache = isPano ? panoCache : appCache;
          const hit = await cache.match(req);
          if (!hit) {
            const resp = await fetch(req);
            if (resp && resp.ok) await cache.put(req, resp.clone());
          }
        } catch {}
      }

      trimCachePreferPinned(panoCache, MAX_PANO_ENTRIES).catch(() => {});
      trimCache(appCache, MAX_APP_ENTRIES).catch(() => {});
    })());
    return;
  }

  // Mark a set of pano URLs as "pinned" (best-effort eviction protection).
  // This should NOT wipe the cache; it only influences eviction when over limit.
  if (type === "retain") {
    if (!Array.isArray(urls)) return;
    event.waitUntil((async () => {
      const cache = await caches.open(PANO_CACHE);
      const now = Date.now();
      for (const u of urls) {
        try {
          const abs = new URL(String(u || ""), self.location.origin).href;
          PINNED.set(abs, now);
        } catch {}
      }
      if (PINNED.size > MAX_PINNED) {
        const sorted = Array.from(PINNED.entries()).sort((a, b) => (b[1] || 0) - (a[1] || 0));
        PINNED.clear();
        for (const [k, t] of sorted.slice(0, MAX_PINNED)) PINNED.set(k, t);
      }
      trimCachePreferPinned(cache, MAX_PANO_ENTRIES).catch(() => {});
    })());
    return;
  }

  if (type === "flush") {
    event.waitUntil((async () => {
      const names = await caches.keys();
      await Promise.all(
        names.map((n) =>
          (n.startsWith("pano-cache-") || n.startsWith("app-cache-"))
            ? caches.delete(n)
            : Promise.resolve()
        )
      );
    })());
  }
});
