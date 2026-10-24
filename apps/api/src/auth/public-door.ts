// The public door (Issue #293, ADR-0010): how an anonymous request reaches a
// published project's pages. No token is asked for and no account is
// resolved. Instead each request is counted against its client's allowance
// for the minute, and then runs in a transaction as the public role
// (`withPublishedProject`, @waste/db/public-door), inside the project
// published under the path's slug. A slug no project publishes under — or one
// that is no slug at all — is a 404, the same answer either way, so the door
// says nothing about the projects it does not open.
//
// The allowance is per client and per minute, held in this process's memory:
// the API runs as one instance on the Pilot (ADR-0008), and a restart forgets
// a minute's counts, which is the most it could cost. A client is the address
// the request came from, as far as the API can know it: with no proxy trusted
// (PUBLIC_TRUSTED_PROXIES unset or 0) the socket's peer, and `X-Forwarded-For`
// is ignored, since nothing but the client wrote it; behind N trusted proxies,
// each appending the address it was reached from, the entry the outermost one
// wrote — the Nth from the end — and the peer where the header is shorter
// than that, so the request did not come through them all. An IPv6 client is
// counted by its /64, the block one host is handed, so stepping through the
// addresses of its own network is still one client.
//
// An address's calendar feed has an allowance of its own (`FeedAllowance`):
// a calendar service reads its subscribers' feeds from a few addresses of its
// own, so one visitor's minute would have them refuse each other. The feed is
// counted per client and address, generously, and per client across
// addresses, low, so the feed is no faster a way to walk a project's
// addresses than its pages — an address the door does not know counted the
// same as one it does.
import type { Database, Tx } from "@waste/db/client"
import { withPublishedProject, type PublishedProject } from "@waste/db/public-door"
import { isPublicSlug } from "@waste/domain/access/public-slug"
import type { Context, MiddlewareHandler } from "hono"

import { problem } from "../problem"

export type PublicEnv = { Variables: { published: PublishedProject; tx: Tx } }

/** A public client's requests a minute unless PUBLIC_REQUESTS_PER_MINUTE says otherwise (env.ts): a resident searching types a few, a page reads a few more. */
export const PUBLIC_REQUESTS_PER_MINUTE = 60

/** One feed's requests a minute from one client: a calendar service reading it for each of its subscribers there, a resident reloading. */
export const FEED_REQUESTS_PER_ADDRESS = 60
/** The distinct addresses whose feeds one client reads in a minute. */
export const FEED_ADDRESSES_PER_CLIENT = 20

const WINDOW_MS = 60_000
/** How many clients a window remembers before the oldest windows are forgotten early. */
const REMEMBERED_CLIENTS = 10_000
/** How much of an address the feed's allowance keeps: an id is 36 characters, and nothing longer is one. */
const ADDRESS_KEPT = 64

type Taken = { allowed: true } | { allowed: false; retryAfterSeconds: number }

/** The seconds left of a window that began at `start`. */
const secondsLeft = (start: number, at: number): number => Math.max(1, Math.ceil((start + WINDOW_MS - at) / 1000))

/** Drops the windows that have ended, and the oldest half if none has. */
function forget(windows: Map<string, { start: number }>, at: number): void {
  for (const [key, window] of windows) if (at - window.start >= WINDOW_MS) windows.delete(key)
  if (windows.size < REMEMBERED_CLIENTS) return
  const oldest = [...windows.entries()].sort((a, b) => a[1].start - b[1].start).slice(0, REMEMBERED_CLIENTS / 2)
  for (const [key] of oldest) windows.delete(key)
}

/** A fixed window per client: `take` counts a request and says whether it fits, and when the client may ask again if not. */
export class Allowance {
  readonly #windows = new Map<string, { start: number; count: number }>()

  constructor(
    readonly perMinute: number,
    readonly now: () => Date,
  ) {}

  take(client: string): Taken {
    const at = this.now().getTime()
    const window = this.#windows.get(client)
    if (window === undefined || at - window.start >= WINDOW_MS) {
      if (this.#windows.size >= REMEMBERED_CLIENTS) forget(this.#windows, at)
      this.#windows.set(client, { start: at, count: 1 })
      return { allowed: true }
    }
    if (window.count < this.perMinute) {
      window.count += 1
      return { allowed: true }
    }
    return { allowed: false, retryAfterSeconds: secondsLeft(window.start, at) }
  }
}

/** A feed's allowance: `perAddress` requests a minute per client and address, and `addressesPerClient` distinct addresses a minute per client. */
export class FeedAllowance {
  readonly #perAddress: Allowance
  readonly #walks = new Map<string, { start: number; addresses: Set<string> }>()

