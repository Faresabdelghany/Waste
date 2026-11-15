// Ticket teams on the Pilot (O30 of #290, row 7.20): where the teams live, the
// form a team is added and edited with, and a project's default team per kind
// and per type as the rows a person reads, the choices one is picked from and
// the set `PUT /projects/:id/ticket-team-defaults` is handed when one row
// moves (#606). The teams are records of `configure.templates`
// (lib/api/records/ticket-teams.ts), written through the record store; the
// defaults are one project's configuration and read and written directly
// (lib/api/ticket-team-defaults.ts), as the SLA is.
import type { TicketTeamDefaults, TicketTeamDefaultsSet } from "@waste/contracts/ticket-teams"
import { TICKET_KINDS } from "@waste/domain/resolution/vocabulary"

import { moduleAt } from "@/lib/modules/keys"

import { type Grants, mayOn } from "@/lib/modules/grants"
import { statusLabel } from "@/lib/records/fields"
import type { BusinessFormField, BusinessFormOption, BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import type { BusinessRecord } from "./business-modules"
import { mintedRecord } from "./containers"
import { scopeKey, typeLabel, typesListed, type TicketScope, type TypeChoices } from "./ticket-scope"

/** Configure › Tickets & communication: the module the teams are the records of on the Pilot. */
export const TICKET_TEAMS_MODULE = moduleAt("configure.templates")

export const TEAM_STATUS_LABELS = ["Active", "Inactive"] as const

export const TICKET_TEAM_FIELDS: readonly BusinessFormField[] = [
  { id: "name", label: "Name", type: "text", required: true },
  {
    id: "status",
    label: "Status",
    type: "select",
    defaultValue: "Active",
    options: TEAM_STATUS_LABELS.map((value) => ({ value, label: value })),
    description: "An inactive team takes no new ticket and keeps the ones it holds.",
  },
  {
    id: "memberUserAccountIds",
    label: "Members",
    type: "multiselect",
    relation: moduleAt("configure.access"),
    description: "Who is in the team. Anyone who works tickets takes a team's ticket, member or not.",
  },
]

const teamForm = (mode: "create" | "action", title: string, submitLabel: string): BusinessFormSchema => ({
  key: "configure.templates",
  mode,
  recordKind: "Ticket team",
  title,
  description: "A team the company's tickets wait with.",
  submitLabel,
  nameField: "name",
  execution: mode === "create" ? { kind: "create-record", completionMessage: "Team added." } : { kind: "append-event", completionMessage: "Team saved." },
  sections: [{ id: "team", title: "Team", fields: TICKET_TEAM_FIELDS }],
})

export const TICKET_TEAM_FORM = teamForm("create", "New team", "Add team")
export const TICKET_TEAM_EDIT_FORM = teamForm("action", "Edit team", "Save")

/** A team as the pane adds it: minted under a browser id until the API answers with its own. */
export function createTicketTeamRecord(values: BusinessFormValues, { now }: { now: number }): BusinessRecord {
  const name = typeof values.name === "string" ? values.name.trim() : ""
  const status = typeof values.status === "string" && values.status !== "" ? values.status : "Active"
  return mintedRecord({ id: `configure-team-${now}`, name, status, recordKind: "Ticket team", values: { ...values, status } })
}

export function updateTicketTeamRecord(record: BusinessRecord, values: BusinessFormValues): BusinessRecord {
  const name = typeof values.name === "string" && values.name.trim() !== "" ? values.name.trim() : record.name
  return { ...record, name, submittedValues: { ...record.submittedValues, ...values } }
}

/** The kind picker's value for no team: the kind's tickets open without one. */
export const NO_TEAM = "no-team"

/** One kind's or one type's row as the pane holds it (#548 of #544): its scope, its key, and the team's web id or `NO_TEAM` — for a type, its kind's team. */
export type TeamDefaultRow = TicketScope & { key: string; label: string; teamId: string }

/** Every kind as a row, in the vocabulary's order, then each type listed (`typesListed`), each with the team the project names for it or none. `webIdOf` turns a team's server id into the record id the picker offers. */
export function teamDefaultRowsOf(defaults: TicketTeamDefaults, webIdOf: (serverId: string) => string, types: TypeChoices = []): TeamDefaultRow[] {
  const byKey = new Map(defaults.defaults.map((entry) => [scopeKey(entry), entry.teamId]))
  const row = (scope: TicketScope, label: string): TeamDefaultRow => {
    const teamId = byKey.get(scopeKey(scope))
    return { ...scope, key: scopeKey(scope), label, teamId: teamId === undefined ? NO_TEAM : webIdOf(teamId) }
  }
  const named = defaults.defaults.flatMap((entry) => (entry.ticketTypeId === null ? [] : [entry.ticketTypeId]))
  return [...TICKET_KINDS.map((kind) => row({ kind, ticketTypeId: null }, statusLabel(kind))), ...typesListed(types, named).map((type) => row({ kind: null, ticketTypeId: type.id }, typeLabel(type)))]
}

/** The team a set names for one kind or type, by server id; null where it names none. */
export const teamOfScope = (defaults: TicketTeamDefaults, scope: TicketScope): string | null => defaults.defaults.find((entry) => scopeKey(entry) === scopeKey(scope))?.teamId ?? null

/** The set with one kind's or type's team moved (#606): named afresh, changed, or left out with null, every other entry as it stood. The body `PUT` replaces the set with. */
export function defaultsWithTeam(defaults: TicketTeamDefaults, scope: TicketScope, teamId: string | null): TicketTeamDefaultsSet {
  const others = defaults.defaults.filter((entry) => scopeKey(entry) !== scopeKey(scope))
  if (teamId === null) return { defaults: others }
  const named = { kind: scope.kind, ticketTypeId: scope.ticketTypeId, teamId }
  // A row the set holds keeps its place, so the answer reads in the order it was read in.
  return { defaults: others.length === defaults.defaults.length ? [...others, named] : defaults.defaults.map((entry) => (scopeKey(entry) === scopeKey(scope) ? named : entry)) }
}

export const PICK_A_HELD_TEAM = "Pick a team the API holds"

/** The team a picker's value names, by server id and null for none; or the refusal where the API does not hold it. */
export function pickedTeamOf(teamId: string, serverIdOf: (webId: string) => string | undefined): { teamId: string | null } | { message: string } {
  if (teamId === NO_TEAM) return { teamId: null }
  const held = serverIdOf(teamId)
  return held === undefined ? { message: PICK_A_HELD_TEAM } : { teamId: held }
}

type TeamRead = Pick<BusinessRecord, "id" | "name" | "status">

/** What no team reads as: a kind's tickets open with none, a type's go to its kind's. */
const noTeamLabel = (ofType: boolean): string => (ofType ? "As its kind" : "No team")

const teamLabel = (team: TeamRead): string => (team.status === "Active" ? team.name : `${team.name} · ${team.status}`)

/** What a kind's team, or with `ofType` a type's, is picked from: none, each team that takes tickets, and the one `held` already whatever its status, so the picker reads what is saved. */
export function teamChoicesOf(ofType: boolean, teams: readonly TeamRead[], held: string): BusinessFormOption[] {
  return [{ value: NO_TEAM, label: noTeamLabel(ofType) }, ...teams.filter((team) => team.status === "Active" || team.id === held).map((team) => ({ value: team.id, label: teamLabel(team) }))]
}

/** How a row's team reads in the list: its name, its status beside it once it takes no new ticket, and for none what the row's tickets do instead. A team the list does not hold is on its way while the teams are `reading`, and unlisted once they were answered or their read failed. */
export function teamShownOf(row: Pick<TeamDefaultRow, "teamId" | "ticketTypeId">, teams: readonly TeamRead[], reading: boolean): string {
  if (row.teamId === NO_TEAM) return noTeamLabel(row.ticketTypeId !== null)
  const team = teams.find((candidate) => candidate.id === row.teamId)
  if (team === undefined) return reading ? "Reading the team…" : "A team that is not listed"
  return teamLabel(team)
}

/** What a default team the API took is told as: whose it is, in which project, and the team. */
export const defaultTeamSaved = (label: string, projectName: string, team: string): { title: string; description: string } => ({ title: "Default team saved", description: `${label} in ${projectName}: ${team}.` })

export const DEFAULT_TEAM_NOT_SAVED = "The default team was not saved"

/** What the person's role lets them do with the teams: read them under `view` on the templates' module, change them under `edit`, add one under `create`. */
export const ticketTeamsAccessOf = (grants: Grants | null): { view: boolean; edit: boolean; create: boolean } => ({
  view: mayOn(grants, "configure.templates", "view"),
  edit: mayOn(grants, "configure.templates", "edit"),
  create: mayOn(grants, "configure.templates", "create"),
})
