// A project's notification rules (O16 of #290, part b): which customer
// notices the project sends and from which of its message templates — a Bulky
// Booking booked, cancelled, collected or not collected. `GET
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
// a service message, which the customer's consent governs) and active (409,
// in `queueMessage`'s sentence) — judged at the write, and again at the send,
// where a template made inactive since refuses the notice. The set is written
// in place, as the Ticket SLA's is: a rule the body keeps keeps its id and
// moves only its template, one the body leaves out is deleted, under a
// transaction-scoped advisory lock on the set. The project is a path's row,
// its 404 the family's.
import { NotificationRules, NotificationRulesPut, type CustomerNoticeEvent, type NotificationRule } from "@waste/contracts/notifications"
import type { Tx } from "@waste/db/client"
import { templateInactive } from "@waste/db/commands/messaging"
import { messageTemplate } from "@waste/db/schema/messaging"
import { notificationRule } from "@waste/db/schema/notifications"
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

const columns = { id: notificationRule.id, event: notificationRule.event, templateId: notificationRule.templateId }
type Row = { id: string; event: string; templateId: string }

const noSuchProject = (id: string) => problem(404, { detail: `No project ${id} in the projects this account works in` })

function requireOwnProject(principal: Principal, id: string): void {
  if (!projectIdsOf(principal).includes(id)) throw noSuchProject(id)
}

const rulesOf = (projectId: string, rows: readonly Row[]): NotificationRules => ({
  projectId,
  rules: [...rows]
    .sort((a, b) => CUSTOMER_NOTICE_EVENTS.indexOf(a.event as CustomerNoticeEvent) - CUSTOMER_NOTICE_EVENTS.indexOf(b.event as CustomerNoticeEvent))
    .map((row): NotificationRule => ({ event: row.event as CustomerNoticeEvent, templateId: row.templateId })),
})

async function rulesIn(tx: Tx, companyId: string, projectId: string): Promise<Row[]> {
  return await tx
    .select(columns)
    .from(notificationRule)
    .where(and(eq(notificationRule.companyId, companyId), eq(notificationRule.projectId, projectId)))
}

/** Each rule's template held to the project and to service (400 at its field), then to active (409). */
async function requireTemplates(tx: Tx, companyId: string, projectId: string, rules: readonly NotificationRule[]): Promise<void> {
  const ids = [...new Set(rules.map((rule) => rule.templateId))]
  if (ids.length === 0) return
  const found = new Map(
    (
      await tx
        .select({ id: messageTemplate.id, name: messageTemplate.name, purpose: messageTemplate.purpose, status: messageTemplate.status })
        .from(messageTemplate)
        .where(and(eq(messageTemplate.companyId, companyId), eq(messageTemplate.projectId, projectId), inArray(messageTemplate.id, ids)))
    ).map((row) => [row.id, row]),
  )
  const issues = rules.flatMap((rule, index) => {
    const template = found.get(rule.templateId)
    if (template === undefined) return [{ path: `rules.${index}.templateId`, message: PICK_A_PROJECT_TEMPLATE }]
    if (template.purpose !== "service") return [{ path: `rules.${index}.templateId`, message: A_SERVICE_TEMPLATE }]
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
          "Which customer notices the project sends and from which of its message templates: a Bulky Booking booked, cancelled, collected (its stop completed) or not collected (its stop failed). In the vocabulary's order. A notice no rule names is not sent; a project without rules answers an empty list and sends none.",
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
        return c.json(rulesOf(id, await rulesIn(c.get("tx"), principal.companyId, id)))
      },
    )
    .put(
      "/projects/:id/notification-rules",
      describeRoute({
        operationId: "putNotificationRules",
        summary: "Replace a project's customer notices",
        description: `Replaces the whole set with the one in the body: a notice the body leaves out is no longer sent, and an empty list sends none. Each notice is named once (400 at \`rules.N.event\`), from a template of the project (400 at \`rules.N.templateId\`, \`${PICK_A_PROJECT_TEMPLATE}\`) for service (400, \`${A_SERVICE_TEMPLATE}\`) that is active (409). A rule the body keeps keeps its id and moves only its template, so the audit log reads one row's history per notice. The notices are sent from the next event on, through the deployment's messaging provider — a log-only sender until a provider is chosen — and only to a customer who allows service messages.`,
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The project's rules as they now stand.", NotificationRules),
          400: describeProblem("The path does not hold an id, or the body is missing `rules`, names a member it does not own, names a notice twice, or names a template that is not the project's or not for service."),
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
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`notification-rules:${principal.companyId}:${id}`}, 0))`)
        const current = new Map((await rulesIn(tx, principal.companyId, id)).map((row) => [row.event, row]))
        const kept = new Set<string>(rules.map((rule) => rule.event))
        const gone = [...current.values()].filter((row) => !kept.has(row.event)).map((row) => row.id)
        if (gone.length > 0) await tx.delete(notificationRule).where(and(eq(notificationRule.companyId, principal.companyId), inArray(notificationRule.id, gone)))
        const rows: Row[] = []
        const added = rules.filter((rule) => !current.has(rule.event))
        if (added.length > 0) {
          rows.push(...(await tx.insert(notificationRule).values(added.map((rule) => ({ id: newId(), companyId: principal.companyId, projectId: id, event: rule.event, templateId: rule.templateId }))).returning(columns)))
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
        return c.json(rulesOf(id, rows))
      },
    )
}
