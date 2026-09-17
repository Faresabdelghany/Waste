import type { Metadata } from "next"

import { SettingsWorkspace } from "@/components/settings/SettingsDialog"

export const metadata: Metadata = {
  title: "Settings · WasteHero",
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
