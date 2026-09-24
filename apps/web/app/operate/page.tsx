import { redirect } from "next/navigation"

import { WorkspacePageShell } from "@/components/waste/workspace-page-shell"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

type OperatePageProps = {
  searchParams: Promise<{
    module?: string | string[]
    record?: string | string[]
  }>
}

export default async function OperatePage({ searchParams }: OperatePageProps) {
  const params = await searchParams
  const recordId = typeof params.record === "string" ? params.record : undefined

  if (params.module === "driver-app") {
    redirect("/tickets")
  }
  if (params.module === "live") {
    redirect(
      recordId
        ? `/route-studio?module=live&record=${encodeURIComponent(recordId)}`
        : "/route-studio?module=live",
    )
  }

  return <WorkspacePageShell workspaceId="operate" />
}
