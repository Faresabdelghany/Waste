import { redirect } from "next/navigation"

import { SignedInLanding } from "@/components/auth/signed-in-landing"
import { API_CONFIG } from "@/lib/api/config"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

type PageProps = {
  searchParams: Promise<{
    module?: string | string[]
    record?: string | string[]
  }>
}

export default async function Page({ searchParams }: PageProps) {
  const params = await searchParams
  const recordId = typeof params.record === "string" ? params.record : undefined

  if (params.module === "driver-app") {
    redirect("/driver")
  }
  if (params.module === "live") {
    redirect(
      recordId
        ? `/route-studio?module=live&record=${encodeURIComponent(recordId)}`
        : "/route-studio?module=live",
    )
  }

  // On the Pilot the home is where `/me` lands the person (Issue #150), which
  // only the browser can ask; the prototype's home stays the legacy dashboard.
  if (API_CONFIG !== null) return <SignedInLanding />
  redirect("/performance")
}
