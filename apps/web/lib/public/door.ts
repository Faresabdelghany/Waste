// The web's side of the public door (Issue #293, ADR-0010): a public page
// asks the API on the server, at request time, for what anyone may read of a
// published project. No session and no token, so lib/api/client.ts — the
// signed-in door — is not this; the page reads straight from WASTE_API_ORIGIN
// rather than through the browser's `/waste-api` rewrite.
//
// The API counts each client's requests a minute. A page's request comes
// from this server, so it names the visitor in `X-Forwarded-For`: the last
// entry of the header as it reached this server, the one the proxy in front
// of the web wrote, and nothing a visitor wrote before it. The API's
// PUBLIC_TRUSTED_PROXIES then counts that one entry plus each proxy on the way
// from this server to the API, which appends its own.
//
// An answer is one of four: the body, a project nobody publishes under the
// slug (the page's 404), the visitor's allowance spent for the minute, or the
// door not reachable — no origin configured, a refusal the page has no words
// for, or no answer at all. A public page never shows an API's sentence.
import type { PublishedProject } from "@waste/contracts/public"
import type { SortingGuideAnswer } from "@waste/contracts/sorting-guide"

export type DoorAnswer<T> = { kind: "ok"; body: T } | { kind: "not-published" } | { kind: "too-many"; retryAfterSeconds: number } | { kind: "unavailable" }

export type DoorOptions = {
  /** The API's origin, `WASTE_API_ORIGIN`; undefined where the web runs without one. */
  origin: string | undefined
  /** The visitor's `X-Forwarded-For` as it reached this server; its last entry is passed on, null where it had none. */
  forwardedFor: string | null
  /** The fetch to ask with; a test hands its own. */
  fetch?: typeof fetch
}

/** How long a page waits for the door before it says the guide cannot be reached. */
export const DOOR_TIMEOUT_MS = 5_000

/** The seconds a 429's `Retry-After` names, or a minute where it names none. */
const retryAfterOf = (response: Response): number => {
  const seconds = Number(response.headers.get("retry-after"))
  return Number.isInteger(seconds) && seconds > 0 ? seconds : 60
}

/** The visitor as this server's own proxy named them: the header's last entry, or null for none. */
export function visitorOf(forwardedFor: string | null): string | null {
  const last = forwardedFor
    ?.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .at(-1)
  return last ?? null
}

/** Asks the public door for `path` (`<slug>` or `<slug>/sorting-guide?q=…`), answering one of the four. */
export async function readDoor<T>(path: string, { origin, forwardedFor, fetch: fetching = fetch }: DoorOptions): Promise<DoorAnswer<T>> {
  const base = origin?.replace(/\/+$/, "")
  if (base === undefined || base === "") return { kind: "unavailable" }
  const visitor = visitorOf(forwardedFor)
  let response: Response
  try {
    response = await fetching(`${base}/public/${path}`, {
      headers: { accept: "application/json", ...(visitor === null ? {} : { "x-forwarded-for": visitor }) },
      signal: AbortSignal.timeout(DOOR_TIMEOUT_MS),
    })
  } catch {
    return { kind: "unavailable" }
  }
  if (response.status === 404) return { kind: "not-published" }
  if (response.status === 429) return { kind: "too-many", retryAfterSeconds: retryAfterOf(response) }
  if (!response.ok) return { kind: "unavailable" }
  try {
    return { kind: "ok", body: (await response.json()) as T }
  } catch {
    return { kind: "unavailable" }
  }
}

/** The published project under the slug. */
export const readPublishedProject = (slug: string, options: DoorOptions) => readDoor<PublishedProject>(encodeURIComponent(slug), options)

/** A search of the project's sorting guide. */
export const searchSortingGuide = (slug: string, query: string, options: DoorOptions) =>
  readDoor<SortingGuideAnswer>(`${encodeURIComponent(slug)}/sorting-guide?q=${encodeURIComponent(query)}`, options)
