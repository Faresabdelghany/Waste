// The public collection days' rules (Issue #293, M2b), apart from their
// pages so they are tested here: which search and how many weeks the address
// asks for, what the search page shows for each answer of the door, the days
// grouped for reading and printing, how a day is written, where each page and
// the feed live, and what the feed answers a calendar app.
//
// The feed is served from the web's own origin (app/p/[slug]/calendar/
// [address]/calendar.ics), read from the door on the server like the pages,
// so a calendar app's request is counted against its own allowance by the
// same rule as a visitor's and needs neither the browser's `/waste-api`
// rewrite nor a public API origin.
import type { AddressMatch, AddressMatches, PublicCollectionDay, PublishedProject } from "@waste/contracts/public"

import type { DoorAnswer } from "./door"
import { searchQueryOf } from "./search-query"

/** The address search's bounds and the weeks read (the contracts' ADDRESS_SEARCH_MIN/MAX and COLLECTION_WEEKS), spelled again since the web imports the contracts as types only. */
export const ADDRESS_SEARCH = { min: 3, max: 100 } as const
export const WEEKS = { default: 8, max: 26 } as const

/** The spans a visitor picks between, in weeks. */
export const WEEK_CHOICES = [4, 8, 13, 26] as const

/** How many collected dates the embedded widget lists: the next few, the full page has the rest. */
export const EMBED_DATES = 6

/** The address search the URL asks for: the first `q`, trimmed and cut to the door's length; null for none or blank. */
export const addressQueryOf = (q: string | string[] | undefined): string | null => searchQueryOf(q, ADDRESS_SEARCH.max)

/** The weeks the URL asks for, within 1..26; the default for none or nonsense. */
export function weeksOf(weeks: string | string[] | undefined): number {
  const first = Array.isArray(weeks) ? weeks[0] : weeks
  const n = Number(first)
  return Number.isInteger(n) && n >= 1 ? Math.min(n, WEEKS.max) : WEEKS.default
}

/** The contracts' `Id`, a UUIDv7, spelled again. */
const ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Whether the path's address could name one: an id as the door takes it, which it would otherwise refuse as a malformed request rather than as an address it does not know. */
export const isAddressId = (address: string): boolean => ID_SHAPE.test(address)

/** What the search page shows below the search box. */
export type AddressSearchView =
  | { kind: "prompt" }
  | { kind: "too-short"; query: string }
  | { kind: "nothing"; query: string }
  | { kind: "matches"; query: string; addresses: AddressMatch[] }

/** The search page: the published project with what its search found, or why there is no page to show. */
export type SearchPageView =
  | { kind: "published"; project: PublishedProject; search: AddressSearchView }
  | { kind: "not-published" }
  | { kind: "too-many"; retryAfterSeconds: number }
  | { kind: "unavailable" }

/** What the search page asked the door, once: the search where the query is `askable`, whose answer names the project too, else the project alone. */
export type SearchAsked = { asked: "project"; query: string | null; answer: DoorAnswer<PublishedProject> } | { asked: "search"; query: string; answer: DoorAnswer<AddressMatches> }

/** Whether a query is long enough to ask the door with. */
export const askable = (query: string | null): query is string => query !== null && query.length >= ADDRESS_SEARCH.min

/** The search page the door's answer makes. */
export function searchPageViewOf(asked: SearchAsked): SearchPageView {
  if (asked.asked === "project") {
    const { query, answer } = asked
    if (answer.kind !== "ok") return answer
    // An askable query the page did not search for has no answer to show.
    if (askable(query)) return { kind: "unavailable" }
    return { kind: "published", project: answer.body, search: query === null ? { kind: "prompt" } : { kind: "too-short", query } }
  }
  const { query, answer } = asked
  if (answer.kind !== "ok") return answer
  const { project, addresses } = answer.body
  if (!askable(query)) return { kind: "published", project, search: { kind: "too-short", query } }
  return { kind: "published", project, search: addresses.length === 0 ? { kind: "nothing", query } : { kind: "matches", query, addresses } }
}

/** A day as a resident reads it: `Thursday 8 October`, on no one's clock but the date's own. */
export function dayLabelOf(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`))
}

/** A month heading: `October 2026`. */
export function monthLabelOf(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${iso}T00:00:00Z`))
}

/** One date with every collection on it. */
export type CalendarDate = { date: string; collections: PublicCollectionDay[] }

/** The days by date, in order: one entry per date however many fractions or groups come that day. */
export function datesOf(days: readonly PublicCollectionDay[]): CalendarDate[] {
  const dates: CalendarDate[] = []
  for (const day of days) {
    const last = dates.at(-1)
    if (last?.date === day.date) last.collections.push(day)
    else dates.push({ date: day.date, collections: [day] })
  }
  return dates
}

/** The widget's next dates: up to `count` with something collected, and the skipped dates among them, so a holiday never takes a collection's place. */
export function nextDatesOf(days: readonly PublicCollectionDay[], count: number): CalendarDate[] {
  const next: CalendarDate[] = []
  let collected = 0
  for (const date of datesOf(days)) {
    if (collected === count) break
    next.push(date)
    if (date.collections.some((collection) => collection.status === "collected")) collected += 1
  }
  return next
}

/** The dates by month, in order. */
export function monthsOf(days: readonly PublicCollectionDay[]): { month: string; dates: CalendarDate[] }[] {
  const months: { month: string; dates: CalendarDate[] }[] = []
  for (const date of datesOf(days)) {
    const month = date.date.slice(0, 7)
    const last = months.at(-1)
    if (last?.month === month) last.dates.push(date)
    else months.push({ month, dates: [date] })
  }
  return months
}

/** Where a page of the calendar lives: the search, or an address's days; each in full or as the widget a site embeds. */
export function calendarHrefOf(slug: string, { embed = false, addressId, query, weeks }: { embed?: boolean; addressId?: string; query?: string; weeks?: number } = {}): string {
  const path = [`/p/${encodeURIComponent(slug)}/calendar`, embed ? "embed" : null, addressId === undefined ? null : encodeURIComponent(addressId)].filter((part) => part !== null).join("/")
  const search = new URLSearchParams()
  if (query !== undefined) search.set("q", query)
  if (weeks !== undefined && weeks !== WEEKS.default) search.set("weeks", String(weeks))
  const asked = search.toString()
  return asked === "" ? path : `${path}?${asked}`
}

/** Where the address's feed lives on the web's own origin. */
export const feedPathOf = (slug: string, addressId: string): string => `${calendarHrefOf(slug, { addressId })}/calendar.ics`

/** The feed as a calendar app subscribes to it (`webcal:`) and as a URL is pasted into one, on the origin the visitor reached. */
export function feedUrlsOf(origin: string, path: string): { https: string; webcal: string } {
  const https = `${origin.replace(/\/+$/, "")}${path}`
  return { https, webcal: https.replace(/^https?:\/\//, "webcal://") }
}

/** The weeks the feed reads: as far ahead as the door goes, since a subscription is read again on the app's own schedule. */
export const FEED_WEEKS = WEEKS.max

/** What the feed answers a calendar app for each of the door's answers: the feed, or a status the app retries by. */
export function feedResponseOf(answer: DoorAnswer<string>): Response {
  switch (answer.kind) {
    case "ok":
      return new Response(answer.body, {
        headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "public, max-age=60", "content-disposition": 'attachment; filename="collection-days.ics"' },
      })
    case "not-published":
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
    case "too-many":
      return new Response("Too many requests", { status: 429, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": String(answer.retryAfterSeconds) } })
    case "unavailable":
      return new Response("Unavailable", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "60" } })
  }
}
