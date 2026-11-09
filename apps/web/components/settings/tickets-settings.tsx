"use client"

// Settings › Tickets (#548 of #544): one page, a tab each for the ticket
// types, the default teams, the deadlines, the charges and the counting
// rules (the tabs are its Settings table entry's). Each tab is the pane it
// was, drawing the page's tab strip in its own header, as Asset management's
// tabs do; a type's own deadline, default team and charge are rows of the
// Deadlines, Default teams and Charges tabs beside its kind's, and the three
// tabs share one project. The tab and a ticket type's own page are the
// address's, so a reload or a shared link lands on them. The teams
// themselves are Settings › Users & roles' Teams tab. Offered on the Pilot
// alone.

import { useState } from "react"

import { CountingRulesSettings } from "@/components/settings/counting-rules-settings"
import type { SettingsPaneProps } from "@/lib/modules/settings-panes"
import { TicketChargesSettings } from "@/components/settings/ticket-charges-settings"
import { TicketSlaSettings } from "@/components/settings/ticket-sla-settings"
import { TicketDefaultTeamsSettings } from "@/components/settings/ticket-teams-settings"
import { TicketTypesSettings } from "@/components/settings/ticket-types-settings"
import type { ProjectPick } from "@/components/settings/use-project-setting"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { settingsTabsOf, type SettingsTabOf } from "@/lib/modules/settings-panes"

type TicketsTab = SettingsTabOf<"tickets">

export function TicketsSettings({ params, onParamsChange, onOpenPane }: SettingsPaneProps) {
  // A ticket type's page is the Types tab's.
  const tab = params.type !== undefined ? "types" : ((params.tab as TicketsTab | undefined) ?? "types")
  const [projectId, setProjectId] = useState<string | null>(null)
  const pick: ProjectPick = { projectId, onProjectChange: setProjectId }
  const openTeams = () => onOpenPane("access", { tab: "teams" })
  // A ticket type's page is an address of its own, so Back returns to the list.
  const openType = (typeId: string | null) => onParamsChange(typeId === null ? {} : { type: typeId }, "push")
  const tabs = (
    <div className="flex items-center gap-1 overflow-x-auto pb-1">
      <Tabs value={tab} onValueChange={(value) => onParamsChange({ tab: value })}>
        <TabsList className="inline-flex h-8 rounded-full border border-border/50 bg-muted px-1 py-0.5 text-xs" aria-label="Ticket settings">
          {settingsTabsOf("tickets").map((option) => (
            <TabsTrigger key={option.value} value={option.value} className="whitespace-nowrap rounded-full px-3">
              {option.label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  )

  switch (tab) {
    case "types":
      return <TicketTypesSettings tabs={tabs} openTypeId={params.type ?? null} onOpenType={openType} />
    case "default-teams":
      return <TicketDefaultTeamsSettings tabs={tabs} pick={pick} onOpenTeams={openTeams} />
    case "deadlines":
      return <TicketSlaSettings tabs={tabs} pick={pick} />
    case "charges":
      return <TicketChargesSettings tabs={tabs} pick={pick} />
    case "counting-rules":
      return <CountingRulesSettings tabs={tabs} onOpenTeams={openTeams} />
  }
}
