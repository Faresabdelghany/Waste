// A project's notification rules (O16 of #290, part b; C18 of #291): which
// customer notices the project sends and from which of its message templates —
// a Bulky Booking booked, cancelled, collected or not collected; the day-ahead
// collection reminder; a ticket's reply and completion; and the two
// broadcasts, a route cancelled or running late, each sent to the whole
// project or to the notification areas its rule names. `GET
// /projects/:id/notification-rules` reads them and `PUT` replaces them whole,
// under `configure.templates`, the module the templates are written under. A
// rule is the opt-in: a notice no rule names is never sent, and nothing has a
// default text (the coordinator's default on #351, pending the owner's
// review). The worker's customer notices consumer reads the rule when the
// event comes (apps/worker/src/jobs/customer-notices.ts) and queues the
// template to the booking's customer through `queueMessage`, whose send
// honours the customer's consent.
//
// Each template is one of the project's (400), for service (400: a notice is
// a service message, which the customer's consent governs), names no value its
// notice does not fill (400, `unfilledByNotice`) and is active (409,
// in `queueMessage`'s sentence) — judged at the write, and again at the send,
// where a template made inactive since refuses the notice. The set is written
// in place, as the Ticket SLA's is: a rule the body keeps keeps its id and
// moves only its template, one the body leaves out is deleted, under a
// transaction-scoped advisory lock on the set. The project is a path's row,
// its 404 the family's.
import { NotificationRules, NotificationRulesPut, type CustomerNoticeEvent, type NotificationRule } from "@waste/contracts/notifications"
import { planningArea } from "@waste/db/schema/planning-areas"
import { unfilledByNotice } from "@waste/domain/notifications/notices"
import type { Tx } from "@waste/db/client"
import { templateInactive } from "@waste/db/commands/messaging"
import { messageTemplate } from "@waste/db/schema/messaging"
import { notificationRule, notificationRuleArea } from "@waste/db/schema/notifications"
import { CUSTOMER_NOTICE_EVENTS } from "@waste/domain/notifications/vocabulary"
import { and, eq, inArray, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { projectIdsOf } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { describeJson, IdParam } from "./shared"

const MODULE = "configure.templates"

/** What a rule naming a template that is not the project's is told. */
export const PICK_A_PROJECT_TEMPLATE = "Pick a message template of this project"
/** What a rule naming a billing template is told. */
export const A_SERVICE_TEMPLATE = "A notice is a service message: pick a template for service"
/** What a rule naming a template with a value its notice does not fill is told (C18 of #291). */
export const notFilledByNotice = (template: string, names: readonly string[]) =>
  `The template ${template} names ${names.map((name) => `{{${name}}}`).join(", ")}, which this notice does not fill`
/** What a broadcast naming an area that is not one of the project's notification areas is told. */
export const A_NOTIFICATION_AREA = "Pick a notification area of this project"

type Rules = NotificationRulesPut["rules"]

const columns = { id: notificationRule.id, event: notificationRule.event, templateId: notificationRule.templateId }
type Row = { id: string; event: string; templateId: string }
type AreaRow = { ruleId: string; planningAreaId: string }

const noSuchProject = (id: string) => problem(404, { detail: `No project ${id} in the projects this account works in` })

function requireOwnProject(principal: Principal, id: string): void {
  if (!projectIdsOf(principal).includes(id)) throw noSuchProject(id)
}

const rulesOf = (projectId: string, rows: readonly Row[], areas: readonly AreaRow[]): NotificationRules => ({
  projectId,
  rules: [...rows]
    .sort((a, b) => CUSTOMER_NOTICE_EVENTS.indexOf(a.event as CustomerNoticeEvent) - CUSTOMER_NOTICE_EVENTS.indexOf(b.event as CustomerNoticeEvent))
    .map((row): NotificationRule => ({
      event: row.event as CustomerNoticeEvent,
      templateId: row.templateId,
      planningAreaIds: areas
        .filter((area) => area.ruleId === row.id)
        .map((area) => area.planningAreaId)
        .sort(),
    })),
})

async function areasIn(tx: Tx, companyId: string, projectId: string): Promise<AreaRow[]> {
  return await tx
    .select({ ruleId: notificationRuleArea.ruleId, planningAreaId: notificationRuleArea.planningAreaId })
    .from(notificationRuleArea)
    .where(and(eq(notificationRuleArea.companyId, companyId), eq(notificationRuleArea.projectId, projectId)))
}

/** Each broadcast's areas held to the project's `notification` areas (400 at their field). */
async function requireAreas(tx: Tx, companyId: string, projectId: string, rules: Rules): Promise<void> {
  const ids = [...new Set(rules.flatMap((rule) => rule.planningAreaIds ?? []))]
  if (ids.length === 0) return
  const found = new Set(
    (
      await tx
        .select({ id: planningArea.id })
        .from(planningArea)
        .where(and(eq(planningArea.companyId, companyId), eq(planningArea.projectId, projectId), eq(planningArea.purpose, "notification"), inArray(planningArea.id, ids)))
    ).map((row) => row.id),
  )
  const issues = rules.flatMap((rule, index) => ((rule.planningAreaIds ?? []).some((id) => !found.has(id)) ? [{ path: `rules.${index}.planningAreaIds`, message: A_NOTIFICATION_AREA }] : []))
  if (issues.length > 0) throw invalidRequest("body", issues)
}

async function rulesIn(tx: Tx, companyId: string, projectId: string): Promise<Row[]> {
  return await tx
    .select(columns)
    .from(notificationRule)
    .where(and(eq(notificationRule.companyId, companyId), eq(notificationRule.projectId, projectId)))
}

/** Each rule's template held to the project and to service (400 at its field), then to active (409). */
async function requireTemplates(tx: Tx, companyId: string, projectId: string, rules: Rules): Promise<void> {
  const ids = [...new Set(rules.map((rule) => rule.templateId))]
  if (ids.length === 0) return
  const found = new Map(
    (
      await tx
        .select({ id: messageTemplate.id, name: messageTemplate.name, purpose: messageTemplate.purpose, status: messageTemplate.status, subject: messageTemplate.subject, body: messageTemplate.body })
        .from(messageTemplate)
        .where(and(eq(messageTemplate.companyId, companyId), eq(messageTemplate.projectId, projectId), inArray(messageTemplate.id, ids)))
    ).map((row) => [row.id, row]),
  )
  const issues = rules.flatMap((rule, index) => {
    const template = found.get(rule.templateId)
    if (template === undefined) return [{ path: `rules.${index}.templateId`, message: PICK_A_PROJECT_TEMPLATE }]
    if (template.purpose !== "service") return [{ path: `rules.${index}.templateId`, message: A_SERVICE_TEMPLATE }]
    const unfilled = [...new Set([...unfilledByNotice(rule.event, template.subject ?? ""), ...unfilledByNotice(rule.event, template.body)])]
    if (unfilled.length > 0) return [{ path: `rules.${index}.templateId`, message: notFilledByNotice(template.name, unfilled) }]
    return []
  })
  if (issues.length > 0) throw invalidRequest("body", issues)
  const inactive = rules.map((rule) => found.get(rule.templateId)).find((template) => template !== undefined && template.status !== "active")
  if (inactive !== undefined) throw problem(409, { detail: templateInactive(inactive.name) })
}

export function notificationRuleRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/projects/:id/notification-rules",
      describeRoute({
        operationId: "getNotificationRules",
        summary: "A project's customer notices",
        description:
          "Which customer notices the project sends and from which of its message templates: a Bulky Booking booked, cancelled, collected (its stop completed) or not collected (its stop failed); the collection reminder the afternoon before a scheduled collection; a ticket's reply to the customer and its completion; a route cancelled or running late (not started at its planned start), to the customers it stops for, in the notification areas the rule names or the whole project when it names none. In the vocabulary's order. A notice no rule names is not sent; a project without rules answers an empty list and sends none.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The project's rules.", NotificationRules),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`${MODULE}\`.`),
          404: describeProblem("No project with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const principal = c.get("principal")
        requireOwnProject(principal, id)
        const tx = c.get("tx")
        return c.json(rulesOf(id, await rulesIn(tx, principal.companyId, id), await areasIn(tx, principal.companyId, id)))
      },
    )
    .put(
      "/projects/:id/notification-rules",
      describeRoute({
        operationId: "putNotificationRules",
        summary: "Replace a project's customer notices",
        description: `Replaces the whole set with the one in the body: a notice the body leaves out is no longer sent, and an empty list sends none. Each notice is named once (400 at \`rules.N.event\`), from a template of the project (400 at \`rules.N.templateId\`, \`${PICK_A_PROJECT_TEMPLATE}\`) for service (400, \`${A_SERVICE_TEMPLATE}\`) naming no value its notice does not fill (400) that is active (409). Only a broadcast (\`route-cancelled\`, \`route-late\`) names \`planningAreaIds\`, each one of the project's \`notification\` areas (400 at \`rules.N.planningAreaIds\`, \`${A_NOTIFICATION_AREA}\`); none is the whole project. A rule the body keeps keeps its id and moves only its template, so the audit log reads one row's history per notice. The notices are sent from the next event on, through the deployment's messaging provider — a log-only sender until a provider is chosen — and only to a customer who allows service messages.`,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The project's rules as they now stand.", NotificationRules),
          400: describeProblem("The path does not hold an id, or the body is missing `rules`, names a member it does not own, names a notice twice, names a template that is not the project's, not for service or with a value its notice does not fill, or names an area that is not one of the project's notification areas."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`edit\` on \`${MODULE}\`.`),
          404: describeProblem("No project with that id in the projects this account works in."),
          409: describeProblem("A template named is inactive."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", NotificationRulesPut),
      async (c) => {
        const { id } = c.req.valid("param")
        const { rules } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireOwnProject(principal, id)
        await requireTemplates(tx, principal.companyId, id, rules)
        await requireAreas(tx, principal.companyId, id, rules)
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`notification-rules:${principal.companyId}:${id}`}, 0))`)
        const current = new Map((await rulesIn(tx, principal.companyId, id)).map((row) => [row.event, row]))
        const kept = new Set<string>(rules.map((rule) => rule.event))
        const gone = [...current.values()].filter((row) => !kept.has(row.event)).map((row) => row.id)
        if (gone.length > 0) {
          // A rule's areas go with it.
          await tx.delete(notificationRuleArea).where(and(eq(notificationRuleArea.companyId, principal.companyId), inArray(notificationRuleArea.ruleId, gone)))
          await tx.delete(notificationRule).where(and(eq(notificationRule.companyId, principal.companyId), inArray(notificationRule.id, gone)))
        }
        const rows: Row[] = []
        const fresh = rules.filter((rule) => !current.has(rule.event))
        if (fresh.length > 0) {
          rows.push(...(await tx.insert(notificationRule).values(fresh.map((rule) => ({ id: newId(), companyId: principal.companyId, projectId: id, event: rule.event, templateId: rule.templateId }))).returning(columns)))
        }
        for (const rule of rules) {
          const before = current.get(rule.event)
          if (before === undefined) continue
          if (before.templateId === rule.templateId) {
            rows.push(before)
            continue
          }
          const [row] = await tx
            .update(notificationRule)
            .set({ templateId: rule.templateId })
            .where(and(eq(notificationRule.companyId, principal.companyId), eq(notificationRule.id, before.id)))
            .returning(columns)
          rows.push(row)
        }
        // Each rule's areas replaced with it: an area the body keeps keeps its row, one it leaves out is deleted, the new ones go in one insert.
        const byEvent = new Map(rows.map((row) => [row.event, row.id]))
        const held = await areasIn(tx, principal.companyId, id)
        const wanted = rules.flatMap((rule) => (rule.planningAreaIds ?? []).map((planningAreaId) => ({ ruleId: byEvent.get(rule.event) as string, planningAreaId })))
        const key = (area: AreaRow) => `${area.ruleId}:${area.planningAreaId}`
        const wantedKeys = new Set(wanted.map(key))
        const heldKeys = new Set(held.map(key))
        for (const area of held.filter((row) => !wantedKeys.has(key(row)))) {
          await tx.delete(notificationRuleArea).where(and(eq(notificationRuleArea.companyId, principal.companyId), eq(notificationRuleArea.ruleId, area.ruleId), eq(notificationRuleArea.planningAreaId, area.planningAreaId)))
        }
        const added = wanted.filter((area) => !heldKeys.has(key(area)))
        if (added.length > 0) await tx.insert(notificationRuleArea).values(added.map((area) => ({ id: newId(), companyId: principal.companyId, projectId: id, ...area })))
        return c.json(rulesOf(id, rows, await areasIn(tx, principal.companyId, id)))
      },
    )
}
