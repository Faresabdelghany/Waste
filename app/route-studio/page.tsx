import { redirect } from "next/navigation"

import { WorkspacePageShell } from "@/components/wastehero/workspace-page-shell"

export default async function RouteStudioPage({
  searchParams,
}: {
  searchParams: Promise<{ module?: string }>
}) {
  const { module } = await searchParams
  if (module === "history") redirect("/route-studio?module=pickups")

  return <WorkspacePageShell workspaceId="route-studio" />
}
