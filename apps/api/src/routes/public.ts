// The public door's routes (Issue #293, ADR-0010): what anyone may read of a
// project that publishes itself, with no token. `GET /public/:slug` names the
// project as its public pages do, and `GET /public/:slug/sorting-guide?q=`
// answers a resident's search of its Sorting Guide; the addresses' routes
// answer its Collection Days, and `GET /public/:slug/drop-off-points` its
// Drop-off Points on the map (M3). Every one runs behind `publicDoor`
// (auth/public-door.ts): counted against the client's minute — an address's
// feed against an allowance of its own, by client and address — then read as
// the public role, whose column grants and policies are what
// bound the answer — a draft item, another project's or another company's is
// a row this transaction cannot see, whatever the statement says.
//
// The search ranks in memory (`@waste/domain/sorting-guide/search`) over the
// project's published items, which number in the hundreds. An answer may be
// cached by whoever asks for a minute: a change the office publishes reaches
// the public within that.
import { createHash } from "node:crypto"

import {
  AddressMatches,
  AddressSearch,
  CollectionDaysQuery,
  DROP_OFF_WEEK_DAYS,
  DropOffPointsQuery,
  PublicAddressParam,
  PublicCollectionDays,
  PublicDropOffPoints,
  PublicSlugParam,
  PublishedProject,
} from "@waste/contracts/public"
import { SortingGuideAnswer, SortingGuideSearch, type SortingGuideMatch } from "@waste/contracts/sorting-guide"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { findCollectedProperty, readCollectionDayInputs, searchAddresses } from "@waste/db/query/collection-days"
import { readDropOffMap } from "@waste/db/query/drop-off-points"
import { sortingGuideItem } from "@waste/db/schema/sorting-guide"
import { collectionDaysOf } from "@waste/domain/planning/collection-days"
import { openingDaysOf } from "@waste/domain/resources/drop-off-points"
import { addDays } from "@waste/domain/route-schemes/recurrence"
import { searchGuide } from "@waste/domain/sorting-guide/search"
import { PUBLISHED_ITEM } from "@waste/domain/sorting-guide/vocabulary"
import { and, eq } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import type { Tx } from "@waste/db/client"
import type { PublishedProject as PublishedProjectRow } from "@waste/db/public-door"

import { FEED_ADDRESSES_PER_CLIENT, FEED_REQUESTS_PER_ADDRESS, type PublicEnv } from "../auth/public-door"
import { CALENDAR_MEDIA_TYPE, icsOf } from "../ical"
import { describeProblem, problem, validate } from "../problem"
import { dayInTimezone } from "./days"
import { describeJson } from "./shared"

/** How long anyone may keep a public answer: a minute, so a published change shows within one. */
export const PUBLIC_CACHE = "public, max-age=60"

const NOT_PUBLISHED = "No project is published under that slug: it was never published, or it has been unpublished."
const TOO_MANY = "This address has asked more than its allowance for the minute; ask again after the seconds Retry-After names."

const NO_SUCH_ADDRESS = "No address with something to collect in this project's calendar: it is not the project's, or nothing is collected there now."
const noSuchAddress = () => problem(404, { detail: NO_SUCH_ADDRESS })

export type PublicRoutesOptions = {
  /** The server's clock: today is read from it on the project's own clock. */
  now: () => Date
}

/** The door every public route stands behind, and the one an address's feed does, counted by its own allowance (auth/public-door.ts). */
export type PublicDoors = { door: MiddlewareHandler<PublicEnv>; feedDoor: MiddlewareHandler<PublicEnv> }

