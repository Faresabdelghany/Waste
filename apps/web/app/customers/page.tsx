import { redirect } from "next/navigation"

import { WorkspacePageShell } from "@/components/waste/workspace-page-shell"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ module?: string }>
}) {
  const { module } = await searchParams
  if (module === "inbox") redirect("/customers")

  return <WorkspacePageShell workspaceId="customers" />
}
