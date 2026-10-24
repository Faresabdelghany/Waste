// The public door's routes (Issue #293, ADR-0010): what anyone may read of a
// project that publishes itself, with no token. `GET /public/:slug` names the
// project as its public pages do, and `GET /public/:slug/sorting-guide?q=`
// answers a resident's search of its Sorting Guide. Every one runs behind
// `publicDoor` (auth/public-door.ts): counted against the client's minute,
// then read as the public role, whose column grants and policies are what
// bound the answer — a draft item, another project's or another company's is
// a row this transaction cannot see, whatever the statement says.
//
// The search ranks in memory (`@waste/domain/sorting-guide/search`) over the
// project's published items, which number in the hundreds. An answer may be
// cached by whoever asks for a minute: a change the office publishes reaches
// the public within that.
import { PublicSlugParam, PublishedProject } from "@waste/contracts/public"
import { SortingGuideAnswer, SortingGuideSearch, type SortingGuideMatch } from "@waste/contracts/sorting-guide"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { sortingGuideItem } from "@waste/db/schema/sorting-guide"
import { searchGuide } from "@waste/domain/sorting-guide/search"
import { PUBLISHED_ITEM } from "@waste/domain/sorting-guide/vocabulary"
import { and, eq } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import type { PublicEnv } from "../auth/public-door"
import { describeProblem, validate } from "../problem"
import { describeJson } from "./shared"

/** How long anyone may keep a public answer: a minute, so a published change shows within one. */
export const PUBLIC_CACHE = "public, max-age=60"

const NOT_PUBLISHED = "No project is published under that slug: it was never published, or it has been unpublished."
const TOO_MANY = "This address has asked more than its allowance for the minute; ask again after the seconds Retry-After names."

export function publicRoutes(door: MiddlewareHandler<PublicEnv>) {
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
          "The published items of the project's sorting guide that `q` finds, best first: an exact name, then a compound typed as words (`pizza bakke` finds `Pizzabakke`), the start of the name or of a later word, the query anywhere inside it, and a typo or two in a longer word. Each synonym is searched like the name and ranks just below it; `matched` says which spelling matched. The Danish letters match their two-letter spellings (`aal` finds `Ål`). `limit` is 1..20 and defaults to 10. A query of punctuation alone finds nothing. No token is needed; each address has an allowance a minute. The answer may be cached for a minute.",
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
        const body: SortingGuideAnswer = { query: q, matches }
        return c.json(body, 200, { "Cache-Control": PUBLIC_CACHE })
      },
    )
}
