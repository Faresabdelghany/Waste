// Counting Rules (#547 of #544) on the wire: a rule counting the completed
// emptyings at each property over a month, a quarter or a year — optionally
// of one waste fraction, of one container type — and the ticket of its type,
// waiting with its team, that it opens on a property whose count reaches its
// limit (@waste/domain/resolution/counting-rules). A rule is the company's,
// like the Ticket Type it opens, and inactive until switched on.
//
// A simulation counts what a rule's terms would have counted over past
// emptyings, before it is saved or switched on: the window is widened to
// whole periods, and each property that would have received a ticket is
// listed with its period and the day its count reached the limit, the
// earliest first, `SIMULATION_TICKETS_SHOWN` at most, beside the total.
import { COUNTING_LIMIT_MAX, simulationWindowIssue } from "@waste/domain/resolution/counting-rules"
import { COUNTING_PERIODS, COUNTING_RULE_STATUSES } from "@waste/domain/resolution/vocabulary"
import * as z from "zod"

import { IsoDate } from "./dates"
import { Id } from "./ids"
import { PageRequest } from "./pagination"
import { NonNegativeInt, PositiveInt, resourceBodies, stamped } from "./resource"
import { Label } from "./text"

export const CountingPeriod = z.enum(COUNTING_PERIODS)
export type CountingPeriod = z.infer<typeof CountingPeriod>

export const CountingRuleStatus = z.enum(COUNTING_RULE_STATUSES)
export type CountingRuleStatus = z.infer<typeof CountingRuleStatus>

/** How many emptyings in a period open the ticket: 1 to `COUNTING_LIMIT_MAX`. */
export const CountingLimit = PositiveInt.max(COUNTING_LIMIT_MAX)

/** What a rule counts, the terms a simulation takes too: over which period, up to which limit, of which fraction and container type, null counting every one. */
const terms = {
  period: CountingPeriod,
  limit: CountingLimit,
  wasteFractionId: Id.nullable(),
  containerTypeId: Id.nullable(),
}

export const CountingRule = z.object({
  ...stamped,
  name: Label,
  status: CountingRuleStatus,
  ...terms,
  ticketTypeId: Id,
  /** The team the ticket waits with. */
  teamId: Id,
  /** Whether each member of the team is e-mailed the ticket as it opens. */
  notifiesTeam: z.boolean(),
})
export type CountingRule = z.infer<typeof CountingRule>

/** A patch takes any of a rule's own fields; switching it on or off is its status. */
const countingRuleBodies = resourceBodies({
  name: Label,
  status: CountingRuleStatus.default("inactive").describe("Defaults to inactive: a rule is simulated before it is switched on."),
  period: CountingPeriod,
  limit: CountingLimit,
  wasteFractionId: Id.nullable().default(null).describe("Null when absent: every fraction counts."),
  containerTypeId: Id.nullable().default(null).describe("Null when absent: every container type counts."),
  ticketTypeId: Id,
  teamId: Id,
  notifiesTeam: z.boolean().default(false),
})

export const CountingRuleCreate = countingRuleBodies.create
export type CountingRuleCreate = z.infer<typeof CountingRuleCreate>

export const CountingRulePatch = countingRuleBodies.patch
export type CountingRulePatch = z.infer<typeof CountingRulePatch>

export const CountingRuleListQuery = PageRequest.extend({ status: CountingRuleStatus.optional() })
export type CountingRuleListQuery = z.infer<typeof CountingRuleListQuery>

/** `POST /counting-rules/simulation`: a rule's terms and the window to count over, `to` the first day not counted, at most three years. */
export const CountingSimulationBody = z
  .strictObject({
    ...terms,
    wasteFractionId: Id.nullable().default(null),
    containerTypeId: Id.nullable().default(null),
    from: IsoDate,
    to: IsoDate,
  })
  .superRefine((body, context) => {
    const issue = simulationWindowIssue(body)
    if (issue !== undefined) context.addIssue({ code: "custom", message: issue, path: ["to"] })
  })
export type CountingSimulationBody = z.infer<typeof CountingSimulationBody>

/** One ticket a rule would have opened: the property, its project, the period, the day its count reached the limit, and the period's count over the window. */
export const CountingSimulationTicket = z.object({
  propertyId: Id,
  propertyName: Label,
  projectId: Id,
  periodFrom: IsoDate,
  reachedOn: IsoDate,
  /** Every emptying the rule counts in the period, the ones after the limit included. */
  count: PositiveInt,
})
export type CountingSimulationTicket = z.infer<typeof CountingSimulationTicket>

export const CountingSimulation = z.object({
  /** The window widened to whole periods, `to` the first day not counted. */
  from: IsoDate,
  to: IsoDate,
  /** How many tickets the rule would have opened, over every property and period. */
  tickets: NonNegativeInt,
  /** How many properties would have received one. */
  properties: NonNegativeInt,
  /** The tickets, the earliest reached first, at most `SIMULATION_TICKETS_SHOWN`. */
  shown: z.array(CountingSimulationTicket),
})
export type CountingSimulation = z.infer<typeof CountingSimulation>
