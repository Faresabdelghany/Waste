"use client"

// The company's ticket teams as a default team is picked from and read by:
// the teams among the store's rows of `configure.templates`, which on the
// Pilot reaches `/teams` through lib/api/records/ticket-teams.ts, and the way
// between a team's web id and the API's. Settings › Tickets' Default teams tab
// and a ticket type's form share it (#606).

import { useModuleRecords, useServerModuleState } from "@/components/platform/business-record-store"
import { isTicketTeamRecord } from "@/lib/api/records/ticket-teams"
import type { BusinessRecord } from "@/lib/data/business-modules"
import { TICKET_TEAMS_MODULE } from "@/lib/data/ticket-teams"
import { TICKET_TEAM_PREFIX } from "@/lib/modules/configure"
import { isSoftDeleted } from "@/lib/prototype/record-visibility"
import { webIdOf } from "@/lib/records/fields"

export type TicketTeams = {
  /** Every team, whatever its status. */
  teams: readonly BusinessRecord[]
  /** Whether the teams were answered, none among them or not. */
  read: boolean
  /** Whether the teams are still on their way: false once answered, refused or failed. */
  reading: boolean
  serverIdOf: (webId: string) => string | undefined
  /** The record id a team the API names is held under; its id chip where the store does not hold it. */
  webIdOf: (serverId: string) => string
}

export function useTicketTeams(): TicketTeams {
  const records = useModuleRecords(TICKET_TEAMS_MODULE.workspaceId, TICKET_TEAMS_MODULE.moduleId)
  const ids = useServerModuleState(TICKET_TEAMS_MODULE.workspaceId, TICKET_TEAMS_MODULE.moduleId)?.serverIds
  return {
    teams: records.records.filter((record) => isTicketTeamRecord(record) && !isSoftDeleted(record)),
    read: records.ready,
    reading: records.pending,
    serverIdOf: (webId) => ids?.get(webId),
    webIdOf: (serverId) => [...(ids ?? [])].find(([, id]) => id === serverId)?.[0] ?? webIdOf(TICKET_TEAM_PREFIX, serverId),
  }
}
