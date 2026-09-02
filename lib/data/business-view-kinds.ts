/**
 * Module view-kind rules for `BusinessWorkspace`: which workspace modules
 * render as the triage queue (task rows), which get the rich record view
 * (table with configurable fact columns and grouping, list/board/timeline
 * layouts, row-level edit/delete actions), and which fact labels a rich
 * module seeds and offers as table columns.
 *
 * These rules depend on the module alone, never on the viewing persona:
 * since 2026-09-03 the operator's Tickets page and the service provider
 * workspace's Tickets page render the same rich record table. Persona
 * scoping (which records, which grants) stays in the workspace component.
 */
import type { BusinessRecord } from "./business-modules"

export type BusinessModuleViewKind = "queue" | "rich" | "standard"

/** Modules rendered as the operator's triage queue of task rows. */
export const QUEUE_MODULE_IDS: ReadonlySet<string> = new Set(["exceptions"])

/**
 * Rich-view modules and the fact columns seeded when the module opens.
 * Membership alone unlocks the rich layouts and row actions, so an entry
 * with an empty array is still meaningful.
 */
export const RICH_VIEW_FACT_COLUMN_DEFAULTS: Readonly<
  Record<string, readonly string[]>
> = {
  routes: ["Vehicle", "Driver"],
  // Schemes default to the five artboard-1 columns (issue #30, D15) —
  // Recurrence and Collection calendar render as derived cells, so no fact
  // columns are seeded; users can still add them via view options.
  schemes: [],
  pickups: ["Address", "Container ID", "Container Type", "Waste fraction", "Weight"],
  weights: ["Gross", "Tare", "Difference"],
  products: [
    "Type",
    "Container",
    "Container type",
    "Customer",
    "Waste fraction",
    "VAT",
    "Variations",
    "Price list",
  ],
  // Row-level Actions (generic edit/delete) are gated on rich-view
  // membership; price rows need the edit path for the schedule-a-change
  // flow, so they join the rich view like products did.
  "price-rows": [
    "Zone",
    "Customer type",
    "Container type",
    "Waste fraction",
    "Negotiated customer",
    "Price list",
    "Effective from",
  ],
  // Fleet resources are self-managed by service provider managers, so both
  // need the rich view's edit and delete paths.
  vehicles: ["Ownership", "Capacity", "Fractions", "Fuel"],
  drivers: ["Licence", "AppAccess", "Employer"],
  // Service provider users render Email and Role as dedicated table columns,
  // so no fact columns are seeded; membership still unlocks edit/delete.
  "service-provider-workspace": [],
  // Tickets render as the rich record table for every persona — the
  // operator's queue list was retired so /tickets matches the service
  // provider workspace.
  tickets: ["Type", "Priority", "Team"],
}

/** Governance facts are shown in record details, never offered as table columns. */
export const EXCLUDED_COLUMN_FACTS: ReadonlySet<string> = new Set([
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

/**
 * Per-module facts that are never offered as extra columns because the
 * table already renders them another way.
 */
const MODULE_EXCLUDED_COLUMN_FACTS: Readonly<Record<string, ReadonlySet<string>>> = {
  // Routes render Project and Area as dedicated table columns.
  routes: new Set(["Project", "Area"]),
  // The schemes table renders these as derived dedicated columns (issue #30,
  // D15); offering the stored display facts again would put a stale
  // duplicate beside the derived truth.
  schemes: new Set(["Recurrence", "Collection calendar", "Planning area"]),
  // Ticket facts written from form fields that duplicate the table's own
  // columns (subject/description) or hold long free text.
  tickets: new Set([
    "Subject",
    "Case description",
    "Attachments",
    "Attachment references",
    "All linked records and content visibility were checked",
  ]),
}

/**
 * Rich modules whose table shows a fixed column set, so no extra fact
 * columns are offered at all (service provider users: Full name, Email,
 * Phone number, Role, Status, Updated).
 */
const FIXED_COLUMN_MODULE_IDS: ReadonlySet<string> = new Set([
  "service-provider-workspace",
])

export function resolveModuleViewKind(moduleId: string): BusinessModuleViewKind {
  if (QUEUE_MODULE_IDS.has(moduleId)) return "queue"
  if (moduleId in RICH_VIEW_FACT_COLUMN_DEFAULTS) return "rich"
  return "standard"
}

/**
 * The fact columns seeded into view options when `moduleId` opens; `fallback`
 * applies to modules outside the rich registry. Always a fresh array so
 * callers can mutate view state without touching the registry.
 */
export function defaultFactColumns(
  moduleId: string,
  fallback: readonly string[],
): string[] {
  return [...(RICH_VIEW_FACT_COLUMN_DEFAULTS[moduleId] ?? fallback)]
}

/**
 * The fact labels a rich module offers as optional table columns, collected
 * from the visible records in first-seen order with governance and
 * module-specific exclusions applied. Non-rich and fixed-column modules
 * offer none.
 */
export function collectFactColumnOptions(
  moduleId: string,
  records: readonly Pick<BusinessRecord, "facts">[],
): string[] {
  if (resolveModuleViewKind(moduleId) !== "rich") return []
  if (FIXED_COLUMN_MODULE_IDS.has(moduleId)) return []
  const moduleExcluded = MODULE_EXCLUDED_COLUMN_FACTS[moduleId]
  const labels: string[] = []
  for (const record of records) {
    for (const label of Object.keys(record.facts)) {
      if (EXCLUDED_COLUMN_FACTS.has(label)) continue
      if (moduleExcluded?.has(label)) continue
      if (!labels.includes(label)) labels.push(label)
    }
  }
  return labels
}
