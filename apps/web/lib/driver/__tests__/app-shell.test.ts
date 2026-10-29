// The Driver App's app shell (O25 of #290): what a page tells the worker to
// keep and when it registers it; and the worker itself (public/driver-sw.js),
// run in a sandbox over a fake Cache Storage and network, as the browser
// would run it.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, test } from "node:test"
import { runInNewContext } from "node:vm"

import { keepShell, registerShell, SHELL_SCOPE, SHELL_SCRIPT, shellUrls } from "../app-shell"

const ORIGIN = "https://pilot.test"

describe("the page's side", () => {
  test("keeps the screen's own path and the build's static files it loaded, once each, and nothing else", () => {
    assert.deepEqual(
      shellUrls("/driver/routes/r1", [`${ORIGIN}/_next/static/chunks/a.js`, `${ORIGIN}/_next/static/chunks/a.js`, `${ORIGIN}/waste-api/driver/me`, "https://tiles.test/_next/static/x.js", `${ORIGIN}/_next/static/css/b.css`], ORIGIN),
      ["/driver/routes/r1", `${ORIGIN}/_next/static/chunks/a.js`, `${ORIGIN}/_next/static/css/b.css`],
    )
  })

  test("registers the worker over /driver in a production build where the browser has workers, and nowhere else, telling it what the page loaded", async () => {
    const registered: unknown[] = []
    const posted: unknown[] = []
    const registration = { active: { postMessage: (message: unknown) => posted.push(message) } }
    const scope = (serviceWorker: unknown) => ({ navigator: { serviceWorker } as never, location: { pathname: "/driver", origin: ORIGIN }, performance: { getEntriesByType: () => [{ name: `${ORIGIN}/_next/static/chunks/a.js` }] } as never })
    const workers = { register: async (...args: unknown[]) => void registered.push(args), getRegistration: async () => registration }
    await registerShell(scope(workers), true)
    await registerShell(scope(workers), false)
    await registerShell(scope(undefined), true)
    assert.deepEqual(registered, [[SHELL_SCRIPT, { scope: SHELL_SCOPE }]])
    assert.deepEqual(posted, [{ type: "keep", urls: ["/driver", `${ORIGIN}/_next/static/chunks/a.js`] }])
    const logged: string[] = []
    await registerShell(scope({ register: async () => Promise.reject(new Error("blocked")), getRegistration: workers.getRegistration }), true, (message) => logged.push(message))
    assert.equal(logged.length, 1, "a refused registration leaves the app online, said once")
    assert.equal(posted.length, 1, "and tells no worker anything")
  })

  test("tells the registration's worker what the screen loaded, an installing one included, and nothing where none is registered", async () => {
    const posted: unknown[] = []
    const scope = (registration: unknown) => ({ navigator: { serviceWorker: { register: async () => undefined, getRegistration: async () => registration } } as never, location: { pathname: "/driver/routes/r1", origin: ORIGIN }, performance: { getEntriesByType: () => [] } as never })
    await keepShell(scope({ active: null, waiting: null, installing: { postMessage: (message: unknown) => posted.push(message) } }), true)
    await keepShell(scope(undefined), true)
    await keepShell(scope({ active: { postMessage: (message: unknown) => posted.push(message) } }), false)
    assert.deepEqual(posted, [{ type: "keep", urls: ["/driver/routes/r1"] }])
  })
})

