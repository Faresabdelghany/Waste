import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { BusinessWorkspace } from "@/components/wastehero/business-workspace"
import { ServiceProviderDashboard } from "@/components/wastehero/service-provider-dashboard"
import {
  RestrictedPersonaSidebar,
  type RestrictedPersona,
} from "@/components/wastehero/restricted-persona-sidebar"
import {
  FIXTURE_SERVICE_PROVIDER_IDS,
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
  /** Every record and relation option is isolated to this service provider. */
  serviceProviderScopeId?: string
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
  "service-provider": {
    fixedProjectScope: "copenhagen",
    fixedScopeLabel: "NordRen ApS · CA-Ø-2",
    serviceProviderScopeId: FIXTURE_SERVICE_PROVIDER_IDS.nordren,
    permissionsRoleId: "role-service-provider-manager",
    actorName: "Lars Mikkelsen",
    pages: [
      {
        id: "routes",
        workspaceId: "route-studio",
        moduleId: "routes",
        moduleIds: ["routes", "pickups"],
        workspaceLabel: "Routes",
        workspaceDescription:
          "NordRen ApS route days and their generated Pickups — read-only.",
        navigationBasePath: "/service-provider-workspace/routes",
        showWorkspaceActions: true,
        showFilters: true,
      },
      {
        id: "fleet",
        workspaceId: "fleet",
        moduleId: "vehicles",
        moduleIds: ["vehicles", "drivers"],
        workspaceLabel: "Fleet",
        workspaceDescription:
          "NordRen ApS vehicles and drivers — fully self-managed.",
        navigationBasePath: "/service-provider-workspace/fleet",
        showWorkspaceActions: true,
        showFilters: true,
      },
      {
        id: "tickets",
        workspaceId: "operate",
        moduleId: "tickets",
        moduleIds: ["tickets"],
        workspaceLabel: "Tickets",
        workspaceDescription:
          "Tickets on NordRen ApS work — raise new ones for the office to resolve.",
        navigationBasePath: "/service-provider-workspace/tickets",
        showWorkspaceActions: true,
        showFilters: true,
      },
      {
        id: "team",
        workspaceId: "service-providers",
        moduleId: "service-provider-workspace",
        moduleIds: ["service-provider-workspace"],
        workspaceLabel: "Team",
        workspaceDescription:
          "NordRen ApS workspace users — invite managers, foremen, and drivers.",
        navigationBasePath: "/service-provider-workspace/team",
        showWorkspaceActions: true,
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

  // The service provider landing page is a bespoke dashboard, not a module list.
  if (persona === "service-provider" && pageId === "dashboard") {
    return (
      <SidebarProvider>
        <RestrictedPersonaSidebar persona={persona} />
        <SidebarInset>
          <ServiceProviderDashboard />
        </SidebarInset>
      </SidebarProvider>
    )
  }

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
          serviceProviderScopeId={definition.serviceProviderScopeId}
          permissionsRoleId={definition.permissionsRoleId}
          actorName={definition.actorName}
        />
      </SidebarInset>
    </SidebarProvider>
  )
}
