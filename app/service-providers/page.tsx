import { WorkspacePageShell } from "@/components/wastehero/workspace-page-shell"

const serviceProviderModuleIds = ["service-providers", "service-areas", "activities"] as const

export default function ServiceProvidersPage() {
  return (
    <WorkspacePageShell
      workspaceId="service-providers"
      allowedModuleIds={serviceProviderModuleIds}
    />
  )
}
