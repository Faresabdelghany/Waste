// Ticket teams on the Pilot (O30 of #290, row 7.20): where the teams live, the
// form a team is added and edited with, and a project's default team per kind
// as rows a person picks and the body `PUT /projects/:id/ticket-team-defaults`
// replaces the set with. The teams are records of `configure.templates`
// (lib/api/records/ticket-teams.ts), written through the record store; the
// defaults are one project's configuration and read and written directly, as
// the SLA is (components/settings/ticket-teams-settings.tsx).
import type { TicketTeamDefaults, TicketTeamDefaultsSet } from "@waste/contracts/ticket-teams"
import { TICKET_KINDS } from "@waste/domain/resolution/vocabulary"

import { allows, type Grants } from "../api/grants"
import { statusLabel } from "../api/records/adapter"
import { accessModule } from "../api/records/organisation"
import type { BusinessFormField, BusinessFormSchema, BusinessFormValues } from "./business-form-types"
import type { BusinessRecord, ModuleLocation } from "./business-modules"
import { mintedRecord } from "./containers"
import { scopeKey, typeLabel, typesListed, type TicketScope, type TypeChoices } from "./ticket-scope"

/** Configure › Tickets & communication: the module the teams are the records of on the Pilot. */
export const TICKET_TEAMS_MODULE: ModuleLocation = { workspaceId: "configure", moduleId: "templates" }

export const TICKET_TEAM_PREFIX = "team"

/** A team's two statuses as the form offers them. */
export const TEAM_STATUS_LABELS = ["Active", "Inactive"] as const

/** The form a team is added and edited with: its name, whether it takes tickets, and who is in it. */
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
    relation: { workspaceId: accessModule.workspaceId, moduleId: accessModule.moduleId },
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

/** A team after an edit: its identity kept, the form's values over its typed ones. */
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

/** What a row naming a team the API does not hold is told. */
export const PICK_A_HELD_TEAM = "Pick a team the API holds"

/** The body the rows become: each kind or type with a team, by server id; or the first row whose team the API does not hold. */
export function teamDefaultsBodyOf(rows: readonly TeamDefaultRow[], serverIdOf: (webId: string) => string | undefined): TicketTeamDefaultsSet | { key: string; message: string } {
  const defaults: TicketTeamDefaultsSet["defaults"] = []
  for (const row of rows) {
    if (row.teamId === NO_TEAM) continue
    const teamId = serverIdOf(row.teamId)
    if (teamId === undefined) return { key: row.key, message: PICK_A_HELD_TEAM }
    defaults.push({ kind: row.kind, ticketTypeId: row.ticketTypeId, teamId })
  }
  return { defaults }
}

/** What the person's role lets them do with the teams: read them under `view` on the templates' module, change them under `edit`, add one under `create`. */
export const ticketTeamsAccessOf = (grants: Grants | undefined): { view: boolean; edit: boolean; create: boolean } => ({
  view: allows(grants, "configure.templates", "view"),
  edit: allows(grants, "configure.templates", "edit"),
  create: allows(grants, "configure.templates", "create"),
})
