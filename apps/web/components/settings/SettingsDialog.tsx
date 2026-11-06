"use client"

// Settings: the nav, the search, the pane an address shows and the frame
// around it, all read from the Settings table (lib/data/settings-panes.ts);
// each pane is drawn by its view (settings-pane-views.tsx), and where no API
// is configured a pane the API holds says so in its place.

import { useState } from "react"
import { useRouter } from "next/navigation"
import { CaretLeft, MagnifyingGlass } from "@phosphor-icons/react/dist/ssr"

import { fixtureSettingsTerms } from "@/components/settings/fixture-settings-controls"
import { SettingsPaneFrameProvider } from "@/components/settings/settings-pane-frame"
import { AssetPanelShell } from "@/components/settings/settings-pane-kit"
import { SETTINGS_PANE_ICONS, SETTINGS_PANE_VIEWS } from "@/components/settings/settings-pane-views"
import { ReportNotice } from "@/components/insight/report-card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useApiConfigured } from "@/components/waste/api-session-store"
import { keptOnApi } from "@/lib/api/records/server-records"
import { settingsAddressHref, settingsAddressShown, settingsNav, settingsPane, settingsPaneDrawnWithoutApi, type SettingsAddress, type SettingsPaneId, type SettingsParams } from "@/lib/data/settings-panes"
import { cn } from "@/lib/utils"

type SettingsWorkspaceProps = {
  /** The pane the address names, and every param it carries; the table decides what is shown of them. */
  pane?: string
  params: Readonly<Record<string, string>>
  /** Where Back to app returns. */
  returnTo: string
}

const sameAddress = (one: SettingsAddress, other: SettingsAddress) => one.pane === other.pane && JSON.stringify(one.params) === JSON.stringify(other.params)

export function SettingsWorkspace({ pane, params, returnTo }: SettingsWorkspaceProps) {
  const router = useRouter()
  const configured = useApiConfigured()
  const addressed = settingsAddressShown(pane, params)
  // What is shown: the address's on arrival and whenever Back, Forward or a link moves it, else what was picked here, at once.
  const [shown, setShown] = useState(addressed)
  const [arrived, setArrived] = useState(addressed)
  if (!sameAddress(arrived, addressed)) {
    setArrived(addressed)
    setShown(addressed)
  }
  const [search, setSearch] = useState("")
  const nav = settingsNav(search, fixtureSettingsTerms)

  const go = (next: SettingsAddress, how: "push" | "replace" = "replace") => {
    setShown(next)
    const href = settingsAddressHref(next, returnTo)
    if (how === "push") router.push(href, { scroll: false })
    else router.replace(href, { scroll: false })
  }
  const open = (paneId: SettingsPaneId, next: SettingsParams = {}, how: "push" | "replace" = "replace") => go(settingsAddressShown(paneId, next), how)
  const shownPane = settingsPane(shown.pane)
  const View = configured || settingsPaneDrawnWithoutApi(shownPane) ? SETTINGS_PANE_VIEWS[shown.pane] : KeptOnApiPane

  return (
    <div className="flex h-dvh min-w-0 flex-col bg-sidebar sm:flex-row">
      <aside className="flex max-h-[44dvh] w-full shrink-0 flex-col px-3 py-3 sm:max-h-none sm:min-h-0 sm:w-64 sm:px-4 sm:py-4">
        <Button
          type="button"
          variant="unstyled"
          onClick={() => router.push(returnTo)}
          className="mb-4 flex h-8 w-fit cursor-pointer items-center gap-1.5 rounded-full bg-sidebar-accent px-3 text-sm font-medium text-sidebar-foreground/80 transition-colors hover:text-sidebar-foreground"
        >
          <CaretLeft className="size-3.5" />
          Back to app
        </Button>

        <div className="relative mb-4">
          <MagnifyingGlass className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-sidebar-foreground/55" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search settings"
            aria-label="Search settings"
            className="h-9 rounded-md border-sidebar-border bg-sidebar-accent/45 pl-9 text-sm text-sidebar-foreground shadow-none placeholder:text-sidebar-foreground/50 focus-visible:border-sidebar-ring focus-visible:ring-1 focus-visible:ring-sidebar-ring/25"
          />
        </div>

        <nav className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1 text-sm" aria-label="Settings sections">
          {nav.map((section) => (
            <div key={section.id}>
              <div className="flex h-6 items-center px-2.5 text-sm font-medium text-sidebar-foreground/55">{section.label}</div>
              <div className="flex flex-col gap-0.5">
                {section.panes.map((item) => {
                  const isActive = item.id === shown.pane
                  const Icon = SETTINGS_PANE_ICONS[item.icon]
                  return (
                    <Button
                      key={item.id}
                      type="button"
                      variant="unstyled"
                      onClick={() => go({ pane: item.id, params: {} })}
                      aria-current={isActive ? "page" : undefined}
                      className={cn(
                        "flex h-7 cursor-pointer items-center gap-2 rounded-md px-2.5 text-left text-xs font-normal text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground",
                        isActive && "bg-sidebar-accent font-medium text-sidebar-foreground",
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      <span className="truncate">{item.label}</span>
                    </Button>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>
      </aside>

      <main className="mx-2 mb-2 min-h-0 min-w-0 flex-1 overflow-y-auto rounded-lg border border-sidebar bg-background sm:my-2 sm:ml-0" id="settings-content">
        <div className="flex min-h-full w-full flex-col">
          <div className="flex min-w-0 flex-1 flex-col">
            <SettingsPaneFrameProvider pane={shownPane}>
              <View
                key={shown.pane}
                paneId={shown.pane}
                params={shown.params}
                onParamsChange={(next, how) => open(shown.pane, next, how)}
                onOpenPane={(paneId, next) => open(paneId, next)}
              />
            </SettingsPaneFrameProvider>
          </div>
        </div>
      </main>
    </div>
  )
}

/** A pane the API holds, where none is configured: its frame, and the one sentence that says where its subject is kept. */
function KeptOnApiPane({ paneId }: { paneId: SettingsPaneId }) {
  return (
    <AssetPanelShell>
      <ReportNotice empty={keptOnApi(settingsPane(paneId).label)} />
    </AssetPanelShell>
  )
}
