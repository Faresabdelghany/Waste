// The Sorting Guide in the office (Issue #293, M1): where its records live,
// the record a Settings form writes, the values that form opens with, and the
// public page a published project's guide is read at. Items exist on the API
// alone (`configure.sorting-guide`, lib/api/records/sorting-guide.ts), so
// there are no fixtures, and the pane is offered only with the adapter
// configured (settings-panes.ts).
import { isPublicSlug, PUBLIC_SLUG_LENGTH } from "@waste/domain/access/public-slug"
import { SORTING_GUIDE_ITEM_STATUSES } from "@waste/domain/sorting-guide/vocabulary"

import type { BusinessRecord, ModuleLocation } from "./business-modules"

/** Where Sorting Guide items live: one module, the API's grant key. */
export const SORTING_GUIDE_MODULE: ModuleLocation = { workspaceId: "configure", moduleId: "sorting-guide" }

/** The Settings pane that edits the guide. */
export const SORTING_GUIDE_SETTINGS_PANE_ID = "sorting-guide"

/** The id prefix of an item's record, and the kind it carries. */
export const SORTING_GUIDE_ITEM_PREFIX = "guide-item"
export const SORTING_GUIDE_ITEM_KIND = "Sorting guide item"

/** The statuses an item moves between, the vocabulary's tokens with the label a person reads. */
export const SORTING_GUIDE_STATUSES = SORTING_GUIDE_ITEM_STATUSES.map((token) => ({ token, label: token.charAt(0).toUpperCase() + token.slice(1) }))

/** What the item form holds: the project, the name, the other words as one line, the fraction, the instructions and the status token. */
export type SortingGuideItemForm = {
  projectId: string
  name: string
  synonyms: string
  wasteFractionId: string
  instructions: string
  status: string
}

/** The other words a line says: split on commas and new lines, trimmed, blanks dropped, each once as written. */
export function synonymsOf(line: string): string[] {
  const words = line
    .split(/[,\n]/)
    .map((word) => word.trim())
    .filter((word) => word !== "")
  return words.filter((word, index) => words.findIndex((other) => other.toLowerCase() === word.toLowerCase()) === index)
}

/** The form an item opens with: an existing record's values, or a draft on the project given. */
export function sortingGuideFormOf(record: BusinessRecord | null, projectId: string): SortingGuideItemForm {
  const values = record?.submittedValues ?? {}
  const text = (key: string) => (typeof values[key] === "string" ? (values[key] as string) : "")
  return {
    projectId: record?.projectIds?.[0] ?? projectId,
    name: record?.name ?? "",
    synonyms: text("synonyms"),
    wasteFractionId: text("wasteFractionId"),
    instructions: text("instructions"),
    status: text("status") || "draft",
  }
}

/**
 * The record a form writes: a new item under a web id the store hands back
 * under the server's once it lands, or the record edited. The record says
 * only what the adapter reads (its project, name and submitted values); the
 * rest is the adapter's on the next read.
 */
export function sortingGuideRecordOf(form: SortingGuideItemForm, existing: BusinessRecord | null, now: number): BusinessRecord {
  const status = SORTING_GUIDE_STATUSES.find((candidate) => candidate.token === form.status) ?? { token: "draft", label: "Draft" }
  const synonyms = synonymsOf(form.synonyms)
  const submittedValues: Record<string, string> = {
    name: form.name.trim(),
    synonyms: synonyms.join(", "),
    status: status.token,
  }
  if (form.wasteFractionId !== "") submittedValues.wasteFractionId = form.wasteFractionId
  if (form.instructions.trim() !== "") submittedValues.instructions = form.instructions.trim()
  const base: BusinessRecord = existing ?? {
    id: `${SORTING_GUIDE_ITEM_PREFIX}-${now}`,
    name: "",
    context: "",
    status: "",
    owner: "",
    value: "",
    updated: "Now",
    description: "An item of the project's Sorting Guide.",
    facts: {},
    related: [],
    source: "Settings",
    freshness: "Now",
    recordKind: SORTING_GUIDE_ITEM_KIND,
  }
  return {
    ...base,
    name: form.name.trim(),
    status: status.label,
    projectIds: [form.projectId],
    submittedValues,
  }
}

/** The public page a published project's guide is read at, `/p/<slug>/sorting`. */
export const sortingGuidePathOf = (slug: string): string => `/p/${slug}/sorting`

const FOLDED: Record<string, string> = { æ: "ae", ø: "oe", å: "aa", ä: "ae", ö: "oe", ü: "ue", ß: "ss" }

/** The slug a project's name suggests: lowercase, the Danish letters folded, everything else a single hyphen, at most 63 characters. */
export function slugSuggestionOf(name: string): string {
  return name
    .normalize("NFC")
    .toLowerCase()
    .replace(/[æøåäöüß]/g, (letter) => FOLDED[letter] ?? letter)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, PUBLIC_SLUG_LENGTH.max)
    .replace(/-+$/, "")
}

/** Why a slug will not do, by the domain's rule (`@waste/domain/access/public-slug`), or null when it will. */
export function slugRefusalOf(slug: string): string | null {
  if (isPublicSlug(slug)) return null
  if (slug.length < PUBLIC_SLUG_LENGTH.min || slug.length > PUBLIC_SLUG_LENGTH.max) return `A public address is ${PUBLIC_SLUG_LENGTH.min} to ${PUBLIC_SLUG_LENGTH.max} characters`
  return "Use lowercase letters, digits and single hyphens, such as kystbyen or kystbyen-nord"
}
