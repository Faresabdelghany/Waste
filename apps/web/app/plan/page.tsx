import { redirect } from "next/navigation"

import { WorkspacePageShell } from "@/components/waste/workspace-page-shell"
import { migrateLegacyHref } from "@/lib/data/legacy-ids"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

type PlanPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function PlanPage({ searchParams }: PlanPageProps) {
  const params = await searchParams
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (typeof value === "string") query.set(key, value)
  }
  const search = query.toString()
  const href = search ? `/plan?${search}` : "/plan"
  // Bookmarks into a module that left Plan (Areas & Zones → Settings,
  // 2026-09-03, D37) follow the shared legacy-href migration.
  const target = migrateLegacyHref(href)
  if (target !== href) redirect(target)

  return <WorkspacePageShell workspaceId="plan" />
}
