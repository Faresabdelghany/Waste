import { WorkspacePageShell } from "@/components/waste/workspace-page-shell"
import { followMovedAddress } from "@/lib/moved-address"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

type OperatePageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function OperatePage({ searchParams }: OperatePageProps) {
  followMovedAddress("/operate", await searchParams)

  return <WorkspacePageShell workspaceId="operate" />
}
