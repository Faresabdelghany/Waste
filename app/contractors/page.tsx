import { WorkspacePageShell } from "@/components/wastehero/workspace-page-shell"

const contractorModuleIds = ["contractors", "contract-areas", "activities"] as const

export default function ContractorsPage() {
  return (
    <WorkspacePageShell
      workspaceId="contractors"
      allowedModuleIds={contractorModuleIds}
    />
  )
}
