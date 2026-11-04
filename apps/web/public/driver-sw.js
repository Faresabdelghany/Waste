// The Driver App's app shell (O25 of #290): a service worker over /driver that
// keeps the pages and the build's static files a driver has opened, so the
// app still opens with no signal and reads the day from the display cache
// (lib/driver/read-snapshot.ts). It never touches the API: what the server
// answered is the display cache's, kept per login, never this worker's.
//
//   /_next/static/*        — cache first: the build's files are named by
//                            their content, so a kept one is never stale;
//   a /driver page opened  — network first, kept by its path; with no
//                            network the kept page, else a short page that
//                            sends the driver to the start screen;
//   anything else          — not answered here.
//
// A page tells the worker what it has loaded (`keep`): its own path and the
// static files it fetched before the worker controlled it, and every route
// screen it moved to inside the app, whose document the browser never asked
// for. A new shell version drops the old one's files on activation.
const SHELL = "waste-driver-shell-v1"
const SHELL_PREFIX = "waste-driver-shell-"
const START = "/driver"

const sameOrigin = (url) => url.origin === self.location.origin
const isStatic = (url) => url.pathname.startsWith("/_next/static/")
const isDriverPage = (url) => url.pathname === START || url.pathname.startsWith(`${START}/`)
/** A page is kept by its path: a query or a hash is the same screen. */
const pageKey = (url) => `${url.origin}${url.pathname}`

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.add(START))
      .catch(() => undefined)
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith(SHELL_PREFIX) && key !== SHELL).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener("fetch", (event) => {
  const { request } = event
  if (request.method !== "GET") return
  const url = new URL(request.url)
  if (!sameOrigin(url)) return
  if (isStatic(url)) event.respondWith(cacheFirst(request))
  else if (request.mode === "navigate" && isDriverPage(url)) event.respondWith(networkFirst(request, url))
})

self.addEventListener("message", (event) => {
  const { data } = event
  if (data === null || typeof data !== "object" || data.type !== "keep" || !Array.isArray(data.urls)) return
  event.waitUntil(keep(data.urls))
})

async function cacheFirst(request) {
  const cache = await caches.open(SHELL)
  const kept = await cache.match(request)
  if (kept !== undefined) return kept
  const response = await fetch(request)
  if (response.ok) await cache.put(request, response.clone())
  return response
}

async function networkFirst(request, url) {
  const cache = await caches.open(SHELL)
  try {
    const response = await fetch(request)
    if (response.ok && !response.redirected) await cache.put(pageKey(url), response.clone())
    return response
  } catch {
    return (await cache.match(pageKey(url))) ?? notKept()
  }
}

/** A page the phone has not kept: said so, with the way to the start screen, which is kept from the install. */
function notKept() {
  const body =
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Driver App</title></head>' +
    '<body style="font-family: system-ui, sans-serif; max-width: 28rem; margin: 2rem auto; padding: 0 1rem">' +
    "<h1>No connection</h1><p>This screen was not kept on this phone. Your routes are.</p>" +
    `<p><a href="${START}">Your routes</a></p></body></html>`
  return new Response(body, { status: 503, headers: { "content-type": "text/html; charset=utf-8" } })
}

/** Keeps what a page says it loaded: its static files and its own document, each fetched afresh; one that fails is left for the next time. */
async function keep(urls) {
  const cache = await caches.open(SHELL)
  await Promise.all(
    urls.map(async (raw) => {
      let url
      try {
        url = new URL(raw, self.location.origin)
      } catch {
        return
      }
      if (!sameOrigin(url) || !(isStatic(url) || isDriverPage(url))) return
      const key = isStatic(url) ? url.href : pageKey(url)
      if (isStatic(url) && (await cache.match(key)) !== undefined) return
      try {
        const response = await fetch(key, { credentials: "same-origin" })
        if (response.ok && !response.redirected) await cache.put(key, response)
      } catch {
        // Out of reach now; the next page that loads it says so again.
      }
    }),
  )
}
