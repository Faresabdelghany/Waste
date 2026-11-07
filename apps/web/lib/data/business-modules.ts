import { WORKSPACES, type ModuleLocation, type ModuleSpec, type WorkspaceId } from "@/lib/modules/manifest"
import type { BusinessRecord } from "@/lib/prototype/prototype-record"

// The registry of workspaces and modules as the workspace renders them: each
// module as the module manifest (lib/modules/manifest.ts) specifies it, under
// its id. The prototype record model is the web's
// (lib/prototype/prototype-record.ts), re-exported here with the manifest's
// names so the web's imports of them did not have to change.
export type { BusinessRecord }
export type { ModuleLocation, WorkspaceId } from "@/lib/modules/manifest"
export { FIXTURE_PROJECT_IDS, FIXTURE_SERVICE_PROVIDER_IDS } from "@/lib/modules/fixture-records"

export type ModuleDefinition = ModuleSpec & { id: string }

export type WorkspaceDefinition = {
  id: WorkspaceId
  label: string
  description: string
  modules: ModuleDefinition[]
}

export const businessWorkspaces = Object.fromEntries(
  Object.values(WORKSPACES).map((workspace) => [
    workspace.id,
    {
      id: workspace.id,
      label: workspace.label,
      description: workspace.description,
      modules: Object.entries(workspace.modules).map(([id, spec]) => ({ id, ...spec })),
    },
  ]),
) as Record<WorkspaceId, WorkspaceDefinition>

export function getWorkspaceDefinition(id: WorkspaceId): WorkspaceDefinition {
  return businessWorkspaces[id]
}

export function getModuleDefinition({
  workspaceId,
  moduleId,
}: ModuleLocation): ModuleDefinition | undefined {
  return businessWorkspaces[workspaceId].modules.find(
    (module) => module.id === moduleId,
  )
}
