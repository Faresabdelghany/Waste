// A module named by its key: the workspaces of the registry, a key's two
// halves, and the one way code names a module (`moduleAt`). It knows the
// domain's keys and nothing of the manifest's specs, so what names a module —
// an adapter, a form, a surface — depends on it alone.
import type { ModuleKey, WorkspaceKey } from "@waste/domain/access/modules"

/** Configure's Control Center module again as a workspace of its own, which no page shows: the registry's twin, whose form is the module's. */
export const CONTROL_CENTER = "control-center"

export type WorkspaceId = WorkspaceKey | typeof CONTROL_CENTER

/** A module's id within its workspace: `tickets` of `operate.tickets`. */
export type ModuleIdOf<W extends WorkspaceKey> = ModuleKey extends infer Key ? (Key extends `${W}.${infer Module}` ? Module : never) : never

/** Where a module lives: the `${workspaceId}.${moduleId}` pair every store, link, and relation uses. */
export type ModuleLocation = {
  workspaceId: WorkspaceId
  moduleId: string
}

export const moduleKeyOf = (workspaceId: WorkspaceId, moduleId: string): ModuleKey => `${workspaceId}.${moduleId}` as ModuleKey

export type LocationOf<Key extends ModuleKey> = Key extends `${infer Workspace}.${infer Module}` ? { readonly workspaceId: Workspace; readonly moduleId: Module } : never

export const CONTROL_CENTER_TWIN: { readonly workspaceId: typeof CONTROL_CENTER; readonly moduleId: typeof CONTROL_CENTER } = { workspaceId: CONTROL_CENTER, moduleId: CONTROL_CENTER }

/** A module's location, by its key: the one way a module is named in code, so a key the domain does not hold is a compile error. */
export function moduleAt<Key extends ModuleKey>(key: Key): LocationOf<Key> {
  const dot = key.indexOf(".")
  return { workspaceId: key.slice(0, dot), moduleId: key.slice(dot + 1) } as LocationOf<Key>
}
