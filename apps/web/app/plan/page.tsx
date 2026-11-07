import { WorkspacePageShell } from "@/components/waste/workspace-page-shell"
import { followMovedAddress } from "@/lib/moved-address"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

type PlanPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function PlanPage({ searchParams }: PlanPageProps) {
  // Bookmarks into a module that left Plan (Areas & Zones → Settings,
  // 2026-09-03, D37) follow the shared legacy-href migration.
  followMovedAddress("/plan", await searchParams)

  return <WorkspacePageShell workspaceId="plan" />
}
