import type { Metadata } from "next"

import { SettingsWorkspace } from "@/components/settings/SettingsDialog"

// @next-codemod-ignore Cache Components adoption: this segment temporarily allows blocking.
// Remove this opt-out after verifying the segment passes validation without it.
// See: https://nextjs.org/docs/app/guides/migrating-to-cache-components
export const instant = false;

export const metadata: Metadata = {
  title: "Settings · Waste",
}

type SettingsPageProps = {
  searchParams: Promise<{
    pane?: string | string[]
    from?: string | string[]
  }>
}

function safeReturnPath(value: string | string[] | undefined): string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.startsWith("/settings")
  ) {
    return "/"
  }

  return value
}

export default async function SettingsPage({ searchParams }: SettingsPageProps) {
  const params = await searchParams
  const initialPaneId =
    typeof params.pane === "string" ? params.pane : undefined

  return (
    <SettingsWorkspace
      initialPaneId={initialPaneId}
      returnTo={safeReturnPath(params.from)}
    />
  )
}
