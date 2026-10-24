// The public Sorting Guide page's rules (Issue #293, M1), apart from the page
// so they are tested here: which query the address asks for, and what the
// page shows for each answer the door gives.
import type { PublishedProject } from "@waste/contracts/public"
import type { SortingGuideAnswer, SortingGuideMatch } from "@waste/contracts/sorting-guide"

import type { DoorAnswer } from "./door"

/** The longest query the door takes (the contracts' SEARCH_MAX), spelled again since the web imports the contracts as types only. */
export const SEARCH_MAX = 100

/** The query the address asks for: the first `q`, trimmed and cut to the door's length; null for none or blank. */
export function queryOf(q: string | string[] | undefined): string | null {
  const first = Array.isArray(q) ? q[0] : q
  const trimmed = first?.trim().slice(0, SEARCH_MAX).trim() ?? ""
  return trimmed === "" ? null : trimmed
}

/** What the page shows below the search box. */
export type GuideView = { kind: "prompt" } | { kind: "matches"; query: string; matches: SortingGuideMatch[] } | { kind: "nothing"; query: string }

/** The page: the published project with what its search found, or why there is no page to show. */
export type PageView =
  | { kind: "published"; project: PublishedProject; guide: GuideView }
  | { kind: "not-published" }
  | { kind: "too-many"; retryAfterSeconds: number }
  | { kind: "unavailable" }

/** What the page asked the door: the project alone, or a search, whose answer names the project too — one request either way. */
export type PageAsked = { query: null; answer: DoorAnswer<PublishedProject> } | { query: string; answer: DoorAnswer<SortingGuideAnswer> }

/** The page a door's answer makes. */
export function pageViewOf(asked: PageAsked): PageView {
  const { answer } = asked
  if (answer.kind !== "ok") return answer
  if (asked.query === null) return { kind: "published", project: (answer as { body: PublishedProject }).body, guide: { kind: "prompt" } }
  const { project, matches } = (answer as { body: SortingGuideAnswer }).body
  return { kind: "published", project, guide: matches.length === 0 ? { kind: "nothing", query: asked.query } : { kind: "matches", query: asked.query, matches } }
}
