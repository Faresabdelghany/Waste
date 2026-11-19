// The sidebar's Search (#648): the pages a person can open and the records the
// store holds for them, matched as they type. The store answers only what the
// person's role views, so the search finds nothing else; it reads no API.
import { WORKSPACE_KEYS } from "@waste/domain/access/modules"
import { WORKSPACES, type ModuleLocation, type ModuleSpec } from "@/lib/modules/manifest"
import type { BusinessRecord } from "./business-modules"
import { workspaceHref } from "./workspace-href"

/** A module the search reads: where it is, what its records are called, its rows, and the page a record opens on where not its workspace's (a provider's own). */
export type SearchSource = { location: ModuleLocation; label: string; records: readonly BusinessRecord[]; page?: string }

export type SearchHit = { id: string; title: string; detail: string; group: string; href: string }

/** A page of the sidebar, found by its name. */
export type SearchPage = { label: string; href: string }

/** The shortest query searched: one letter matches too much to be read. */
export const SEARCH_MIN_LENGTH = 2

const terms = (query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean)

/** How well a record's name answers the query, lower first; null where the record does not answer every term. */
function rankOf(record: BusinessRecord, words: readonly string[]): number | null {
  const name = record.name.toLowerCase()
  const rest = [record.context, record.value, ...Object.values(record.facts ?? {})].filter((text): text is string => typeof text === "string").join(" \u0000 ").toLowerCase()
  if (!words.every((word) => name.includes(word) || rest.includes(word))) return null
  const query = words.join(" ")
  if (name.startsWith(query)) return 0
  if (name.split(/[\s·,()-]+/).some((part) => part.startsWith(words[0]))) return 1
  if (words.every((word) => name.includes(word))) return 2
  return 3
}

/**
 * The records that answer every word of `query`, in any of their name,
 * context, value or facts: those whose name begins with it first, then a word
 * of the name, then the name holding it, then the rest, each in its sources'
 * order. Nothing for a query shorter than `SEARCH_MIN_LENGTH`.
 */
export function searchRecords(sources: readonly SearchSource[], query: string, { limit = 20 }: { limit?: number } = {}): SearchHit[] {
  const words = terms(query)
  if (words.join(" ").length < SEARCH_MIN_LENGTH) return []
  const ranked: { hit: SearchHit; rank: number; order: number }[] = []
  let order = 0
  for (const source of sources) {
    for (const record of source.records) {
      const rank = rankOf(record, words)
      order += 1
      if (rank === null) continue
      ranked.push({
        rank,
        order,
        hit: {
          id: `${source.location.workspaceId}.${source.location.moduleId}:${record.id}`,
          title: record.name,
          detail: [record.context, record.status].filter(Boolean).join(" · "),
          group: source.label,
          href: workspaceHref(source.location, record.id, source.page === undefined ? {} : { page: source.page }),
        },
      })
    }
  }
  return ranked
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .slice(0, limit)
    .map(({ hit }) => hit)
}

/** The pages whose name holds the query; all of them for an empty one, so the field opens on where a person can go. */
export function searchPages(pages: readonly SearchPage[], query: string): SearchPage[] {
  const words = terms(query)
  return pages.filter((page) => words.every((word) => page.label.toLowerCase().includes(word)))
}

/** A module the search can open a record of: shown in its workspace or in Settings, never the Driver App or a module shown inside another. */
const searchable = (spec: ModuleSpec) => spec.shown !== "app" && spec.shown !== "elsewhere"

/**
 * Workspaces with no page a record opens on: Improve's address is the
 * Dashboard's (`app/improve` redirects to `/performance`, #646), which opens
 * no record.
 */
const NO_RECORD_PAGE: ReadonlySet<string> = new Set(["improve"])

/**
 * Every module the office's search reads, labelled by its title, in the
 * manifest's order: those of the workspaces the sidebar lists and of Settings
 * (`WORKSPACE_KEYS`), so a record always opens on a page the sidebar leads to.
 */
export function officeSearchModules(): { location: ModuleLocation; label: string }[] {
  return WORKSPACE_KEYS.filter((workspaceId) => !NO_RECORD_PAGE.has(workspaceId)).flatMap((workspaceId) =>
    Object.entries(WORKSPACES[workspaceId].modules as Record<string, ModuleSpec>)
      .filter(([, spec]) => searchable(spec))
      .map(([moduleId, spec]) => ({ location: { workspaceId, moduleId } as ModuleLocation, label: spec.title })),
  )
}
