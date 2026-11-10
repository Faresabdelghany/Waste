"use client"

// The restricted shells: the citizen portal, and the service provider's
// workspace. In fixture mode both are pinned to their fixture persona —
// NordRen ApS, its fixture role and its actor. On the Pilot the provider's
// is the signed-in account's (#291 C24): its provider and its name from
// `/me`, its role's grants as `/me` answers them, and no pinned project,
// since a provider's account works in none and the API fences every row it
// reads to its provider. Its landing is its routes.
import Link from "next/link"
import { Suspense, useEffect, useState, type ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { useApiSession } from "@/components/platform/api-session-store"
import { BusinessWorkspace } from "@/components/waste/business-workspace"
import { useProviderWebId, useProviderWorkspace } from "@/components/platform/provider-account"
import {
  RestrictedPersonaSidebar,
  type RestrictedPersona,
} from "@/components/waste/restricted-persona-sidebar"
import {
  FIXTURE_PROJECT_IDS,
  FIXTURE_SERVICE_PROVIDER_IDS,
  type WorkspaceId,
} from "@/lib/data/business-modules"
import { problemOfError, problemSentence } from "@/lib/api/problem"
import { moduleAt } from "@/lib/modules/keys"
import { PROVIDER_PAGES } from "@/lib/modules/provider-pages"
import { ALL_PROJECTS, type ProjectScope } from "@/lib/data/project-scope"
import { NOT_A_PROVIDER_ACCOUNT } from "@/lib/data/provider-workspace"
import { CITIZEN_IDENTITY, SERVICE_PROVIDER_IDENTITY } from "@/lib/data/fixture-identity"
import { ShellIdentityProvider, type ShellIdentity } from "@/components/platform/shell-identity"
import { PageTopBar } from "@/components/page-layout"
import { Breadcrumbs } from "@/components/ui/breadcrumbs"

type RestrictedWorkspacePage = {
  id: string
  workspaceId: WorkspaceId
  moduleId: string
  moduleIds: readonly string[]
  recordIds?: readonly string[]
  workspaceLabel: string
  navigationBasePath: string
  showWorkspaceActions: boolean
  /** The primary action on the Pilot, where it differs (`PROVIDER_PAGES`). */
  showWorkspaceActionsOnApi?: boolean
  showFilters: boolean
}

type RestrictedWorkspaceDefinition = {
  /** The project record the persona works in — one of the organisation module's, or every permitted one. */
  fixedProjectScope: ProjectScope
  fixedScopeLabel: string
  /** Every record and relation option is isolated to this service provider. */
  serviceProviderScopeId?: string
  pages: readonly RestrictedWorkspacePage[]
}

/** The citizen's one page: the portal's module, its one property's records. */
const CITIZEN_PORTAL = moduleAt("customers.citizen-portal")

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
        ...CITIZEN_PORTAL,
        moduleIds: [CITIZEN_PORTAL.moduleId],
        recordIds: ["portal-activity-parkvej"],
        workspaceLabel: "Citizen portal",
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
    pages: PROVIDER_PAGES.map((page) => ({
      id: page.id,
      workspaceId: page.workspaceId,
      moduleId: page.moduleIds[0],
      moduleIds: page.moduleIds,
      workspaceLabel: page.label,
      navigationBasePath: page.path,
      showWorkspaceActions: page.showWorkspaceActions,
      showWorkspaceActionsOnApi: page.showWorkspaceActionsOnApi,
      showFilters: true,
    })),
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
  onApi: boolean
}

const RESTRICTED_SHELLS: Record<RestrictedPersona, ShellIdentity> = {
  citizen: { fixture: CITIZEN_IDENTITY, offersSettings: false },
  "service-provider": { fixture: SERVICE_PROVIDER_IDENTITY, offersSettings: false },
}

function RestrictedFrame({ persona, children }: { persona: RestrictedPersona; children: ReactNode }) {
  return (
    <SidebarProvider>
      <RestrictedPersonaSidebar persona={persona} />
      <SidebarInset>
        <ShellIdentityProvider identity={RESTRICTED_SHELLS[persona]}>{children}</ShellIdentityProvider>
      </SidebarInset>
    </SidebarProvider>
  )
}

// The top bar over the account's own notices, so its menu (and Sign out)
// stays at hand while `/me` is read or names no provider.
function AccountTopBar() {
  return (
    <PageTopBar>
      <Breadcrumbs items={[{ label: "Service provider workspace" }]} />
    </PageTopBar>
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
          <AccountTopBar />
          <ReadingAccount />
        </RestrictedFrame>
      )
    }
    if (provider === null) {
      return (
        <RestrictedFrame persona={persona}>
          <AccountTopBar />
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

  const page =
    definition.pages.find((candidate) => candidate.id === pageId) ??
    definition.pages[0]
  const scope: WorkspaceScope =
    provider === null
      ? {
          fixedProjectScope: definition.fixedProjectScope,
          fixedScopeLabel: definition.fixedScopeLabel,
          serviceProviderScopeId: definition.serviceProviderScopeId,
          onApi: false,
        }
      : {
          fixedProjectScope: ALL_PROJECTS,
          fixedScopeLabel: provider.legalName,
          serviceProviderScopeId: providerWebId,
          onApi: true,
        }
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
          fixedProjectScope={scope.fixedProjectScope}
          fixedScopeLabel={scope.fixedScopeLabel}
          navigationBasePath={page.navigationBasePath}
          showDeepLinks={false}
          showExportAction={false}
          showPrimaryAction={showPrimaryAction}
          showFilters={page.showFilters}
          serviceProviderScopeId={scope.serviceProviderScopeId}
        />
      </Suspense>
    </RestrictedFrame>
  )
}
