// What a module of the office is, as the web knows it: one spec per
// `ModuleKey`, written in its workspace's file beside the others of that
// workspace (operate.ts … configure.ts) and gathered by manifest.ts. A
// workspace's file must spell exactly the domain's keys of that workspace
// (`ModuleIdOf`), so a module added to `MODULE_KEYS` is a compile error here
// until it is placed, and a module named here that the domain does not hold
// is one too. The order a workspace's file writes its modules in is the
// order its page offers them.
import type { WorkspaceKey } from "@waste/domain/access/modules"

import type { SettingsAddress, SettingsPaneId } from "@/lib/modules/settings-panes"
import type { BusinessRecord } from "@/lib/prototype/prototype-record"

import type { ModuleIdOf, WorkspaceId } from "./keys"

/**
 * Where the office shows a module: a tab of its workspace's page, under the
 * page's More, a surface of its own and not its workspace's page (the module's
 * `deepLink`: the citizen portal, a provider's own workspace, Control Center),
 * an app of its own, which its records open too (the Driver App's
 * `deepLink`), or a Settings pane — `default` for a module whose pane is gone,
 * which opens Settings where it opens. A pane's module whose records are kept
 * on other panes by their kind names where a record opens (`opens`).
 */
export type ModulePlacement =
  | "tab"
  | "more"
  | "elsewhere"
  | "app"
  | { readonly pane: SettingsPaneId | "default"; readonly opens?: (recordId: string) => SettingsAddress }

/** A page of the service provider's own workspace (`/service-provider-workspace/<page>`). */
export type ProviderPageId = "routes" | "fleet" | "tickets" | "activities" | "team"

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
  /** The facts the rows may be grouped by besides their status and their fact columns. */
  groupBy?: readonly string[]
  /** The view options list the fact columns as the table draws them, not as chips. */
  columnsShown?: "display"
}

/**
 * How a module's list renders: the operator's triage queue of task rows, or
 * the rich record view (a table with configurable fact columns and grouping,
 * list/board/timeline layouts, row-level edit/delete actions). A module
 * naming neither has the standard list.
 */
export type ModuleView = "queue" | RichModuleTable

/**
 * A module's list where it is laid out its own way: Map Planning's map in
 * place of a list, the containers' asset register, the routes' (a star that
 * pins a route day, Project and Area columns), a provider's accounts (Full
 * name, Email, Phone number, Role), the schemes' and the calendars' rows
 * derived from their typed values, and the vehicle plan's timeline.
 */
export type ModuleLayout = "map-planning" | "containers" | "routes" | "accounts" | "schemes" | "calendars" | "allocations"

/** What a record of the module opens as, in place of its details sheet. */
export type ModuleDetails = "scheme-page" | "route-page" | "provider-page" | "ticket-dialog"

/**
 * How the generic form's write is shaped for the module beyond the record it
 * derives: a route's system-issued name and its generation keys, a scheme's
 * draft, edit policy and licence rule, a container's issued name, and an
 * account's name from its parts and its provider's stamps.
 */
export type ModuleWrites = "route" | "scheme" | "container" | "account"

/** The categories the module's filter offers where they are not the default ones. */
export type ModuleFilters = "containers" | "service-providers" | "service-provider-users" | "tickets"

/** How a form shown to a service provider's own account differs from the office's. */
export type ProviderForm = {
  description: string
  /** The fields the account's own scope answers, which the form does not ask. */
  hides: readonly string[]
  /** A field of references the account uploads instead, as its Attachments. */
  uploads?: string
}

/** How a form's picker offers the module's rows, where it is not every row of the project. */
export type ModulePicked = {
  /** Whether a field of that id is offered the row. */
  offers?: (fieldId: string, record: BusinessRecord) => boolean
  /** The label the row is offered under. */
  label?: (record: BusinessRecord) => string
  /** The name a fact gives the row once picked. */
  named?: (record: BusinessRecord) => string
}

export type ModuleSpec = {
  shown: ModulePlacement
  /** False for a module the form registry holds no schema for: a Settings pane's own forms, or a surface's. */
  form?: false
  /** The service provider's workspace page it is shown on, besides the office's. */
  providerPage?: ProviderPageId
  view?: ModuleView
  layout?: ModuleLayout
  details?: ModuleDetails
  writes?: ModuleWrites
  filters?: ModuleFilters
  /** Its rows are a party's own (a provider's fleet, routes, awards, money): a provider's scope offers its own alone, never the unattributed ones. */
  providerOperated?: true
  /** Its form as a service provider's account is shown it. */
  providerForm?: ProviderForm
  picked?: ModulePicked
  /** A receive, transfer, reserve, adjust, release or issue appends a movement to its ledger rather than changing the row. */
  movements?: true
  /** What deleting a row of it also does, said in the delete dialog. */
  deletes?: string
  label: string
  title: string
  description: string
  entityLabel: string
  contextLabel: string
  valueLabel: string
  primaryAction: string
  /** The surface of its own a module shown `elsewhere` or as an `app` opens: its workspace offers a link there. */
  deepLink?: string
  /** The fixture records of a module still on the browser's path; a switched module has none. */
  records?: BusinessRecord[]
  lifecycle: string[]
  rules: string[]
}

/** Where a workspace's page is: Configure has none, its modules being Settings'. */
export type WorkspacePath<W extends WorkspaceId> = W extends "configure" ? { readonly path?: undefined } : { readonly path: string }

export type WorkspaceSpec<W extends WorkspaceKey> = {
  label: string
  description: string
  /** The other pages that show the workspace, besides its own (`/routes` opens Route Studio on its routes). */
  alsoAt?: readonly string[]
  modules: { readonly [Module in ModuleIdOf<W>]: ModuleSpec }
} & WorkspacePath<W>

/** A workspace's spec, named by its key. */
export function workspaceSpec<W extends WorkspaceKey>(id: W, spec: WorkspaceSpec<W>): WorkspaceSpec<W> & { id: W } {
  return { id, ...spec }
}
