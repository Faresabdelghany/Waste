// Settings › Tickets (#548 of #544): one page for everything a company
// configures about its tickets, a tab each — the types, the teams, the
// deadlines (the SLA), the charges and the counting rules — where five panes
// stood before, four under Operations and the charges under Commercial. The
// panes' own ids stay as links: each opens the page at its tab, so a link or
// a bookmark made before the page reads as it did.
import { COUNTING_RULES_SETTINGS_PANE_ID } from "./counting-rules"
import { TICKET_SLA_SETTINGS_PANE_ID } from "./ticket-sla"
import { TICKET_TEAMS_SETTINGS_PANE_ID } from "./ticket-teams"
import { TICKET_TYPES_SETTINGS_PANE_ID } from "./ticket-types"

export const TICKETS_SETTINGS_PANE_ID = "tickets"

/** The charges' pane before the page, under Commercial. */
export const TICKET_CHARGES_SETTINGS_PANE_ID = "commercial-ticket-charges"

/** The page's tabs, in the order a person sets tickets up: what a ticket is, who works it, by when, at what price, and what opens one. */
export const TICKETS_TABS = [
  { value: "types", label: "Types" },
  { value: "teams", label: "Teams" },
  { value: "deadlines", label: "Deadlines" },
  { value: "charges", label: "Charges" },
  { value: "counting-rules", label: "Counting rules" },
] as const

export type TicketsTab = (typeof TICKETS_TABS)[number]["value"]

/** The panes the page took the place of, each the tab it opens; and fixture mode's Tickets & communication, whose SLA is the deadlines'. */
const TAB_OF_PANE: Readonly<Record<string, TicketsTab>> = {
  [TICKETS_SETTINGS_PANE_ID]: "types",
  "ticket-comms": "deadlines",
  [TICKET_TYPES_SETTINGS_PANE_ID]: "types",
  [TICKET_TEAMS_SETTINGS_PANE_ID]: "teams",
  [TICKET_SLA_SETTINGS_PANE_ID]: "deadlines",
  [TICKET_CHARGES_SETTINGS_PANE_ID]: "charges",
  [COUNTING_RULES_SETTINGS_PANE_ID]: "counting-rules",
}

/** Whether a pane id opens the Tickets page: its own, or one of the panes it took the place of. */
export const opensTickets = (paneId: string): boolean => Object.hasOwn(TAB_OF_PANE, paneId)

/** The tab a pane id opens the page at: its pane's, else the types'. */
export const ticketsTabOf = (paneId: string | undefined): TicketsTab => (paneId === undefined ? undefined : TAB_OF_PANE[paneId]) ?? "types"

/** The project the Deadlines, Teams and Charges tabs share, by the API's id: picked on one, it is the one the others open on. */
export type TicketsProjectPick = { projectId: string | null; onProjectChange: (projectId: string) => void }

/** The project a tab shows: the one picked on the page where the tab lists it, else the tab's first by name, so every tab opens on the same one. `serverIdOf` names a listed project by the API's id. */
export function projectShown<P extends { name: string }>(projects: readonly P[], picked: string | null, serverIdOf: (project: P) => string | undefined): P | null {
  return projects.find((project) => picked !== null && serverIdOf(project) === picked) ?? [...projects].sort((one, other) => one.name.localeCompare(other.name))[0] ?? null
}
