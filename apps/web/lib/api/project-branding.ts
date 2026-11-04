// A project's branding on the wire (M22 of #293): written whole through
// `PUT /projects/:id/branding`, under `edit` on `configure.portals`, and read
// back with the project. The contract is a type here; a runtime zod import
// would land in every workspace route's bundle.
import type { ProjectBranding } from "@waste/contracts/organisation"

import { put, type ApiClient } from "./client"

/** The module whose `edit` writes a project's branding. */
export const BRANDING_MODULE = "configure.portals"

/** Replaces the project's branding whole; answers it as it now stands. */
export function replaceBranding(client: ApiClient, projectServerId: string, branding: ProjectBranding): Promise<ProjectBranding> {
  return put<ProjectBranding>(client, `/projects/${encodeURIComponent(projectServerId)}/branding`, branding)
}
