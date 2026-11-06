// Settings › Counting rules (#547 of #544): the company's rules counting the
// completed emptyings at each property over a month, a quarter or a year, and
// opening one ticket of a chosen type, waiting with a chosen team, on a
// property whose count reaches the limit. The pane reads and writes the API
// directly (components/settings/counting-rules-settings.tsx), as the Ticket
// SLA's does: a rule is configuration the company keeps, named by server ids
// it picks from the API's own lists. Here are the rows a person edits, the
// body a create or a patch sends, a rule as a sentence, and the window a
// simulation looks back over. A draft the API would refuse is refused here
// first, at its field, in the API's sentence.
import type { CountingRule, CountingRuleCreate, CountingRulePatch, CountingSimulation, CountingSimulationBody } from "@waste/contracts/counting-rules"
import { COUNTING_LIMIT_MAX, countedWhat, periodName } from "@waste/domain/resolution/counting-rules"
import { addDays } from "@waste/domain/route-schemes/recurrence"
import { COUNTING_PERIODS, type CountingPeriod } from "@waste/domain/resolution/vocabulary"

import { allows, type Grants } from "../api/grants"

export const COUNTING_RULES_SETTINGS_PANE_ID = "counting-rules"

/** What the person may do here: the templates' grant, and the stops' besides to simulate, since a simulation reads them. */
export const countingRulesAccessOf = (grants: Grants | undefined) => ({
  view: allows(grants, "configure.templates", "view"),
  create: allows(grants, "configure.templates", "create"),
  edit: allows(grants, "configure.templates", "edit"),
  delete: allows(grants, "configure.templates", "delete"),
  simulate: allows(grants, "configure.templates", "view") && allows(grants, "route-studio.pickups", "view"),
})

const PERIOD_LABELS: Readonly<Record<CountingPeriod, string>> = { month: "Month", quarter: "Quarter", year: "Year" }
export const COUNTING_PERIOD_OPTIONS = COUNTING_PERIODS.map((period) => ({ value: period, label: PERIOD_LABELS[period] }))

/** The pickers' "every one": no fraction, no container type. */
export const EVERY = "every"

/** A rule as the editor holds it: the limit as typed, every reference a server id or none. */
export type CountingRuleDraft = {
  name: string
  active: boolean
  period: CountingPeriod
  limit: string
  wasteFractionId: string | null
  containerTypeId: string | null
  ticketTypeId: string | null
  teamId: string | null
  notifiesTeam: boolean
}

/** A field the draft fills wrongly, and why, in the API's sentence. */
export type CountingRuleRefusal = { field: keyof CountingRuleDraft; message: string }

/** The editor's draft of a rule, or of a new one: monthly, inactive, nobody told. */
export function countingRuleDraftOf(rule?: CountingRule): CountingRuleDraft {
  if (rule === undefined) return { name: "", active: false, period: "month", limit: "", wasteFractionId: null, containerTypeId: null, ticketTypeId: null, teamId: null, notifiesTeam: false }
  return {
    name: rule.name,
    active: rule.status === "active",
    period: rule.period,
    limit: String(rule.limit),
    wasteFractionId: rule.wasteFractionId,
    containerTypeId: rule.containerTypeId,
    ticketTypeId: rule.ticketTypeId,
    teamId: rule.teamId,
    notifiesTeam: rule.notifiesTeam,
  }
}

/** The limit as typed, a whole number from 1 to the domain's cap, or the refusal at it. */
function limitOf(draft: Pick<CountingRuleDraft, "limit">): number | CountingRuleRefusal {
  const limit = Number(draft.limit.trim())
  if (draft.limit.trim() === "" || !Number.isInteger(limit) || limit < 1 || limit > COUNTING_LIMIT_MAX) return { field: "limit", message: `A limit is a whole number from 1 to ${COUNTING_LIMIT_MAX}` }
  return limit
}

export const isCountingRuleRefusal = (value: unknown): value is CountingRuleRefusal => typeof value === "object" && value !== null && "field" in value && "message" in value

