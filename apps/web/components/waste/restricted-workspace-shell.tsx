"use client"

// The restricted shells: the citizen portal, and the service provider's
// workspace. In fixture mode both are pinned to their fixture persona —
// NordRen ApS, its fixture role and its actor. On the Pilot the provider's
// is the signed-in account's (#291 C24): its provider and its name from
// `/me`, its role's grants as `/me` answers them, and no pinned project,
// since a provider's account works in none and the API fences every row it
// reads to its provider. Its landing is its routes there, the fixture
// dashboard's figures being the prototype's.
import Link from "next/link"
import { Suspense, useEffect, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { useApiSession } from "@/components/waste/api-session-store"
import { BusinessWorkspace } from "@/components/waste/business-workspace"
import { useProviderWebId, useProviderWorkspace } from "@/components/waste/provider-account"
import { ServiceProviderDashboard } from "@/components/waste/service-provider-dashboard"
import {
  RestrictedPersonaSidebar,
  type RestrictedPersona,
} from "@/components/waste/restricted-persona-sidebar"
import {
  FIXTURE_PROJECT_IDS,
  FIXTURE_SERVICE_PROVIDER_IDS,
  type WorkspaceId,
} from "@/lib/data/business-modules"
import { problemSentence } from "@/lib/api/problem"
import { problemOfError } from "@/lib/api/records/server-records"
import type { RoleAccessMap } from "@/lib/data/role-permissions"
import { ALL_PROJECTS, type ProjectScope } from "@/lib/data/project-scope"
import { NOT_A_PROVIDER_ACCOUNT } from "@/lib/data/provider-workspace"

type RestrictedWorkspacePage = {
  id: string
  workspaceId: WorkspaceId
  moduleId: string
  moduleIds: readonly string[]
  recordIds?: readonly string[]
  workspaceLabel: string
  workspaceDescription: string
  /** The description on the Pilot, naming the account's provider. */
  describeOnApi?: (provider: string) => string
  navigationBasePath: string
  showWorkspaceActions: boolean
  /**
   * The primary action on the Pilot, where it differs. A provider's fleet is
   * read there: its vehicle and driver forms name the company's master data
   * and depots, which a provider's role does not read.
   */
  showWorkspaceActionsOnApi?: boolean
  showFilters: boolean
}

type RestrictedWorkspaceDefinition = {
  /** The project record the persona works in — one of the organisation module's, or every permitted one. */
  fixedProjectScope: ProjectScope
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
    fixedProjectScope: FIXTURE_PROJECT_IDS.copenhagen,
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
    fixedProjectScope: FIXTURE_PROJECT_IDS.copenhagen,
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
        describeOnApi: (provider) => `The routes ${provider} runs and their stops — crew and dispatch them with your own fleet.`,
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
        describeOnApi: (provider) => `${provider}'s vehicles and drivers.`,
        navigationBasePath: "/service-provider-workspace/fleet",
        showWorkspaceActions: true,
        showWorkspaceActionsOnApi: false,
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
        describeOnApi: (provider) => `Tickets about the routes ${provider} runs — raise new ones for the office to resolve.`,
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
        describeOnApi: (provider) => `${provider}'s workspace users — invite managers, foremen and drivers.`,
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

/** What a page of the workspace is scoped by: the fixture persona's, or on the Pilot the account's. */
type WorkspaceScope = {
  fixedProjectScope: ProjectScope
  fixedScopeLabel: string
  serviceProviderScopeId?: string
  permissionsRoleId?: string
  roleGrants?: RoleAccessMap
  actorName?: string
  onApi: boolean
}

function RestrictedFrame({ persona, children }: { persona: RestrictedPersona; children: ReactNode }) {
  return (
    <SidebarProvider>
      <RestrictedPersonaSidebar persona={persona} />
      <SidebarInset>{children}</SidebarInset>
    </SidebarProvider>
  )
}

/**
 * The provider's workspace while `/me` is unread: its read asked for — one
 * in flight per person, shared with the session's own — and a read that
 * failed said in the API's words, with Retry, rather than a placeholder that
 * waits on the session's next change.
 */
function ReadingAccount() {
  const { loadMe } = useApiSession()
  const [attempt, setAttempt] = useState(0)
  const [failed, setFailed] = useState<{ attempt: number; sentence: string } | null>(null)
  useEffect(() => {
    let current = true
    loadMe().catch((error: unknown) => {
      if (current) setFailed({ attempt, sentence: problemSentence(problemOfError(error)) })
    })
    return () => {
      current = false
    }
  }, [attempt, loadMe])
  if (failed === null || failed.attempt !== attempt) return <p className="p-6 text-sm text-muted-foreground">Reading your account…</p>
  return (
    <div className="space-y-3 p-6 text-sm" role="alert">
      <p>Your account could not be read: {failed.sentence}</p>
      <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((count) => count + 1)}>
        Retry
      </Button>
    </div>
  )
}

export function RestrictedWorkspaceShell({
  persona,
  pageId,
}: RestrictedWorkspaceShellProps) {
  const { apiConfigured, me } = useApiSession()
  const definition = restrictedWorkspaceDefinitions[persona]
  const workspace = useProviderWorkspace()
  const provider = persona === "service-provider" ? workspace : null
  const providerWebId = useProviderWebId(provider?.providerId)

  if (persona === "service-provider" && apiConfigured) {
    // `/me` has not answered yet: nothing is shown under another's name.
    if (me === null) {
      return (
        <RestrictedFrame persona={persona}>
          <ReadingAccount />
        </RestrictedFrame>
      )
    }
    if (provider === null) {
      return (
        <RestrictedFrame persona={persona}>
          <div className="space-y-3 p-6 text-sm">
            <p>{NOT_A_PROVIDER_ACCOUNT}</p>
            <Link href="/operate" className="font-medium underline underline-offset-4">
              Go to Operate
            </Link>
          </div>
        </RestrictedFrame>
      )
    }
  }

  // The service provider landing page is a bespoke dashboard, not a module list — in fixture mode; on the Pilot it lands on the routes.
  if (persona === "service-provider" && pageId === "dashboard" && provider === null) {
    return (
      <RestrictedFrame persona={persona}>
        <ServiceProviderDashboard />
      </RestrictedFrame>
    )
  }

  const page =
    definition.pages.find((candidate) => candidate.id === pageId) ??
    definition.pages[0]
  const scope: WorkspaceScope =
    provider === null
      ? {
          fixedProjectScope: definition.fixedProjectScope,
          fixedScopeLabel: definition.fixedScopeLabel,
          serviceProviderScopeId: definition.serviceProviderScopeId,
          permissionsRoleId: definition.permissionsRoleId,
          actorName: definition.actorName,
          onApi: false,
        }
      : {
          fixedProjectScope: ALL_PROJECTS,
          fixedScopeLabel: provider.legalName,
          serviceProviderScopeId: providerWebId,
          roleGrants: provider.access,
          actorName: provider.actorName,
          onApi: true,
        }
  const workspaceDescription = scope.onApi && page.describeOnApi !== undefined ? page.describeOnApi(scope.fixedScopeLabel) : page.workspaceDescription
  const showPrimaryAction = scope.onApi ? page.showWorkspaceActionsOnApi ?? page.showWorkspaceActions : page.showWorkspaceActions

  return (
    <RestrictedFrame persona={persona}>
      {/* Suspense above useSearchParams: under Cache Components the URL is request
          data, so the workspace streams in after the static shell. Keyed by the
          account, so another's sign-in starts the workspace afresh. */}
      <Suspense fallback={null}>
        <BusinessWorkspace
          key={me?.user.id ?? "fixtures"}
          workspaceId={page.workspaceId}
          initialModuleId={page.moduleId}
          allowedModuleIds={page.moduleIds}
          allowedRecordIds={page.recordIds}
          workspaceLabel={page.workspaceLabel}
          workspaceDescription={workspaceDescription}
          fixedProjectScope={scope.fixedProjectScope}
          fixedScopeLabel={scope.fixedScopeLabel}
          navigationBasePath={page.navigationBasePath}
          showDeepLinks={false}
          showExportAction={false}
          showPrimaryAction={showPrimaryAction}
          showFilters={page.showFilters}
          serviceProviderScopeId={scope.serviceProviderScopeId}
          permissionsRoleId={scope.permissionsRoleId}
          roleGrants={scope.roleGrants}
          actorName={scope.actorName}
        />
      </Suspense>
    </RestrictedFrame>
  )
}
