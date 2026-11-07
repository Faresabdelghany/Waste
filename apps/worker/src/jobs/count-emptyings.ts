// Counting rules at work (#547 of #544): the consumer of `pickup-completed`
// and `pickup-corrected` that counts each completed emptying against the
// company's active Counting Rules, and opens a rule's ticket on the property
// whose count reaches the rule's limit. The rule is the domain's
// (@waste/domain/resolution/counting-rules); what a rule counts is spelled
// once with the API's simulation (@waste/db/commands/counting-rules).
//
// A stop is heard of when it completes, or when a correction leaves it
// completed; any other stop — failed, skipped, a work order, at a shared
// collection point — counts nothing and is passed over. Each active rule of
// the stop's fraction and container type, or of none, counts the property's
// emptyings in the period the stop's route's service date lies in, read from
// the stops as they stand, so a redelivered event or a correction counts the
// same; and where the count has reached the limit and the property has no
// ticket of the rule for that period, opens one through the `openTicket` the
// office's create runs: of the rule's type while it is active, else its
// kind's default; waiting with the rule's team while it takes tickets, else
// the project's default for the kind; naming the property alone, so it is
// never a charge; due by the project's SLA; recording the rule, the period
// and the count (`countedBy`); `createdBy` null and a minted
// `source_event_id`, as an automation's follow-up has, since one emptying may
// reach two rules. Its type's opening actions run in the same transaction.
// Where the rule says so, each active member of the team who works in the
// ticket's project is e-mailed it (`countingTicketNotice`), keyed by the
// ticket, whatever their own choices.
//
// One property is counted by one event at a time: a transaction advisory lock
// on the property, taken before any rule is counted and so before any
// ticket's number takes the company's row, then each rule's ticket looked
// for, then the count — so two emptyings completing together under two
// workers open one ticket per rule, and two rules reached at once never wait
// on each other's locks. `ticket_counting_key` is the database's word for the
// same. A ticket records its period whole, its first day and the first day
// after it, so a rule whose period changes counts its new periods afresh.
//
// It starts fresh: the emptyings relayed before it ran are not counted as
// news, though each is counted all the same by the next emptying at its
// property, since a count reads the stops.
import type { Pickup } from "@waste/contracts/pickups"
import type { Tx } from "@waste/db/client"
import { countedAt } from "@waste/db/commands/counting-rules"
import { queueStaffMessage } from "@waste/db/commands/messaging"
import { BY_SLA, openTicket } from "@waste/db/commands/open-ticket"
import { newId } from "@waste/db/ids"
import { projectAccess, userAccount } from "@waste/db/schema/access"
import { containerType, wasteFraction } from "@waste/db/schema/catalogue"
import { container } from "@waste/db/schema/containers"
import { route } from "@waste/db/schema/execution"
import { company, project } from "@waste/db/schema/organisation"
import { countingRule, team, teamMember, ticket, ticketType } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { countingTicketNotice } from "@waste/domain/notifications/notices"
import { countingTicketText, periodOf } from "@waste/domain/resolution/counting-rules"
import type { CountingPeriod, TicketKind } from "@waste/domain/resolution/vocabulary"
import { advisoryLock } from "@waste/db/commands/shared"
import { and, asc, eq, exists, isNull, or, sql } from "drizzle-orm"
import { NO_TICKET_LINKS } from "@waste/db/shapes/tickets"

import { defineOutboxConsumer, payloadOf, type RelayedEvent } from "../outbox/subscribe"
import type { JobContext } from "./definition"

/** What one stop's event came to: the tickets its count opened, by rule. */
export type EmptyingCounted = { event: string; opened: { countingRuleId: string; ticketId: string }[] }

type Rule = typeof countingRule.$inferSelect

