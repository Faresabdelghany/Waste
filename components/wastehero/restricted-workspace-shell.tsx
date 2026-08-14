import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { BusinessWorkspace } from "@/components/wastehero/business-workspace"
import {
  RestrictedPersonaSidebar,
  type RestrictedPersona,
} from "@/components/wastehero/restricted-persona-sidebar"
import type { WorkspaceId } from "@/lib/data/business-modules"

type RestrictedWorkspaceDefinition = {
  workspaceId: WorkspaceId
  moduleId: string
  moduleIds: readonly string[]
  recordIds?: readonly string[]
  workspaceLabel: string
  workspaceDescription: string
  fixedProjectScope: "copenhagen" | "harbor" | "all"
  fixedScopeLabel: string
  navigationBasePath: string
  showWorkspaceActions: boolean
  showFilters: boolean
}

const restrictedWorkspaceDefinitions: Record<
  RestrictedPersona,
  RestrictedWorkspaceDefinition
> = {
  citizen: {
    workspaceId: "customers",
    moduleId: "citizen-portal",
    moduleIds: ["citizen-portal"],
    recordIds: ["portal-activity-parkvej"],
    workspaceLabel: "Citizen portal",
    workspaceDescription:
      "Authorized property services, collection dates, requests, documents, and messages.",
    fixedProjectScope: "copenhagen",
    fixedScopeLabel: "Østerbro Housing · Parkvej 18",
    navigationBasePath: "/portal",
    showWorkspaceActions: false,
    showFilters: false,
  },
  contractor: {
    workspaceId: "contractors",
    moduleId: "contractor-workspace",
    moduleIds: ["contractor-workspace"],
    recordIds: ["contractor-access-nordren-manager"],
    workspaceLabel: "Contractor workspace",
    workspaceDescription:
      "NordRen operations, permitted users, fleet, routes, proposals, and manager access.",
    fixedProjectScope: "copenhagen",
    fixedScopeLabel: "NordRen ApS · permitted projects",
    navigationBasePath: "/contractor-workspace",
    showWorkspaceActions: false,
    showFilters: false,
  },
  internal: {
    workspaceId: "control-center",
    moduleId: "control-center",
    moduleIds: ["control-center"],
    workspaceLabel: "WasteHero Control Center",
    workspaceDescription:
      "Internal sales, onboarding, subscriptions, entitlements, and marketplace fulfillment.",
    fixedProjectScope: "all",
    fixedScopeLabel: "WasteHero internal · cross-tenant",
    navigationBasePath: "/control-center",
    showWorkspaceActions: false,
    showFilters: true,
  },
}

type RestrictedWorkspaceShellProps = {
  persona: RestrictedPersona
}

export function RestrictedWorkspaceShell({ persona }: RestrictedWorkspaceShellProps) {
  const definition = restrictedWorkspaceDefinitions[persona]

  return (
    <SidebarProvider>
      <RestrictedPersonaSidebar persona={persona} />
      <SidebarInset>
        <BusinessWorkspace
          workspaceId={definition.workspaceId}
          initialModuleId={definition.moduleId}
          allowedModuleIds={definition.moduleIds}
          allowedRecordIds={definition.recordIds}
          workspaceLabel={definition.workspaceLabel}
          workspaceDescription={definition.workspaceDescription}
          fixedProjectScope={definition.fixedProjectScope}
          fixedScopeLabel={definition.fixedScopeLabel}
          navigationBasePath={definition.navigationBasePath}
          showDeepLinks={false}
          showExportAction={definition.showWorkspaceActions}
          showPrimaryAction={definition.showWorkspaceActions}
          showFilters={definition.showFilters}
        />
      </SidebarInset>
    </SidebarProvider>
  )
}
