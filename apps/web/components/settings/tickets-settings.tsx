"use client"

// Settings › Tickets (#548 of #544): one page, a tab each for the ticket
// types, the teams, the deadlines, the charges and the counting rules
// (lib/data/tickets-settings.ts). Each tab is the pane it was, drawing the
// page's tab strip in its own header, as Asset management's tabs do; a type's
// own deadline, default team and charge are rows of the Deadlines, Teams and
// Charges tabs beside its kind's, and the three tabs share one project.
// Offered on the Pilot alone.

import { useState } from "react"

import { CountingRulesSettings } from "@/components/settings/counting-rules-settings"
import { TicketChargesSettings } from "@/components/settings/ticket-charges-settings"
import { TicketSlaSettings } from "@/components/settings/ticket-sla-settings"
import { TicketTeamsSettings } from "@/components/settings/ticket-teams-settings"
import { TicketTypesSettings } from "@/components/settings/ticket-types-settings"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { TICKETS_TABS, type TicketsProjectPick, type TicketsTab } from "@/lib/data/tickets-settings"

/**
 * The page at `tab`, which the dialog holds so leaving and coming back finds the tab last used; `onTabChange` moves it.
 * `typeId` is the ticket type whose own page the Types tab shows in its place, by the API's id; `onTypeChange` opens one, or the list again with null.
 */
export function TicketsSettings({ tab, onTabChange, typeId, onTypeChange }: { tab: TicketsTab; onTabChange: (tab: TicketsTab) => void; typeId: string | null; onTypeChange: (typeId: string | null) => void }) {
  // One project for the Deadlines, Teams and Charges tabs: picked on one, the others open on it.
  const [projectId, setProjectId] = useState<string | null>(null)
  const pick: TicketsProjectPick = { projectId, onProjectChange: setProjectId }
  const tabs = (
    <div className="flex items-center gap-1 overflow-x-auto pb-1">
      <Tabs value={tab} onValueChange={(value) => onTabChange(value as TicketsTab)}>
        <TabsList className="inline-flex h-8 rounded-full border border-border/50 bg-muted px-1 py-0.5 text-xs" aria-label="Ticket settings">
          {TICKETS_TABS.map((option) => (
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
      return <TicketTypesSettings tabs={tabs} openTypeId={typeId} onOpenType={onTypeChange} />
    case "teams":
      return <TicketTeamsSettings tabs={tabs} {...pick} />
    case "deadlines":
      return <TicketSlaSettings tabs={tabs} {...pick} />
    case "charges":
      return <TicketChargesSettings tabs={tabs} {...pick} />
    case "counting-rules":
      return <CountingRulesSettings tabs={tabs} onOpenTeams={() => onTabChange("teams")} />
  }
}
