// A project's default ticket teams through the client (O30 of #290): the read
// Settings › Tickets' Default teams tab and a ticket type's page share, and
// the edit of one kind's or type's team (#606). The set is a project's
// configuration and no row of a workspace's table, so it is no switched
// module: a surface asks the client itself, as the ticket charges do.
import type { TicketTeamDefaults } from "@waste/contracts/ticket-teams"

import { defaultsWithTeam } from "@/lib/data/ticket-teams"
import type { TicketScope } from "@/lib/data/ticket-scope"

import { get, put, type ApiClient } from "./client"

const pathOf = (projectId: string): string => `/projects/${projectId}/ticket-team-defaults`

/** `GET /projects/:id/ticket-team-defaults`: the team each kind and type of the project names. */
export function readTeamDefaults(client: ApiClient, projectId: string): Promise<TicketTeamDefaults> {
  return get<TicketTeamDefaults>(client, pathOf(projectId))
}

/**
 * One kind's or type's team moved, null for none. The API replaces the set
 * whole, so it is read as it stands and put back with the one entry moved: a
 * row another person saved meanwhile is kept. Answers the set as it now stands.
 */
export async function moveDefaultTeam(client: ApiClient, projectId: string, scope: TicketScope, teamId: string | null): Promise<TicketTeamDefaults> {
  return put<TicketTeamDefaults>(client, pathOf(projectId), defaultsWithTeam(await readTeamDefaults(client, projectId), scope, teamId))
}
