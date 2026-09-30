/**
 * The address bar's module as a workspace applies it. WorkspaceQuerySync
 * asks again whenever the records it resolves a deep link through change —
 * every write and every switched module landing from the API — and applying
 * a module resets the search and the filters and closes the create dialog,
 * so only a module that is news, not the one applied last, is applied.
 * `record` notes a module applied another way (a tab click), so the address
 * bar catching up with it changes nothing and going Back is news again.
 */
export type ModuleSync = {
  /** Whether the module is news; when it is, it is now the one applied last. */
  apply: (moduleId: string) => boolean
  /** A module applied outside the address bar. */
  record: (moduleId: string) => void
}

export function createModuleSync(): ModuleSync {
  let last: string | null = null
  return {
    apply: (moduleId) => {
      if (moduleId === last) return false
      last = moduleId
      return true
    },
    record: (moduleId) => {
      last = moduleId
    },
  }
}
