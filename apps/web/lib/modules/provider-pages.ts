// The service provider's own workspace (#291 C24): its pages in its sidebar's
// order, each at `/service-provider-workspace/<page>` and showing the modules
// the manifest places on it (`providerPage`). The restricted shell, its
// sidebar and the Active Routes' routes page read them here.
import { providerPageModules } from "./manifest"
import type { ProviderPageId, WorkspaceId } from "./spec"

/** The workspace's own address, which lands on its first page. */
export const PROVIDER_WORKSPACE_PATH = "/service-provider-workspace"

type ProviderPageSpec = {
  id: ProviderPageId
  label: string
  /** Whether the page offers its modules' primary action. */
  showWorkspaceActions: boolean
  /**
   * The primary action on the Pilot, where it differs. A provider's fleet is
   * read there: its vehicle and driver forms name the company's master data
   * and depots, which a provider's role does not read.
   */
  showWorkspaceActionsOnApi?: boolean
}

export type ProviderPage = ProviderPageSpec & {
  path: string
  /** The workspace its modules are of, and its modules' ids in the manifest's order: the first is where the page lands. */
  workspaceId: WorkspaceId
  moduleIds: readonly string[]
}

const PAGES: readonly ProviderPageSpec[] = [
  // Dispatch day and Balance day are the office's: each picks a project's day, and a provider's account works in no project.
  { id: "routes", label: "Routes", showWorkspaceActions: true, showWorkspaceActionsOnApi: false },
  { id: "fleet", label: "Fleet", showWorkspaceActions: true, showWorkspaceActionsOnApi: false },
  { id: "tickets", label: "Tickets", showWorkspaceActions: true },
  { id: "activities", label: "Activities", showWorkspaceActions: true },
  { id: "team", label: "Team", showWorkspaceActions: true },
]

/** Where a page of the provider's workspace is. */
export function providerPagePath(id: ProviderPageId): string {
  return `${PROVIDER_WORKSPACE_PATH}/${id}`
}

export const PROVIDER_PAGES: readonly ProviderPage[] = PAGES.map((page) => {
  const modules = providerPageModules(page.id)
  return { ...page, path: providerPagePath(page.id), workspaceId: modules[0].workspaceId, moduleIds: modules.map((module) => module.moduleId) }
})
