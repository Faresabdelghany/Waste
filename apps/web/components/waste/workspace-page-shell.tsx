import { Suspense } from "react"

import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { BusinessWorkspace } from "@/components/waste/business-workspace"
import { RoutingQuotaBanner } from "@/components/waste/routing/routing-quota-banner"
import type { WorkspaceId } from "@/lib/data/business-modules"

const publicModuleIdsByWorkspace: Partial<
  Record<WorkspaceId, readonly string[]>
> = {
  operate: ["tickets", "exceptions"],
  customers: [
    "properties",
    "groups",
    "shared",
    "contacts",
    "agreements",
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
        {/* Route Studio's one routing banner, while the provider's quota is spent or its key refused (#173, #132 §5); it renders nothing otherwise. */}
        {workspaceId === "route-studio" && <RoutingQuotaBanner className="border-b border-border" />}
        {/* Suspense above useSearchParams: under Cache Components the URL is request
            data, so the workspace streams in after the static shell. */}
        <Suspense fallback={null}>
          <BusinessWorkspace
            workspaceId={workspaceId}
            initialModuleId={initialModuleId}
            allowedModuleIds={
              allowedModuleIds ?? publicModuleIdsByWorkspace[workspaceId]
            }
          />
        </Suspense>
      </SidebarInset>
    </SidebarProvider>
  )
}