/** The name a fraction or a type is read by, for the ticket's words; null where the rule names none. */
async function nameOf(tx: Tx, table: typeof wasteFraction | typeof containerType, companyId: string, id: string | null): Promise<string | null> {
  if (id === null) return null
  const [found] = await tx
    .select({ name: table.name })
    .from(table)
    .where(and(eq(table.companyId, companyId), eq(table.id, id)))
    .limit(1)
  return found?.name ?? null
}

/** E-mails each active member of the team who works in the ticket's project — every project, or one Project Access names — keyed by the ticket so each hears of it once. */
async function noticeTeam(tx: Tx, send: JobContext["send"], companyId: string, opened: { id: string; projectId: string; number: number; subject: string; description: string }, teamId: string, teamName: string): Promise<void> {
  const members = await tx
    .select({ userAccountId: teamMember.userAccountId })
    .from(teamMember)
    .innerJoin(userAccount, and(eq(userAccount.companyId, teamMember.companyId), eq(userAccount.id, teamMember.userAccountId)))
    .where(
      and(
        eq(teamMember.companyId, companyId),
        eq(teamMember.teamId, teamId),
        isNull(userAccount.deactivatedAt),
        or(
          eq(userAccount.allProjects, true),
          exists(
            tx
              .select({ one: sql`1` })
              .from(projectAccess)
              .where(and(eq(projectAccess.companyId, companyId), eq(projectAccess.userAccountId, teamMember.userAccountId), eq(projectAccess.projectId, opened.projectId))),
          ),
        ),
      ),
    )
    .orderBy(asc(teamMember.userAccountId))
  if (members.length === 0) return
  const [names] = await tx
    .select({ projectName: project.name, companyName: company.name })
    .from(project)
    .innerJoin(company, eq(company.id, project.companyId))
    .where(and(eq(project.companyId, companyId), eq(project.id, opened.projectId)))
    .limit(1)
  const notice = countingTicketNotice(opened, { ...names, teamName })
  for (const member of members) {
    await queueStaffMessage(tx, send, { id: newId(), companyId, projectId: opened.projectId, userAccountId: member.userAccountId, sourceEventId: opened.id, ...notice })
  }
}

/** One rule's count at the stop's property: the ticket it opened, or undefined where the count is short or the period's ticket is open already. */
async function countFor(tx: Tx, { send, now }: Pick<JobContext, "send" | "now">, companyId: string, stop: Pickup & { propertyId: string }, serviceDate: string, rule: Rule): Promise<string | undefined> {
  const period = periodOf(serviceDate, rule.period as CountingPeriod)
  const [already] = await tx
    .select({ id: ticket.id })
    .from(ticket)
    .where(and(eq(ticket.companyId, companyId), eq(ticket.countingRuleId, rule.id), eq(ticket.propertyId, stop.propertyId), eq(ticket.countedFrom, period.from), eq(ticket.countedTo, period.to)))
    .limit(1)
  if (already !== undefined) return undefined
  const count = await countedAt(tx, companyId, rule, stop.propertyId, period)
  if (count < rule.limit) return undefined
  const [type] = await tx
    .select({ kind: ticketType.kind, status: ticketType.status })
    .from(ticketType)
    .where(and(eq(ticketType.companyId, companyId), eq(ticketType.id, rule.ticketTypeId)))
    .limit(1)
  const [waitsWith] = await tx
    .select({ name: team.name, status: team.status })
    .from(team)
    .where(and(eq(team.companyId, companyId), eq(team.id, rule.teamId)))
    .limit(1)
  const names = { wasteFraction: await nameOf(tx, wasteFraction, companyId, rule.wasteFractionId), containerType: await nameOf(tx, containerType, companyId, rule.containerTypeId) }
  const text = countingTicketText({ name: rule.name, limit: rule.limit, period: rule.period as CountingPeriod }, { count, periodFrom: period.from }, names)
  const teamTakesTickets = waitsWith.status === "active"
  const { row } = await openTicket(tx, {
    companyId,
    draft: {
      projectId: stop.projectId,
      kind: type.kind as TicketKind,
      ...(type.status === "active" ? { ticketTypeId: rule.ticketTypeId } : {}),
      priority: "none",
      source: "counting-rule",
      ...text,
      occurredAt: stop.outcomeAt === null ? now() : new Date(stop.outcomeAt),
      dueAt: BY_SLA,
      assigneeUserAccountId: null,
      ...(teamTakesTickets ? { teamId: rule.teamId } : {}),
      links: { ...NO_TICKET_LINKS, propertyId: stop.propertyId },
      alertId: null,
      countedBy: { countingRuleId: rule.id, periodFrom: period.from, periodTo: period.to, count },
    },
    createdBy: null,
    sourceEventId: newId(),
    newId,
    now,
    automation: { send, by: null },
  })
  if (rule.notifiesTeam && teamTakesTickets) await noticeTeam(tx, send, companyId, row, rule.teamId, waitsWith.name)
  return row.id
}

