import { AppSidebar } from "@/components/app-sidebar"
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar"
import { BusinessWorkspace } from "@/components/wastehero/business-workspace"
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
        <BusinessWorkspace
          workspaceId={workspaceId}
          initialModuleId={initialModuleId}
          allowedModuleIds={
            allowedModuleIds ?? publicModuleIdsByWorkspace[workspaceId]
          }
        />
      </SidebarInset>
    </SidebarProvider>
  )
}