/** The worker in a sandbox: its handlers, a Cache Storage of maps, and a network that answers or is down. */
function worker() {
  const handlers: Record<string, (event: unknown) => void> = {}
  const stores = new Map<string, Map<string, Response>>()
  let online = true
  const fetched: string[] = []
  const keyOf = (request: Request | string) => (typeof request === "string" ? new URL(request, ORIGIN).href : request.url)
  const cacheOf = (name: string) => {
    const entries = stores.get(name) ?? new Map<string, Response>()
    stores.set(name, entries)
    return {
      match: async (request: Request | string) => entries.get(keyOf(request))?.clone(),
      put: async (request: Request | string, response: Response) => void entries.set(keyOf(request), response),
      add: async (request: string) => void entries.set(keyOf(request), new Response(`page ${request}`)),
    }
  }
  const caches = { open: async (name: string) => cacheOf(name), keys: async () => [...stores.keys()], delete: async (name: string) => stores.delete(name) }
  const fetchImpl = async (request: Request | string) => {
    const url = keyOf(request)
    fetched.push(url)
    if (!online) throw new TypeError("Failed to fetch")
    return new Response(`fresh ${new URL(url).pathname}`, { status: 200 })
  }
  const self = {
    location: new URL(ORIGIN),
    addEventListener: (type: string, handler: (event: unknown) => void) => void (handlers[type] = handler),
    skipWaiting: async () => undefined,
    clients: { claim: async () => undefined },
  }
  runInNewContext(readFileSync(new URL("../../../public/driver-sw.js", import.meta.url), "utf8"), { self, caches, fetch: fetchImpl, URL, Response, Promise, Array, console })

  /** Dispatches an event and answers what it responded with, once everything it waits on settles. */
  const dispatch = async (type: string, fields: Record<string, unknown>): Promise<Response | undefined> => {
    let responded: Promise<Response> | undefined
    const waits: Promise<unknown>[] = []
    handlers[type]({ ...fields, respondWith: (answer: Promise<Response>) => void (responded = answer), waitUntil: (work: Promise<unknown>) => void waits.push(work) })
    await Promise.all(waits)
    return responded === undefined ? undefined : await responded
  }
  const get = (path: string, mode: RequestMode | "navigate" = "cors") => dispatch("fetch", { request: { method: "GET", url: `${ORIGIN}${path}`, mode } })
  return { dispatch, get, stores, fetched, offline: () => void (online = false), online: () => void (online = true) }
}

describe("the worker", () => {
  test("keeps the start screen at install and drops another shell version's files at activation", async () => {
    const sw = worker()
    sw.stores.set("waste-driver-shell-v0", new Map())
    sw.stores.set("someone-elses", new Map())
    await sw.dispatch("install", {})
    await sw.dispatch("activate", {})
    assert.deepEqual([...sw.stores.keys()].sort(), ["someone-elses", "waste-driver-shell-v1"])
    assert.ok(sw.stores.get("waste-driver-shell-v1")?.has(`${ORIGIN}/driver`))
  })

  test("answers a /driver page from the network and keeps it by its path; with no network the kept page, else the way to the start screen", async () => {
    const sw = worker()
    assert.equal(await (await sw.get("/driver/routes/r1?from=list", "navigate"))?.text(), "fresh /driver/routes/r1")
    sw.offline()
    assert.equal(await (await sw.get("/driver/routes/r1", "navigate"))?.text(), "fresh /driver/routes/r1")
    const unkept = await sw.get("/driver/routes/r2", "navigate")
    assert.equal(unkept?.status, 503)
    assert.match((await unkept?.text()) ?? "", /href="\/driver"/)
  })

  test("answers the build's static files from what it kept first, and the API and the office's pages never", async () => {
    const sw = worker()
    await sw.get("/_next/static/chunks/a.js")
    sw.offline()
    assert.equal(await (await sw.get("/_next/static/chunks/a.js"))?.text(), "fresh /_next/static/chunks/a.js")
    assert.equal(await sw.get("/waste-api/driver/me"), undefined)
    assert.equal(await sw.get("/operate", "navigate"), undefined)
    assert.equal(await sw.dispatch("fetch", { request: { method: "POST", url: `${ORIGIN}/waste-api/driver/commands`, mode: "cors" } }), undefined)
  })

  test("keeps what a page says it loaded: a screen reached inside the app, and its static files, nothing of another origin or the API", async () => {
    const sw = worker()
    await sw.dispatch("message", { data: { type: "keep", urls: ["/driver/routes/r1", `${ORIGIN}/_next/static/chunks/b.js`, `${ORIGIN}/waste-api/driver/me`, "https://elsewhere.test/_next/static/c.js"] } })
    assert.deepEqual(sw.fetched.sort(), [`${ORIGIN}/_next/static/chunks/b.js`, `${ORIGIN}/driver/routes/r1`])
    sw.offline()
    assert.equal(await (await sw.get("/driver/routes/r1", "navigate"))?.text(), "fresh /driver/routes/r1")
    await sw.dispatch("message", { data: "nonsense" })
  })
})
