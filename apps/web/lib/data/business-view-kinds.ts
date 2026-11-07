/**
 * How `BusinessWorkspace` renders a module's list, read off the module's
 * `view` in the manifest (lib/modules): the triage queue (task rows), the rich
 * record view (table with configurable fact columns and grouping,
 * list/board/timeline layouts, row-level edit/delete actions), or the
 * standard list — and how each rich module's table behaves.
 *
 * These rules depend on the module alone, never on the viewing persona:
 * since 2026-09-03 the operator's Tickets page and the service provider
 * workspace's Tickets page render the same rich record table. Persona
 * scoping (which records, which grants) stays in the workspace component.
 */
import type { ModuleSpec, RichModuleTable } from "@/lib/modules/manifest"

import type { BusinessRecord } from "./business-modules"

export type BusinessModuleViewKind = "queue" | "rich" | "standard"

/** What these rules read of a module: its view. */
type Viewed = Pick<ModuleSpec, "view">

/** Governance facts are shown in record details, never offered as table columns. */
const GOVERNANCE_COLUMN_FACTS: ReadonlySet<string> = new Set([
  "Scope",
  "Record kind",
  "Execution policy",
  "Submitted by",
  "Last controlled action",
  "Action reason",
  "Action actor",
  "Effective date",
  "Registry visibility",
  "Deletion reason",
  "Deleted by",
])

/** A rich module's table; none for a queue or a standard list. */
function richTable({ view }: Viewed): RichModuleTable | undefined {
  return view === undefined || view === "queue" ? undefined : view
}

export function resolveModuleViewKind(module: Viewed): BusinessModuleViewKind {
  if (module.view === "queue") return "queue"
  return richTable(module) === undefined ? "standard" : "rich"
}

/**
 * The fact columns seeded into view options when the module opens; `fallback`
 * applies to a module that is not rich. Always a fresh array so callers can
 * mutate view state without touching the manifest.
 */
export function defaultFactColumns(module: Viewed, fallback: readonly string[]): string[] {
  return [...(richTable(module)?.seededFactColumns ?? fallback)]
}

/**
 * The fact labels a rich module offers as optional table columns, collected
 * from the visible records in first-seen order with governance and
 * module-specific exclusions applied. Non-rich and fixed-column modules
 * offer none.
 */
export function collectFactColumnOptions(
  module: Viewed,
  records: readonly Pick<BusinessRecord, "facts">[],
): string[] {
  const table = richTable(module)
  if (!table || table.offersFactColumns === false) return []
  const labels: string[] = []
  for (const record of records) {
    for (const label of Object.keys(record.facts)) {
      if (GOVERNANCE_COLUMN_FACTS.has(label)) continue
      if (table.excludedColumnFacts?.has(label)) continue
      if (!labels.includes(label)) labels.push(label)
    }
  }
  return labels
}

/**
 * Whether a module's records expose generic row Edit/Delete (subject to the
 * viewer's grants and the module's form execution policy, resolved by the
 * workspace component).
 */
export function moduleOffersRowActions(module: Viewed): boolean {
  const table = richTable(module)
  return table !== undefined && table.rowActions !== false
}
