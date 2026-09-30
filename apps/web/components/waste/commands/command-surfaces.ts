// The command surfaces (Issue #181): how a module switched onto the API is
// operated on the Pilot beyond its own create and edit forms. A status the
// wire moves only by command (a container's asset state, an allocation's
// status) is never an edit, so the module's rows offer their commands here —
// in their details, through the store's `sendCommand` — and a module whose
// create is a command of its own, or which the wire only reads, says so in
// place of the primary action its fixture form had.
//
// The workspace consults this registry in two places, the primary action and
// the details' actions, and only while the adapter is configured and the
// module is switched (`commandSurfaceFor`): fixture mode never reaches it,
// and the fixture forms stand exactly as before. A later slice adds its
// module here rather than another branch in business-workspace.tsx; every
// key is a `SERVER_MODULES` key (lib/api/__tests__/command-surfaces.test.ts).
import type { ComponentType } from "react"

import type { BusinessRecord, WorkspaceId } from "@/lib/data/business-modules"
import { moduleKeyOf } from "@/lib/api/records/adapter"
import { isServerBacked } from "@/lib/api/records/modules"

/** What a primary surface is handed: the label the module's primary action carries. */
export type PrimarySurfaceProps = { label: string }

/** What a row surface is handed: the row whose details are open. */
export type RowSurfaceProps = { record: BusinessRecord }

export type CommandSurface = {
  /**
   * What stands in for the module's primary action on the Pilot: its own
   * create form (`"form"`, the create going through the adapter as ever), a
   * dialog of the module's own, or nothing, for a module the wire only reads.
   * It is offered where the module's fixture form offered its primary action
   * (the workspace's own guard: a create grant and a form schema), so a
   * module with no fixture form offers no primary surface either.
   */
  primary: "form" | ComponentType<PrimarySurfaceProps> | null
  /** The row's commands, and what they read (a ledger, a history), in its details. */
  rowActions?: ComponentType<RowSurfaceProps>
}

/** The surfaces, by `workspace.module`. */
export const COMMAND_SURFACES: Readonly<Record<string, CommandSurface>> = {}

/** The module's surface while the adapter is configured and the module switched; undefined otherwise, and always in fixture mode. */
export function commandSurfaceFor(workspaceId: WorkspaceId, moduleId: string, configured: boolean): CommandSurface | undefined {
  if (!configured || !isServerBacked(workspaceId, moduleId)) return undefined
  return COMMAND_SURFACES[moduleKeyOf(workspaceId, moduleId)]
}