export function publicRoutes({ door, feedDoor }: PublicDoors, { now }: PublicRoutesOptions) {
  /** An address's days from today, on the project's clock, for `weeks` weeks: what both the JSON and the feed answer. */
  const collectionDaysFor = async (tx: Tx, published: PublishedProjectRow, propertyId: string, weeks: number) => {
    const scope = { companyId: published.companyId, projectId: published.id }
    const from = dayInTimezone(now(), published.timezone)
    const to = addDays(from, weeks * 7 - 1)
    const address = await findCollectedProperty(tx, scope, propertyId, from)
    if (address === undefined) throw noSuchAddress()
    const inputs = await readCollectionDayInputs(tx, scope, propertyId, { from, to })
    return { address, from, to, days: collectionDaysOf({ window: { from, to }, ...inputs }) }
  }

  return new Hono<PublicEnv>()
    .get(
      "/public/:slug",
      describeRoute({
        operationId: "getPublishedProject",
        summary: "A published project, as its public pages name it",
        description:
          "The project published under the slug (`PATCH /projects/:id` with `publicSlug`): its slug, its name, and the language and clock its public pages speak in. No token is needed; each address has an allowance a minute. The answer may be cached for a minute.",
        responses: {
          200: describeJson("The published project.", PublishedProject),
          404: describeProblem(NOT_PUBLISHED),
          429: describeProblem(TOO_MANY),
        },
      }),
      // The door first: a slug that is no slug is the same 404 as one nobody publishes under.
      door,
      validate("param", PublicSlugParam),
      (c) => {
        const { slug, name, language, timezone } = c.get("published")
        const body: PublishedProject = { slug, name, language, timezone }
        return c.json(body, 200, { "Cache-Control": PUBLIC_CACHE })
      },
    )
    .get(
      "/public/:slug/sorting-guide",
      describeRoute({
        operationId: "searchSortingGuide",
        summary: "Search a published project's sorting guide",
        description:
          "The project searched, as `GET /public/:slug` names it, so a page that searches asks once; then the published items of its sorting guide that `q` finds, best first: an exact name, then a compound typed as words (`pizza bakke` finds `Pizzabakke`), the start of the name or of a later word, the query anywhere inside it, and a typo or two in a longer word. Each synonym is searched like the name and ranks just below it; `matched` says which spelling matched. The Danish letters match their two-letter spellings (`aal` finds `Ål`). `limit` is 1..20 and defaults to 10. A query of punctuation alone finds nothing. No token is needed; each address has an allowance a minute. The answer may be cached for a minute.",
        responses: {
          200: describeJson("The items the search found, best first.", SortingGuideAnswer),
          400: describeProblem("`q` is missing, empty or longer than 100 characters, or `limit` is outside 1..20."),
          404: describeProblem(NOT_PUBLISHED),
          429: describeProblem(TOO_MANY),
        },
      }),
      door,
      validate("param", PublicSlugParam),
      validate("query", SortingGuideSearch),
      async (c) => {
        const { q, limit } = c.req.valid("query")
        const published = c.get("published")
        const rows = await c
          .get("tx")
          .select({
            id: sortingGuideItem.id,
            name: sortingGuideItem.name,
            synonyms: sortingGuideItem.synonyms,
            instructions: sortingGuideItem.instructions,
            fractionKey: wasteFraction.key,
            fractionName: wasteFraction.name,
          })
          .from(sortingGuideItem)
          .leftJoin(wasteFraction, and(eq(wasteFraction.companyId, sortingGuideItem.companyId), eq(wasteFraction.id, sortingGuideItem.wasteFractionId)))
          .where(and(eq(sortingGuideItem.companyId, published.companyId), eq(sortingGuideItem.projectId, published.id), eq(sortingGuideItem.status, PUBLISHED_ITEM)))
        const matches: SortingGuideMatch[] = searchGuide(rows, q, limit).map(({ entry, matched }) => ({
          id: entry.id,
          name: entry.name,
          synonyms: entry.synonyms,
          matched,
          fraction: entry.fractionKey === null || entry.fractionName === null ? null : { key: entry.fractionKey, name: entry.fractionName },
          instructions: entry.instructions,
        }))
        const { slug, name, language, timezone } = published
        const body: SortingGuideAnswer = { project: { slug, name, language, timezone }, query: q, matches }
        return c.json(body, 200, { "Cache-Control": PUBLIC_CACHE })
      },
    )
    .get(
      "/public/:slug/addresses",
      describeRoute({
        operationId: "searchPublicAddresses",
        summary: "Find an address whose Collection Days a published project shows",
        description:
          "The project searched, as `GET /public/:slug` names it, so a page that searches asks once; then the project's addresses that hold `q`, at least three characters, among those with something collected there today: at most ten, by address, each with the id its collection days are read under. The address alone; nothing about who lives there. Never a listing. No token is needed; each address has an allowance a minute. The answer may be cached for a minute.",
        responses: {
          200: describeJson("The addresses found, by address.", AddressMatches),
          400: describeProblem("`q` is missing, shorter than three characters or longer than 100."),
          404: describeProblem(NOT_PUBLISHED),
          429: describeProblem(TOO_MANY),
        },
      }),
      door,
      validate("param", PublicSlugParam),
      validate("query", AddressSearch),
      async (c) => {
        const { q } = c.req.valid("query")
        const published = c.get("published")
        const today = dayInTimezone(now(), published.timezone)
        const addresses = await searchAddresses(c.get("tx"), { companyId: published.companyId, projectId: published.id }, q, today)
        const { slug, name, language, timezone } = published
        const body: AddressMatches = { project: { slug, name, language, timezone }, addresses }
        return c.json(body, 200, { "Cache-Control": PUBLIC_CACHE })
      },
    )
    .get(
      "/public/:slug/addresses/:id/collection-days",
      describeRoute({
        operationId: "getPublicCollectionDays",
        summary: "An address's collection days",
        description:
          "The days the address's containers are collected, from today on the project's clock for `weeks` weeks (1..26, 8 when absent), as generation plans them: the routes standing keep the day they run on, the rest follow the schemes' recurrence and holiday policies. A day a holiday moved says so in `note` and keeps its usual day as `serviceDate`; a day the policy skips is `skipped`. Dates, fraction names and that note, nothing else. No token is needed; each address has an allowance a minute. The answer may be cached for a minute.",
        responses: {
          200: describeJson("The address's days in the window, by date.", PublicCollectionDays),
          400: describeProblem("The address id is not an id, or `weeks` is outside 1..26."),
          404: describeProblem(`${NOT_PUBLISHED} Or: ${NO_SUCH_ADDRESS}`),
          429: describeProblem(TOO_MANY),
        },
      }),
      door,
      validate("param", PublicAddressParam),
      validate("query", CollectionDaysQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const { weeks } = c.req.valid("query")
        const published = c.get("published")
        const { address, from, to, days } = await collectionDaysFor(c.get("tx"), published, id, weeks)
        const { slug, name, language, timezone } = published
        const body: PublicCollectionDays = {
          project: { slug, name, language, timezone },
          address,
          from,
          to,
          days: days.map(({ date, serviceDate, fractions, status, note }) => ({ date, serviceDate, fractions, status, note })),
        }
        return c.json(body, 200, { "Cache-Control": PUBLIC_CACHE })
      },
    )
    .get(
      "/public/:slug/addresses/:id/collection-days.ics",
      describeRoute({
        operationId: "getPublicCollectionDaysCalendar",
        summary: "An address's collection days as a calendar feed",
        description:
          "The same days as `GET /public/:slug/addresses/:id/collection-days`, as an iCalendar feed to subscribe to: one all-day event per collection, summarised by its fractions, each with a UID that stays the same across fetches and names no internal id, so a moved day moves rather than repeats; a moved or cancelled day carries SEQUENCE 1. A day the policy skips is a cancelled event saying why. The project's timezone rides as X-WR-TIMEZONE. No customer data. No token is needed. A feed has an allowance of its own, since a calendar service reads its subscribers' feeds from a few addresses: " + FEED_REQUESTS_PER_ADDRESS + " requests a minute per client and address, and " + FEED_ADDRESSES_PER_CLIENT + " distinct addresses a minute per client, an address the project does not know counted the same.",
        responses: {
          200: { description: "The feed (text/calendar).", content: { "text/calendar": { schema: { type: "string" } } } },
          400: describeProblem("The address id is not an id, or `weeks` is outside 1..26."),
          404: describeProblem(`${NOT_PUBLISHED} Or: ${NO_SUCH_ADDRESS}`),
          429: describeProblem(TOO_MANY),
        },
      }),
      feedDoor,
      validate("param", PublicAddressParam),
      validate("query", CollectionDaysQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const { weeks } = c.req.valid("query")
        const published = c.get("published")
        const { address, days } = await collectionDaysFor(c.get("tx"), published, id, weeks)
        const feed = icsOf({
          name: `${published.name} · ${address.address}`,
          timezone: published.timezone,
          now: now(),
          events: days.map((day) => ({
            // The route's identity, hashed: stable across fetches, and no internal id leaves the door.
            uid: `${createHash("sha256").update(day.key).digest("hex").slice(0, 32)}@${published.slug}`,
            date: day.date,
            summary: day.status === "skipped" ? `No collection: ${day.fractions.join(", ")}` : day.fractions.join(", "),
            description: day.note,
            cancelled: day.status === "skipped",
            sequence: day.status === "skipped" || day.date !== day.serviceDate ? 1 : 0,
          })),
        })
        return c.body(feed, 200, { "Content-Type": CALENDAR_MEDIA_TYPE, "Cache-Control": PUBLIC_CACHE })
      },
    )
    .get(
      "/public/:slug/drop-off-points",
      describeRoute({
        operationId: "getPublicDropOffPoints",
        summary: "A published project's drop-off points on its public map",
        description:
          "The project, as `GET /public/:slug` names it, and its active Drop-off Points — its recycling centres and bring banks — by name: each with its kind, address and point, the fractions it takes by name, the note it shows, and its opening over the next " +
          DROP_OFF_WEEK_DAYS +
          " days from today on the project's clock, each day its windows or open all day, with a dated exception's note or the holiday that closes it. `fraction` asks for the points taking one fraction, by the key the Sorting Guide names it by; a key the company has no fraction for finds no point and answers `fraction: null`. Never a point's code or the office's notes. No token is needed; each address has an allowance a minute. The answer may be cached for a minute.",
        responses: {
          200: describeJson("The project's drop-off points on the map, by name.", PublicDropOffPoints),
          400: describeProblem("`fraction` is not a key's shape (a lowercase slug)."),
          404: describeProblem(NOT_PUBLISHED),
          429: describeProblem(TOO_MANY),
        },
      }),
      door,
      validate("param", PublicSlugParam),
      validate("query", DropOffPointsQuery),
      async (c) => {
        const { fraction: fractionKey } = c.req.valid("query")
        const published = c.get("published")
        const from = dayInTimezone(now(), published.timezone)
        const to = addDays(from, DROP_OFF_WEEK_DAYS - 1)
        const map = await readDropOffMap(c.get("tx"), { companyId: published.companyId, projectId: published.id }, { fractionKey, from, to })
        const { slug, name, language, timezone } = published
        const body: PublicDropOffPoints = {
          project: { slug, name, language, timezone },
          fraction: map.fraction === null || map.fraction === "unknown" ? null : { key: map.fraction.key, name: map.fraction.name },
          from,
          truncated: map.truncated,
          points: map.points.map(({ opening, ...point }) => ({ ...point, week: openingDaysOf(opening, { from, days: DROP_OFF_WEEK_DAYS }, map.holidays) })),
        }
        return c.json(body, 200, { "Cache-Control": PUBLIC_CACHE })
      },
    )
}