/** One stop's event to the tickets its count opened, in one fenced transaction as the tenant. */
export async function countEmptying(event: RelayedEvent<"pickup-completed" | "pickup-corrected">, { api, log, now, send }: Pick<JobContext, "api" | "log" | "now" | "send">): Promise<EmptyingCounted> {
  const stop = payloadOf(event)
  const { propertyId } = stop
  const opened: EmptyingCounted["opened"] = []
  if (stop.status === "completed" && stop.service === "empty" && propertyId !== null) {
    await withCompany(api.db, event.companyId, async (tx) => {
      const [onRoute] = await tx
        .select({ serviceDate: route.serviceDate })
        .from(route)
        .where(and(eq(route.companyId, event.companyId), eq(route.id, stop.routeId)))
        .limit(1)
      if (onRoute === undefined) throw new Error(`${event.kind} ${event.id} names route ${stop.routeId}, which is not in company ${event.companyId}`)
      const [held] =
        stop.containerId === null
          ? []
          : await tx
              .select({ containerTypeId: container.containerTypeId })
              .from(container)
              .where(and(eq(container.companyId, event.companyId), eq(container.id, stop.containerId)))
              .limit(1)
      const rules = await tx
        .select()
        .from(countingRule)
        .where(
          and(
            eq(countingRule.companyId, event.companyId),
            eq(countingRule.status, "active"),
            or(isNull(countingRule.wasteFractionId), eq(countingRule.wasteFractionId, stop.wasteFractionId)),
            held === undefined ? isNull(countingRule.containerTypeId) : or(isNull(countingRule.containerTypeId), eq(countingRule.containerTypeId, held.containerTypeId)),
          ),
        )
        .orderBy(asc(countingRule.id))
      // The property's lock, before any rule is counted or any ticket numbered.
      if (rules.length > 0) await advisoryLock(tx, `counting-property:${event.companyId}:${propertyId}`)
      for (const rule of rules) {
        const ticketId = await countFor(tx, { send, now }, event.companyId, { ...stop, propertyId }, onRoute.serviceDate, rule)
        if (ticketId !== undefined) opened.push({ countingRuleId: rule.id, ticketId })
      }
    })
  }
  log(`resolution.count-emptyings: ${event.kind} ${event.id} → ${opened.length === 0 ? "nothing" : opened.map((one) => `ticket ${one.ticketId} (rule ${one.countingRuleId})`).join(", ")}`)
  return { event: event.id, opened }
}

/** The counting entries on `outbox.pickup-completed` and `outbox.pickup-corrected`; spread into `OUTBOX_CONSUMERS`. Starts fresh: the emptyings before it are counted by the next one at their property. */
export const countEmptyings = defineOutboxConsumer({
  name: "counting",
  kinds: ["pickup-completed", "pickup-corrected"],
  description: "Counts a completed emptying against the company's active counting rules and opens a rule's ticket on the property whose count in the period reaches its limit, once per rule, property and period.",
  startsFresh: true,
  handler: (event, context) => countEmptying(event, context),
})
