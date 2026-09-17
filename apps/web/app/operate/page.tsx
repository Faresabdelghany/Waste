import { redirect } from "next/navigation"

import { WorkspacePageShell } from "@/components/wastehero/workspace-page-shell"

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
