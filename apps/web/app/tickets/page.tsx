import { WorkspacePageShell } from "@/components/wastehero/workspace-page-shell"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export default function TicketsPage() {
  return <WorkspacePageShell workspaceId="operate" initialModuleId="tickets" />
}
