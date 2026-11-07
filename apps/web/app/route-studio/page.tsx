import { Suspense } from "react"

import { WorkspacePageShell } from "@/components/waste/workspace-page-shell"
import { followMovedAddress } from "@/lib/moved-address"
// PROTOTYPE — scheme-wizard variants, remove after evaluation (see components/waste/prototypes/).
import { SchemeWizardPrototype } from "@/components/waste/prototypes/scheme-wizard-prototype"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export default async function RouteStudioPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  followMovedAddress("/route-studio", await searchParams)

  return (
    <>
      <WorkspacePageShell workspaceId="route-studio" />
      <Suspense fallback={null}>
        <SchemeWizardPrototype />
      </Suspense>
    </>
  )
}
