import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { BusinessWorkspace } from "@/components/wastehero/business-workspace"
import {
  RestrictedPersonaSidebar,
  type RestrictedPersona,
} from "@/components/wastehero/restricted-persona-sidebar"
import {
  FIXTURE_CONTRACTOR_IDS,
  type WorkspaceId,
} from "@/lib/data/business-modules"

type RestrictedWorkspacePage = {
  id: string
  workspaceId: WorkspaceId
  moduleId: string
  moduleIds: readonly string[]
  recordIds?: readonly string[]
  workspaceLabel: string
  workspaceDescription: string
  navigationBasePath: string
  showWorkspaceActions: boolean
  showFilters: boolean
}

type RestrictedWorkspaceDefinition = {
  fixedProjectScope: "copenhagen" | "harbor" | "all"
  fixedScopeLabel: string
  /** Every record and relation option is isolated to this contractor. */
  contractorScopeId?: string
  /** Module capabilities resolve from this role's Settings permission matrix. */
  permissionsRoleId?: string
  /** Signed-in identity written to audit events and created records. */
  actorName?: string
  pages: readonly RestrictedWorkspacePage[]
}

const restrictedWorkspaceDefinitions: Record<
  RestrictedPersona,
  RestrictedWorkspaceDefinition
> = {
  citizen: {
    fixedProjectScope: "copenhagen",
    fixedScopeLabel: "Østerbro Housing · Parkvej 18",
    pages: [
      {
        id: "portal",
        workspaceId: "customers",
        moduleId: "citizen-portal",
        moduleIds: ["citizen-portal"],
        recordIds: ["portal-activity-parkvej"],
        workspaceLabel: "Citizen portal",
        workspaceDescription:
          "Authorized property services, collection dates, requests, documents, and messages.",
        navigationBasePath: "/portal",
        showWorkspaceActions: false,
        showFilters: false,
      },
    ],
  },
  contractor: {
    fixedProjectScope: "copenhagen",
    fixedScopeLabel: "NordRen ApS · CA-Ø-2",
    contractorScopeId: FIXTURE_CONTRACTOR_IDS.nordren,
    permissionsRoleId: "role-contractor-manager",
    actorName: "Lars Mikkelsen",
    pages: [
      {
        id: "routes",
        workspaceId: "route-studio",
        moduleId: "routes",
        moduleIds: ["routes"],
        workspaceLabel: "Routes",
        workspaceDescription:
          "NordRen ApS route lists across permitted projects — read-only.",
        navigationBasePath: "/contractor-workspace",
        showWorkspaceActions: true,
        showFilters: false,
      },
      {
        id: "fleet",
        workspaceId: "fleet",
        moduleId: "vehicles",
        moduleIds: ["vehicles", "drivers"],
        workspaceLabel: "Fleet",
        workspaceDescription:
          "NordRen ApS vehicles and drivers — fully self-managed.",
        navigationBasePath: "/contractor-workspace/fleet",
        showWorkspaceActions: true,
        showFilters: false,
      },
      {
        id: "tickets",
        workspaceId: "operate",
        moduleId: "tickets",
        moduleIds: ["tickets"],
        workspaceLabel: "Tickets",
        workspaceDescription:
          "Tickets on NordRen ApS work — raise new ones for the office to resolve.",
        navigationBasePath: "/contractor-workspace/tickets",
        showWorkspaceActions: true,
        showFilters: false,
      },
      {
        id: "team",
        workspaceId: "contractors",
        moduleId: "contractor-workspace",
        moduleIds: ["contractor-workspace"],
        workspaceLabel: "Team",
        workspaceDescription:
          "NordRen ApS workspace users — invite managers, foremen, and drivers.",
        navigationBasePath: "/contractor-workspace/team",
        showWorkspaceActions: true,
        showFilters: false,
      },
    ],
  },
  internal: {
    fixedProjectScope: "all",
    fixedScopeLabel: "WasteHero internal · cross-tenant",
    pages: [
      {
        id: "control-center",
        workspaceId: "control-center",
        moduleId: "control-center",
        moduleIds: ["control-center"],
        workspaceLabel: "WasteHero Control Center",
        workspaceDescription:
          "Internal sales, onboarding, subscriptions, entitlements, and marketplace fulfillment.",
        navigationBasePath: "/control-center",
        showWorkspaceActions: false,
        showFilters: true,
      },
    ],
  },
}

type RestrictedWorkspaceShellProps = {
  persona: RestrictedPersona
  pageId?: string
}

export function RestrictedWorkspaceShell({
  persona,
  pageId,
}: RestrictedWorkspaceShellProps) {
  const definition = restrictedWorkspaceDefinitions[persona]
  const page =
    definition.pages.find((candidate) => candidate.id === pageId) ??
    definition.pages[0]

  return (
    <SidebarProvider>
      <RestrictedPersonaSidebar persona={persona} />
      <SidebarInset>
        <BusinessWorkspace
          workspaceId={page.workspaceId}
          initialModuleId={page.moduleId}
          allowedModuleIds={page.moduleIds}
          allowedRecordIds={page.recordIds}
          workspaceLabel={page.workspaceLabel}
          workspaceDescription={page.workspaceDescription}
          fixedProjectScope={definition.fixedProjectScope}
          fixedScopeLabel={definition.fixedScopeLabel}
          navigationBasePath={page.navigationBasePath}
          showDeepLinks={false}
          showExportAction={false}
          showPrimaryAction={page.showWorkspaceActions}
          showFilters={page.showFilters}
          contractorScopeId={definition.contractorScopeId}
          permissionsRoleId={definition.permissionsRoleId}
          actorName={definition.actorName}
        />
      </SidebarInset>
    </SidebarProvider>
  )
}
