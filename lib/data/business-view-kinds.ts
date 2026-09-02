/**
 * Module view-kind rules for `BusinessWorkspace`: which workspace modules
 * render as the triage queue (task rows), which get the rich record view
 * (table with configurable fact columns and grouping, list/board/timeline
 * layouts, row-level edit/delete actions), and how each rich module's table
 * behaves — seeded fact columns, fact labels offered as extra columns, and
 * whether generic row actions are exposed.
 *
 * These rules depend on the module alone, never on the viewing persona:
 * since 2026-09-03 the operator's Tickets page and the service provider
 * workspace's Tickets page render the same rich record table. Persona
 * scoping (which records, which grants) stays in the workspace component.
 */
import type { BusinessRecord } from "./business-modules"

export type BusinessModuleViewKind = "queue" | "rich" | "standard"

/** How one rich module's record table behaves. */
export type RichModuleTable = {
  /** Fact columns seeded into view options when the module opens. */
  seededFactColumns: readonly string[]
  /**
   * Facts the table already renders another way (dedicated or derived
   * columns, the title/description cell), so they are never offered again.
   */
  excludedColumnFacts?: ReadonlySet<string>
  /** False when the table has a fixed column set and offers no extra facts. */
  offersFactColumns?: boolean
  /**
   * False when records are worked through their own lifecycle transitions
   * and details view rather than generic row Edit/Delete.
   */
  rowActions?: boolean
}

/** Modules rendered as the operator's triage queue of task rows. */
export const QUEUE_MODULE_IDS: ReadonlySet<string> = new Set(["exceptions"])

/**
 * Rich-view modules and their table behaviour. Membership alone unlocks the
 * rich layouts, so an entry seeding no columns is still meaningful.
 */
export const RICH_MODULE_TABLES: Readonly<Record<string, RichModuleTable>> = {
  routes: {
    seededFactColumns: ["Vehicle", "Driver"],
    // Project and Area are dedicated table columns.
    excludedColumnFacts: new Set(["Project", "Area"]),
  },
  // Schemes default to the five artboard-1 columns (issue #30, D15) —
  // Recurrence and Collection calendar render as derived cells, so no fact
  // columns are seeded; users can still add others via view options.
  schemes: {
    seededFactColumns: [],
    // Offering the stored display facts beside the derived columns would put
    // a stale duplicate next to the derived truth.
    excludedColumnFacts: new Set(["Recurrence", "Collection calendar", "Planning area"]),
  },
  pickups: {
    seededFactColumns: ["Address", "Container ID", "Container Type", "Waste fraction", "Weight"],
  },
  weights: { seededFactColumns: ["Gross", "Tare", "Difference"] },
  products: {
    seededFactColumns: [
      "Type",
      "Container",
      "Container type",
      "Customer",
      "Waste fraction",
      "VAT",
      "Variations",
      "Price list",
    ],
  },
  // Row-level Actions (generic edit/delete) are gated on rich-view
  // membership; price rows need the edit path for the schedule-a-change
  // flow, so they join the rich view like products did.
  "price-rows": {
    seededFactColumns: [
      "Zone",
      "Customer type",
      "Container type",
      "Waste fraction",
      "Negotiated customer",
      "Price list",
      "Effective from",
    ],
  },
  // Fleet resources are self-managed by service provider managers, so both
  // need the rich view's edit and delete paths.
  vehicles: { seededFactColumns: ["Ownership", "Capacity", "Fractions", "Fuel"] },
  drivers: { seededFactColumns: ["Licence", "AppAccess", "Employer"] },
  // Service provider users render Full name, Email, Phone number, Role,
  // Status and Updated as a fixed column set; membership still unlocks
  // edit/delete.
  "service-provider-workspace": { seededFactColumns: [], offersFactColumns: false },
  // Tickets render as the rich record table for every persona — the
  // operator's queue list was retired so /tickets matches the service
  // provider workspace. They are worked through lifecycle transitions and
  // the ticket details view, so no generic row Edit/Delete.
  tickets: {
    seededFactColumns: ["Type", "Priority", "Team"],
    // Form fields that duplicate the title/description cell or hold long
    // free text.
    excludedColumnFacts: new Set([
      "Subject",
      "Case description",
      "Attachments",
      "Attachment references",
      "All linked records and content visibility were checked",
    ]),
    rowActions: false,
  },
}

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

export function resolveModuleViewKind(moduleId: string): BusinessModuleViewKind {
  if (QUEUE_MODULE_IDS.has(moduleId)) return "queue"
  if (moduleId in RICH_MODULE_TABLES) return "rich"
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
  return [...(RICH_MODULE_TABLES[moduleId]?.seededFactColumns ?? fallback)]
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
  const table = RICH_MODULE_TABLES[moduleId]
  if (!table || QUEUE_MODULE_IDS.has(moduleId)) return []
  if (table.offersFactColumns === false) return []
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
export function moduleOffersRowActions(moduleId: string): boolean {
  if (resolveModuleViewKind(moduleId) !== "rich") return false
  return RICH_MODULE_TABLES[moduleId]?.rowActions !== false
}
