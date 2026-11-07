import { WorkspacePageShell } from "@/components/waste/workspace-page-shell"
import { followMovedAddress } from "@/lib/moved-address"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  followMovedAddress("/customers", await searchParams)

  return <WorkspacePageShell workspaceId="customers" />
}
