/* imgready Service Worker
 *
 * Goal: app loads instantly on repeat visits, works offline, and never
 * costs the user a fresh CDN download for the heavy WASM modules.
 *
 * Strategy per resource type:
 *   - WASM / CDN libs (versioned URLs, immutable): cache-first
 *       jsquash WebP, jsquash AVIF, libheif, UPNG, pako, jszip
 *   - App shell HTML/JS/CSS (same-origin GET): stale-while-revalidate
 *   - /api/* (license verification, telemetry): network-only, never cached
 *   - Everything else GET on same origin: stale-while-revalidate
 *
 * No skipWaiting — a new SW takes over only when no tabs hold the old one,
 * so we never reload mid-processing and lose a user's work.
 */

// Bump on every deploy. Tag is just for humans; what matters is that the
// string changes so old caches get evicted in the activate step.
const CACHE_VERSION = 'imgready-2026-05-14-cdn-jsdelivr';
const PRECACHE  = `${CACHE_VERSION}-precache`;
const RUNTIME   = `${CACHE_VERSION}-runtime`;
const CDN_CACHE = `${CACHE_VERSION}-cdn`;

// Minimal app shell. We don't precache every landing page — they're
// independently navigable and SEO-fed, so SWR runtime caching is fine.
const PRECACHE_URLS = [
  '/',
  '/imgready-worker.js',
  '/manifest.webmanifest',
  '/favicon.svg',
];

// CDN libraries we want to cache aggressively. URLs are pinned to versions,
// so cache-first is safe and the right thing to do.
const CDN_HOSTS = [
  'cdn.jsdelivr.net',
  'cdnjs.cloudflare.com',
  'esm.sh',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PRECACHE).then((cache) => cache.addAll(PRECACHE_URLS))
      .catch(() => { /* If a precache item 404s, don't break install. */ })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.map((k) => {
        if (k.startsWith('imgready-') && !k.startsWith(CACHE_VERSION)) {
          return caches.delete(k);
        }
        return null;
      })
    )).then(() => self.clients.claim())
  );
});

/* Named-blob registry. The page registers result blobs here keyed by a
 * short ID and a desired filename; when the page sets <img src> to
 * /r/{id}/{filename}, the SW intercepts the fetch and returns the blob
 * with proper Content-Type + Content-Disposition headers.
 *
 * Why: blob URLs (URL.createObjectURL) carry no filename, so right-click
 * "Save image as..." defaults to a random hash like "blob_a2bc4f...".
 * Routing through a real-looking URL with a filename in the path lets
 * the browser suggest "vacation_imgready.jpg" instead. Same trick used
 * by Google Photos and most polished image-tool web apps.
 *
 * The registry lives in memory; entries are cleared on SW restart or
 * when the page explicitly sends a 'release-blob' / 'release-all'
 * message (e.g. when a card is removed or Clear All fires). Memory
 * naturally bounds itself to one batch.
 */
const _blobRegistry = new Map(); /* id -> {blob, filename} */

// Allow page to ask for SW version (used by the update-available banner)
// + register/release named blobs for the right-click filename trick.
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data) return;
  if (data.type === 'GET_VERSION') {
    event.ports[0] && event.ports[0].postMessage({ version: CACHE_VERSION });
    return;
  }
  if (data.type === 'register-blob' && data.id && data.blob) {
    _blobRegistry.set(data.id, { blob: data.blob, filename: data.filename || 'image' });
    return;
  }
  if (data.type === 'release-blob' && data.id) {
    _blobRegistry.delete(data.id);
    return;
  }
  if (data.type === 'release-all') {
    _blobRegistry.clear();
    return;
  }
});

function isNamedBlobRequest(url) {
  return url.pathname.startsWith('/r/');
}

