import { redirect } from "next/navigation"

import { WorkspacePageShell } from "@/components/wastehero/workspace-page-shell"

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ module?: string }>
}) {
  const { module } = await searchParams
  if (module === "inbox") redirect("/customers")

  return <WorkspacePageShell workspaceId="customers" />
}
