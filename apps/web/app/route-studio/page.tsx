import { Suspense } from "react"
import { redirect } from "next/navigation"

import { WorkspacePageShell } from "@/components/wastehero/workspace-page-shell"
// PROTOTYPE — scheme-wizard variants, remove after evaluation (see components/wastehero/prototypes/).
import { SchemeWizardPrototype } from "@/components/wastehero/prototypes/scheme-wizard-prototype"

export default async function RouteStudioPage({
  searchParams,
}: {
  searchParams: Promise<{ module?: string }>
}) {
  const { module } = await searchParams
  if (module === "history") redirect("/route-studio?module=pickups")

  return (
    <>
      <WorkspacePageShell workspaceId="route-studio" />
      <Suspense fallback={null}>
        <SchemeWizardPrototype />
      </Suspense>
    </>
  )
}