/** The create body a draft makes, or the first field it fills wrongly. */
export function countingRuleBodyOf(draft: CountingRuleDraft): CountingRuleCreate | CountingRuleRefusal {
  const name = draft.name.trim()
  if (name === "") return { field: "name", message: "Name the rule" }
  const limit = limitOf(draft)
  if (isCountingRuleRefusal(limit)) return limit
  if (draft.ticketTypeId === null) return { field: "ticketTypeId", message: "Pick the type of the ticket it opens" }
  if (draft.teamId === null) return { field: "teamId", message: "Pick the team the ticket waits with" }
  return {
    name,
    status: draft.active ? "active" : "inactive",
    period: draft.period,
    limit,
    wasteFractionId: draft.wasteFractionId,
    containerTypeId: draft.containerTypeId,
    ticketTypeId: draft.ticketTypeId,
    teamId: draft.teamId,
    notifiesTeam: draft.notifiesTeam,
  }
}

/** The patch a draft makes of a rule: only what changed, or the refusal; null where nothing did. */
export function countingRulePatchOf(rule: CountingRule, draft: CountingRuleDraft): CountingRulePatch | CountingRuleRefusal | null {
  const body = countingRuleBodyOf(draft)
  if (isCountingRuleRefusal(body)) return body
  const keys = ["name", "status", "period", "limit", "wasteFractionId", "containerTypeId", "ticketTypeId", "teamId", "notifiesTeam"] as const
  const patch = Object.fromEntries(keys.flatMap((key) => (body[key] === rule[key] ? [] : [[key, body[key]]]))) as CountingRulePatch
  return Object.keys(patch).length === 0 ? null : patch
}

/** The simulation body of a draft's terms over a window, or the refusal at the limit. */
export function simulationBodyOf(draft: CountingRuleDraft, window: { from: string; to: string }): CountingSimulationBody | CountingRuleRefusal {
  const limit = limitOf(draft)
  if (isCountingRuleRefusal(limit)) return limit
  return { period: draft.period, limit, wasteFractionId: draft.wasteFractionId, containerTypeId: draft.containerTypeId, ...window }
}

/** The windows a simulation offers, by how far back from today they look. */
export const SIMULATION_WINDOWS = [
  { value: "12", label: "The last 12 months" },
  { value: "24", label: "The last 2 years" },
  { value: "36", label: "The last 3 years" },
] as const

/** The window of 365 days a year back from today, today included: `to` the first day not counted, tomorrow; three years is 1,095 days, inside the API's bound. */
export function simulationWindowOf(today: string, months: number): { from: string; to: string } {
  const to = addDays(today, 1)
  return { from: addDays(to, -Math.round((months * 365) / 12)), to }
}

/** What a rule counts and up to what, as a sentence: `12 completed emptyings of Glass a month`. */
export function countingRuleSentence(rule: Pick<CountingRule, "limit" | "period">, names: { wasteFraction: string | null; containerType: string | null }): string {
  return `${rule.limit} ${countedWhat(names, rule.limit)} a ${rule.period}`
}

/** A simulated ticket's period as a person reads it. */
export const simulatedPeriod = (periodFrom: string, period: CountingPeriod): string => periodName(periodFrom, period)

/** A simulation's answer as a sentence: its window from its first day through its last, the wire's `to` being the first day not counted; and how many of the tickets are listed where not all are. */
export function simulationSentence(answer: Pick<CountingSimulation, "from" | "to" | "tickets" | "properties" | "shown">): string {
  const window = `from ${answer.from} through ${addDays(answer.to, -1)}`
  const found =
    answer.tickets === 0
      ? `No property would have received a ticket ${window}.`
      : `${answer.tickets} ${answer.tickets === 1 ? "ticket" : "tickets"} at ${answer.properties} ${answer.properties === 1 ? "property" : "properties"} ${window}.`
  return answer.shown.length < answer.tickets ? `${found} The first ${answer.shown.length} are listed.` : found
}

/** What a rule's team picker says where the company has no active team: a rule's tickets wait with one, so a team comes first; a simulation needs none. */
export const NO_TEAM_YET = "The company has no active team yet. A counting rule's tickets wait with a team, so add one on the Teams tab of Users & roles before saving the rule; you can simulate without one."