  constructor(
    readonly perAddress: number,
    readonly addressesPerClient: number,
    readonly now: () => Date,
  ) {
    this.#perAddress = new Allowance(perAddress, now)
  }

  take(client: string, address: string): Taken {
    const at = this.now().getTime()
    const kept = address.toLowerCase().slice(0, ADDRESS_KEPT)
    let walk = this.#walks.get(client)
    if (walk === undefined || at - walk.start >= WINDOW_MS) {
      if (this.#walks.size >= REMEMBERED_CLIENTS) forget(this.#walks, at)
      walk = { start: at, addresses: new Set() }
      this.#walks.set(client, walk)
    }
    if (!walk.addresses.has(kept)) {
      if (walk.addresses.size >= this.addressesPerClient) return { allowed: false, retryAfterSeconds: secondsLeft(walk.start, at) }
      walk.addresses.add(kept)
    }
    return this.#perAddress.take(`${client} ${kept}`)
  }
}

/** The address as the allowance counts it: an IPv4 address (an IPv4-mapped IPv6 one as its IPv4), or an IPv6 address's /64. */
export function allowanceKey(address: string): string {
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  if (mapped?.[1] !== undefined) return mapped[1]
  if (!address.includes(":")) return address
  const [head = "", tail] = address.toLowerCase().split("%")[0]?.split("::") ?? []
  const front = head === "" ? [] : head.split(":")
  const back = tail === undefined || tail === "" ? [] : tail.split(":")
  const groups = tail === undefined ? front : [...front, ...Array.from({ length: Math.max(0, 8 - front.length - back.length) }, () => "0"), ...back]
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`
}

/** Who a request came from: the entry the outermost of `trustedProxies` proxies wrote into X-Forwarded-For, else the peer `peer` names. */
export function clientOf(c: Context, peer: (c: Context) => string | undefined, trustedProxies: number): string {
  if (trustedProxies > 0) {
    const entries =
      c.req
        .header("x-forwarded-for")
        ?.split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== "") ?? []
    const written = entries.length >= trustedProxies ? entries[entries.length - trustedProxies] : undefined
    if (written !== undefined) return allowanceKey(written)
  }
  const address = peer(c)
  return address === undefined ? "unknown" : allowanceKey(address)
}

export type PublicDoorOptions = {
  pool: Database
  /** Counts the request against its client's allowance: the pages' `Allowance`, or a feed's, which reads the request's address too. */
  allowance: { take(client: string, c: Context): Taken }
  /** The socket's peer address; server.ts reads it from the Node request, a test hands a fixed one or none. */
  peer: (c: Context) => string | undefined
  /** How many proxies in front append to X-Forwarded-For: 0 ignores the header. */
  trustedProxies: number
}

const noSuchProject = (slug: string) => problem(404, { detail: `No project is published as ${JSON.stringify(slug)}` })

/** Thrown out of the transaction to roll it back when the handler answered a refusal, as the principal guard does. */
class Discard {}

/** The door itself, put before every public route's handler: the allowance first, then the published project's transaction. */
export function publicDoor({ pool, allowance, peer, trustedProxies }: PublicDoorOptions): MiddlewareHandler<PublicEnv> {
  return async (c, next) => {
    const taken = allowance.take(clientOf(c, peer, trustedProxies), c)
    if (!taken.allowed) {
      throw problem(429, {
        detail: `Too many requests from this address; ask again in ${taken.retryAfterSeconds} s`,
        headers: { "Retry-After": String(taken.retryAfterSeconds) },
      })
    }
    const slug = c.req.param("slug") ?? ""
    if (!isPublicSlug(slug)) throw noSuchProject(slug)
    let opened = false
    try {
      await withPublishedProject(pool.db, slug, async (tx, published) => {
        opened = true
        c.set("published", published)
        c.set("tx", tx)
        await next()
        if (c.error !== undefined || c.res.status >= 400) throw new Discard()
      })
    } catch (error) {
      if (!(error instanceof Discard)) throw error
    }
    if (!opened) throw noSuchProject(slug)
  }
}
