// What a module of the office is, as the web knows it: one spec per
// `ModuleKey`, written in its workspace's file beside the others of that
// workspace (operate.ts … configure.ts) and gathered by manifest.ts. A
// workspace's file must spell exactly the domain's keys of that workspace
// (`ModuleIdOf`), so a module added to `MODULE_KEYS` is a compile error here
// until it is placed, and a module named here that the domain does not hold
// is one too. The order a workspace's file writes its modules in is the
// order its page offers them.
import type { WorkspaceKey } from "@waste/domain/access/modules"

import type { SettingsPaneId } from "@/lib/data/settings-panes"
import type { BusinessRecord } from "@/lib/prototype/prototype-record"

import type { ModuleIdOf, WorkspaceId } from "./keys"

/**
 * Where the office shows a module: a tab of its workspace's page, under the
 * page's More, a surface of its own and not its workspace's page (the module's
 * `deepLink`: the Driver App, the citizen portal, a provider's own
 * workspace, Control Center), or a Settings pane — `default` for a module
 * whose pane is gone, which opens Settings where it opens.
 */
export type ModulePlacement = "tab" | "more" | "elsewhere" | { readonly pane: SettingsPaneId | "default" }

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
}

/**
 * How a module's list renders: the operator's triage queue of task rows, or
 * the rich record view (a table with configurable fact columns and grouping,
 * list/board/timeline layouts, row-level edit/delete actions). A module
 * naming neither has the standard list.
 */
export type ModuleView = "queue" | RichModuleTable

export type ModuleSpec = {
  shown: ModulePlacement
  /** False for a module the form registry holds no schema for: a Settings pane's own forms, or a surface's. */
  form?: false
  /** The service provider's workspace page it is shown on, besides the office's. */
  providerPage?: ProviderPageId
  view?: ModuleView
  label: string
  title: string
  description: string
  entityLabel: string
  contextLabel: string
  valueLabel: string
  primaryAction: string
  /** The surface of its own a module shown `elsewhere` opens: its workspace offers a link there. */
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
