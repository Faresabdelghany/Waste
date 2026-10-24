// The Sorting Guide on the wire (Issue #293, M1): the office's items, and what
// the public door answers a resident's search with (ADR-0010). An item is a
// project's, like every project-scoped resource; its fraction is the
// company's catalogue's. The public answer carries what a resident reads and
// nothing the office alone needs: no status, no stamps, no project id.
import { normalise } from "@waste/domain/sorting-guide/search"
import { SORTING_GUIDE_ITEM_STATUSES } from "@waste/domain/sorting-guide/vocabulary"
import * as z from "zod"

import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { changesSomething, eachOnce, eachOnceSentence, somethingToChange, stamped } from "./resource"
import { Label, Paragraph } from "./text"

export const SortingGuideItemStatus = z.enum(SORTING_GUIDE_ITEM_STATUSES)
export type SortingGuideItemStatus = z.infer<typeof SortingGuideItemStatus>

/** The most other words an item is known by: enough for the spellings people type, few enough to read. */
export const SYNONYMS_MAX = 30

/** The other words an item is known by, each once as the search reads it: `Pizza box` and `pizza box`, or `æske` and `aeske`, are one. */
const Synonyms = z
  .array(Label)
  .max(SYNONYMS_MAX)
  .refine((synonyms) => eachOnce(synonyms, normalise), eachOnceSentence("synonym", "a word is searched once however it is spelled or cased"))

export const SortingGuideItem = z.object({
  ...stamped,
  projectId: Id,
  /** What the resident searches for and reads first: `Pizzabakke`. Unique per project. */
  name: Label,
  synonyms: z.array(Label),
  /** The company's waste fraction it is sorted into; null where it belongs to no collected fraction. */
  wasteFractionId: Id.nullable(),
  /** How to present it: rinsed, flattened, lid off. */
  instructions: Paragraph.nullable(),
  status: SortingGuideItemStatus,
})
export type SortingGuideItem = z.infer<typeof SortingGuideItem>

export const SortingGuideItemCreate = z.strictObject({
  projectId: Id,
  name: Label,
  synonyms: Synonyms.default([]).describe("Defaults to none when absent."),
  wasteFractionId: Id.nullable().optional(),
  instructions: Paragraph.nullable().optional(),
  status: SortingGuideItemStatus.default("draft").describe("Defaults to draft when absent: an item reaches the public door when it is published."),
})
export type SortingGuideItemCreate = z.infer<typeof SortingGuideItemCreate>

/** Everything but the project and the stamps. */
export const SortingGuideItemPatch = z
  .strictObject({
    name: Label.optional(),
    /** The whole list: what is left out is no longer a synonym. */
    synonyms: Synonyms.optional(),
    wasteFractionId: Id.nullable().optional(),
    instructions: Paragraph.nullable().optional(),
    status: SortingGuideItemStatus.optional(),
  })
  .refine(changesSomething, somethingToChange)
export type SortingGuideItemPatch = z.infer<typeof SortingGuideItemPatch>

/** A page of items, from one project and of one status. */
export const SortingGuideItemListQuery = ProjectScopedListQuery.extend({
  status: SortingGuideItemStatus.optional(),
})
export type SortingGuideItemListQuery = z.infer<typeof SortingGuideItemListQuery>

/** The longest search the public door takes: a name, not a paragraph. */
export const SEARCH_MAX = 100
/** The most matches one search answers with, and how many when the query names none. */
export const SEARCH_LIMIT = { max: 20, default: 10 } as const

/** A resident's search: what they typed, and how many matches to answer with. */
export const SortingGuideSearch = z.object({
  q: z.string().min(1).max(SEARCH_MAX),
  limit: z
    .union([z.int(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(z.int().min(1).max(SEARCH_LIMIT.max))
    .default(SEARCH_LIMIT.default),
})
export type SortingGuideSearch = z.infer<typeof SortingGuideSearch>

/** The fraction an answer names: its stable key and its name. */
export const SortingGuideFraction = z.object({ key: Label, name: Label })

/** One item a search found, as a resident reads it: the name and synonym that matched, the fraction and how to present it. */
export const SortingGuideMatch = z.object({
  id: Id,
  name: Label,
  synonyms: z.array(Label),
  /** The name or synonym that matched, as it is written. */
  matched: Label,
  fraction: SortingGuideFraction.nullable(),
  instructions: Paragraph.nullable(),
})
export type SortingGuideMatch = z.infer<typeof SortingGuideMatch>

/** A search's answer: the query as the door read it, and the matches, best first. */
export const SortingGuideAnswer = z.object({
  query: z.string(),
  matches: z.array(SortingGuideMatch),
})
export type SortingGuideAnswer = z.infer<typeof SortingGuideAnswer>