async function serveNamedBlob(url) {
  /* Path shape: /r/{id}/{filename}. We only need the id for lookup —
     the filename in the URL is purely cosmetic for the browser's
     "Save image as" suggestion. */
  const parts = url.pathname.split('/').filter(Boolean); /* ['r', id, filename] */
  const id = parts[1];
  const entry = _blobRegistry.get(id);
  if (!entry) {
    return new Response('Not found', { status: 404 });
  }
  return new Response(entry.blob, {
    status: 200,
    headers: {
      'Content-Type': entry.blob.type || 'application/octet-stream',
      /* `inline` (not `attachment`) so the browser still RENDERS the image
         in the <img> tag. The filename hint is what shapes the right-click
         "Save image as" suggestion. */
      'Content-Disposition': 'inline; filename="' + entry.filename.replace(/"/g, '') + '"',
      'Cache-Control': 'no-store',
    },
  });
}

function isCdnRequest(url) {
  return CDN_HOSTS.indexOf(url.hostname) !== -1;
}

function isApiRequest(url) {
  return url.pathname.startsWith('/api/');
}

function isHtmlRequest(req) {
  if (req.mode === 'navigate') return true;
  const accept = req.headers.get('accept') || '';
  return accept.indexOf('text/html') !== -1;
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  /* Defensive: if a previous run cached an opaque response (e.g. a no-cors
     <script> tag on the same URL the worker later wants via importScripts),
     drop it and refetch with CORS so the worker can actually consume it. */
  if (hit && hit.type === 'opaque') {
    cache.delete(req).catch(() => {});
  } else if (hit) {
    return hit;
  }
  try {
    const res = await fetch(req);
    // Only cache real (cors/basic) 200s. Opaque responses are unusable to
    // importScripts in workers, so caching them just poisons the cache.
    if (res && res.status === 200 && res.type !== 'opaque') {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    // Re-check the cache in case another request populated it concurrently.
    const second = await cache.match(req);
    if (second && second.type !== 'opaque') return second;
    throw err;
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  // Check runtime cache first; fall back to precache so install-seeded entries
  // (/, /imgready-worker.js, /manifest.webmanifest, /favicon.svg) actually serve.
  let cached = await cache.match(req);
  if (!cached) {
    const pre = await caches.open(PRECACHE);
    cached = await pre.match(req);
  }
  const network = fetch(req).then((res) => {
    if (res && res.status === 200) {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  }).catch(() => null);

  // Return cached immediately if we have it; otherwise wait for network.
  if (cached) {
    network; // fire-and-forget revalidation
    return cached;
  }
  const fresh = await network;
  if (fresh) return fresh;

  // Final fallback for navigations: serve the cached shell so the app still opens.
  if (isHtmlRequest(req)) {
    const shell = await cache.match('/') || await caches.match('/');
    if (shell) return shell;
  }
  return new Response('Offline and no cache available.', { status: 503, statusText: 'Offline' });
}


/* Web Share Target API — receives files shared FROM other apps (camera,
   gallery, screenshot tools) on mobile when the user picks imgready as
   the destination. The browser POSTs a multipart/form-data to the
   `share_target.action` URL declared in manifest.webmanifest. The SW
   intercepts that POST, stashes the files in a session-scoped queue,
   and 303-redirects the page to `/?share-pending=1` so the SPA boots
   normally and the client picks the files up via postMessage. */
const _shareInbox = []; /* { files: File[] } */

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'POST') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname !== '/share-target/' && url.pathname !== '/share-target') return;

  event.respondWith((async () => {
    try {
      const form = await req.formData();
      const files = form.getAll('files').filter(f => f && typeof f === 'object' && 'arrayBuffer' in f);
      if (files.length) {
        _shareInbox.push({ files });
      }
    } catch (e) {
      /* If the body's malformed for some reason, swallow it — the user
         still ends up on / with no files queued, which is recoverable. */
    }
    return Response.redirect('/?share-pending=1', 303);
  })());
});

/* Pickup handler: client asks for queued shared files via postMessage.
   Responds via the MessageChannel port the client provides. */
self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'pickup-share') return;
  const port = event.ports[0];
  if (!port) return;
  const drained = _shareInbox.splice(0, _shareInbox.length);
  const all = drained.flatMap(b => b.files);
  port.postMessage({ files: all });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Named-blob route: /r/{id}/{filename}. Serves a registered blob
  // with proper headers so right-click "Save image as" suggests the
  // filename in the URL path. Never cached (no-store on the response)
  // because blobs are session-scoped and re-registered on each batch.
  if (url.origin === self.location.origin && isNamedBlobRequest(url)) {
    event.respondWith(serveNamedBlob(url));
    return;
  }

  // Never touch API calls — license verification must always hit the network.
  if (url.origin === self.location.origin && isApiRequest(url)) {
    return;
  }

  // CDN libs: cache-first (versioned URLs, very large, expensive to refetch).
  if (isCdnRequest(url)) {
    event.respondWith(cacheFirst(req, CDN_CACHE));
    return;
  }

  // Same origin: SWR for everything cacheable.
  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME));
    return;
  }

  // Other cross-origin (analytics, ads): pass through to the network as-is.
});
/* SW_EOF */
