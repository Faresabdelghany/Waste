import { Suspense } from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { BusinessWorkspace } from "@/components/waste/business-workspace"
import { RoutingQuotaBanner } from "@/components/waste/routing/routing-quota-banner"
import type { WorkspaceId } from "@/lib/data/business-modules"

const publicModuleIdsByWorkspace: Partial<
  Record<WorkspaceId, readonly string[]>
> = {
  // O11 of #290: a customer's bulky items booked onto a collection day; #393: the recycling centres' visit ledger.
  operate: ["tickets", "bulky-bookings", "exceptions", "site-visits"],
  customers: [
    "properties",
    "groups",
    "shared",
    "contacts",
    "agreements",
    // M7 of #293: a customer's requests and the office's decisions on them.
    "applications",
    // #393: the plates and cards a project's recycling centres admit by.
    "site-access",
  ],
}

export function WorkspacePageShell({
  workspaceId,
  initialModuleId,
  allowedModuleIds,
}: {
  workspaceId: WorkspaceId
  initialModuleId?: string
  allowedModuleIds?: readonly string[]
}) {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        {/* Route Studio's one routing banner, while the provider's quota is spent or its key refused (#173, #132 §5); it renders nothing otherwise.
            Under its own Suspense: it reads the clock and the session, request data under Cache Components, so it streams in after the static shell. */}
        {workspaceId === "route-studio" && (
          <Suspense fallback={null}>
            <RoutingQuotaBanner className="border-b border-border" />
          </Suspense>
        )}
        {/* Suspense above useSearchParams: under Cache Components the URL is request
            data, so the workspace streams in after the static shell. */}
        <Suspense fallback={null}>
          {/* The Export button: a CSV of the module's rows as the table shows them, on the Pilot and in fixture mode alike (#292); Map Planning draws a map and no table, so it offers none. */}
          <BusinessWorkspace
            workspaceId={workspaceId}
            initialModuleId={initialModuleId}
            allowedModuleIds={
              allowedModuleIds ?? publicModuleIdsByWorkspace[workspaceId]
            }
            showExportAction={workspaceId !== "plan"}
          />
        </Suspense>
      </SidebarInset>
    </SidebarProvider>
  )
}
