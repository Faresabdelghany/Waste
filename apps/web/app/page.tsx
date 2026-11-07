import { redirect } from "next/navigation"

import { SignedInLanding } from "@/components/auth/signed-in-landing"
import { API_CONFIG } from "@/lib/api/config"
import { followMovedAddress } from "@/lib/moved-address"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

type PageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function Page({ searchParams }: PageProps) {
  followMovedAddress("/", await searchParams)

  // On the Pilot the home is where `/me` lands the person (Issue #150), which
  // only the browser can ask; without the API it is the office's, Operate.
  if (API_CONFIG !== null) return <SignedInLanding />
  redirect("/operate")
}
