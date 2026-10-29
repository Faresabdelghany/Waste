// Applications and their Decisions (M7 of #293,
// @waste/domain/registry/applications): a customer's written request to
// change how they are served or billed, and the office's verdict on it,
// under `customers.applications`. `GET /applications` lists them, `POST`
// records one as it arrives, `GET`/`PATCH /applications/:id` read one and
// correct it while it is undecided, and four commands move it — `review`,
// `decide`, `withdraw`, and `reopen` on an appeal — through the domain's
// APPLICATION_MOVES. `GET /applications/:id/decisions` is every Decision,
// oldest first. No delete: an Application is withdrawn, and a decision
// stands in the ledger it was appended to.
//
// The number is the company's running count, what a decision letter quotes:
// the highest plus one, taken under the company's row lock so two creates
// never meet, with `application_number_key` behind it. Each `decide` appends
// a Decision — `decided_by` the caller — and the latest rides on the
// Application; an appeal reopens it for review and the next decision follows
// the last. A decision emits `application-decided` to the outbox with the
// Application as it now stands: the seam each kind's effect is consumed from
// in its owner's lane (home composting and assisted collection by f6's
// consumers, a pause and a shared bin's split by 65's), which M7 does not
// apply itself. A status gates nothing here: an Application about a closed
// place or an inactive customer is still theirs to make, a fee correction
// most of all (statuses.ts records the exemption). What it names hangs
// together instead (`subjectRefusal`): the customer a party of the property,
// the subscription one of the customer's agreements at the place named.
import { Application, ApplicationCreate, ApplicationDecide, ApplicationListQuery, ApplicationPatch, DecisionHistory, ONE_PLACE, type Decision } from "@waste/contracts/applications"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { application, applicationDecision } from "@waste/db/schema/applications"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { propertyParty } from "@waste/db/schema/customers"
import { company } from "@waste/db/schema/organisation"
import { moveOf, moveRefusal, type ApplicationCommand } from "@waste/domain/registry/applications"
import type { ApplicationChannel, ApplicationKind, ApplicationStatus, DecisionOutcome } from "@waste/domain/registry/vocabulary"
import { and, asc, desc, eq, gt, inArray, max, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { emit } from "../outbox"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { projectToday } from "./fleet-lookups"
import { partyInForce } from "./property-writes"
import { requireCustomer, requireProperty, requireSharedCollectionPoint, requireSubscription } from "./references"
import { created, describeCreated, describeJson, IdParam, lockRow, stampsOf } from "./shared"
import type { ClockOptions } from "./scheme-groups"

const MODULE = "customers.applications"
const ApplicationPage = Page(Application)

const columns = {
  id: application.id,
  projectId: application.projectId,
  number: application.number,
  kind: application.kind,
  status: application.status,
  channel: application.channel,
  receivedOn: application.receivedOn,
  customerId: application.customerId,
  propertyId: application.propertyId,
  sharedCollectionPointId: application.sharedCollectionPointId,
  subscriptionId: application.subscriptionId,
  statement: application.statement,
  createdAt: application.createdAt,
  updatedAt: application.updatedAt,
}
type Row = Pick<typeof application.$inferSelect, keyof typeof columns>

const decisionColumns = {
  id: applicationDecision.id,
  applicationId: applicationDecision.applicationId,
  outcome: applicationDecision.outcome,
  conditions: applicationDecision.conditions,
  grantedFrom: applicationDecision.grantedFrom,
  grantedTo: applicationDecision.grantedTo,
  appealText: applicationDecision.appealText,
  decidedBy: applicationDecision.decidedBy,
  recordedAt: applicationDecision.recordedAt,
}
type DecisionRow = Pick<typeof applicationDecision.$inferSelect, keyof typeof decisionColumns>

const decisionOf = (row: DecisionRow): Decision => ({
  id: row.id,
  applicationId: row.applicationId,
  outcome: row.outcome as DecisionOutcome,
  conditions: row.conditions,
  validFrom: row.grantedFrom,
  validTo: row.grantedTo,
  appealText: row.appealText,
  decidedBy: row.decidedBy,
  decidedAt: row.recordedAt.toISOString(),
})

const applicationOf = (row: Row, decision: DecisionRow | undefined): Application => ({
  id: row.id,
  projectId: row.projectId,
  number: row.number,
  kind: row.kind as ApplicationKind,
  status: row.status as ApplicationStatus,
  channel: row.channel as ApplicationChannel,
  receivedOn: row.receivedOn,
  customerId: row.customerId,
  propertyId: row.propertyId,
  sharedCollectionPointId: row.sharedCollectionPointId,
  subscriptionId: row.subscriptionId,
  statement: row.statement,
  decision: decision === undefined ? null : decisionOf(decision),
  ...stampsOf(row),
})

/** Each Application's latest Decision, by application id, in one statement. */
async function latestDecisions(tx: Tx, companyId: string, ids: readonly string[]): Promise<Map<string, DecisionRow>> {
  if (ids.length === 0) return new Map()
  const rows = await tx
    .selectDistinctOn([applicationDecision.applicationId], decisionColumns)
    .from(applicationDecision)
    .where(and(eq(applicationDecision.companyId, companyId), inArray(applicationDecision.applicationId, [...ids])))
    .orderBy(applicationDecision.applicationId, desc(applicationDecision.id))
  return new Map(rows.map((row) => [row.applicationId, row]))
}

/** The rows of the caller's projects: what every Application statement is bounded by. */
const scope = (principal: Principal) => and(eq(application.companyId, principal.companyId), inProjects(application.projectId, principal))

const noSuchApplication = (id: string) => problem(404, { detail: `No application ${id} in the projects this account works in` })
const labelOf = (row: Pick<Row, "number">) => `Application ${row.number}`

async function findApplication(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(application)
    .where(and(scope(principal), eq(application.id, id)))
    .limit(1)
  return row
}

/** One Application on the wire, with its latest Decision. */
async function answer(tx: Tx, companyId: string, row: Row): Promise<Application> {
  return applicationOf(row, (await latestDecisions(tx, companyId, [row.id])).get(row.id))
}

/** The places and the subscription a body names: each the Application's project's. */
async function requireSubject(tx: Tx, principal: Principal, projectId: string, body: { propertyId?: string | null; sharedCollectionPointId?: string | null; subscriptionId?: string | null }): Promise<void> {
  const subject = { companyId: principal.companyId, projectId }
  await requireProperty(tx, subject, body.propertyId)
  await requireSharedCollectionPoint(tx, subject, body.sharedCollectionPointId)
  await requireSubscription(tx, subject, body.subscriptionId)
}

type Subject = Pick<Row, "customerId" | "propertyId" | "sharedCollectionPointId" | "subscriptionId">

export const NOT_A_PARTY = "The customer is not a party of this property"
export const NOT_THE_CUSTOMERS = "Not a subscription of this customer's agreements"
export const ANOTHER_PLACE = "The subscription serves another place than the application names"
export const RECEIVED_AHEAD = "An application is received on or before today on the project's clock"

/**
 * Whether what an Application names hangs together, each already proved the
 * project's: the customer is a party of the property today, in any role; the
 * subscription is under one of the customer's agreements, as its customer or
 * its payer, and serves the place named, where one is. A shared point has no
 * parties, so any customer may name one. Answers which rule fails.
 */
async function subjectRefusal(tx: Tx, companyId: string, subject: Subject, checks: { party: boolean; subscription: boolean }, now: Date): Promise<"party" | "customer" | "place" | undefined> {
  if (checks.party && subject.propertyId !== null) {
    const [party] = await tx
      .select({ id: propertyParty.id })
      .from(propertyParty)
      .where(and(eq(propertyParty.companyId, companyId), eq(propertyParty.propertyId, subject.propertyId), eq(propertyParty.customerId, subject.customerId), partyInForce(now)))
      .limit(1)
    if (party === undefined) return "party"
  }
  if (checks.subscription && subject.subscriptionId !== null) {
    const [held] = await tx
      .select({ propertyId: subscription.propertyId, sharedCollectionPointId: subscription.sharedCollectionPointId, customerId: agreement.customerId, payerCustomerId: agreement.payerCustomerId })
      .from(subscription)
      .innerJoin(agreement, and(eq(agreement.companyId, subscription.companyId), eq(agreement.id, subscription.agreementId)))
      .where(and(eq(subscription.companyId, companyId), eq(subscription.id, subject.subscriptionId)))
      .limit(1)
    if (held.customerId !== subject.customerId && held.payerCustomerId !== subject.customerId) return "customer"
    if (subject.propertyId !== null && held.propertyId !== subject.propertyId) return "place"
    if (subject.sharedCollectionPointId !== null && held.sharedCollectionPointId !== subject.sharedCollectionPointId) return "place"
  }
  return undefined
}

const SUBJECT_SENTENCES = { party: NOT_A_PARTY, customer: NOT_THE_CUSTOMERS, place: ANOTHER_PLACE } as const

const commonProblems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

/** A command's route: the row locked, its move judged by the domain, and the status written; `decide` appends its Decision first. */
async function moved(tx: Tx, principal: Principal, id: string, command: ApplicationCommand): Promise<Row> {
  await lockRow(tx, application, { companyId: principal.companyId, id })
  const current = await findApplication(tx, principal, id)
  if (current === undefined) throw noSuchApplication(id)
  // A withdrawal from review after an appeal withdraws the appeal: back to the Decision the Application has.
  const decided = command === "withdraw" && (await latestDecisions(tx, principal.companyId, [id])).has(id)
  const next = moveOf(current.status as ApplicationStatus, command, decided)
  if (next === null) throw problem(409, { detail: moveRefusal(labelOf(current), current.status as ApplicationStatus, command) })
  const [row] = await tx
    .update(application)
    .set({ status: next })
    .where(and(eq(application.companyId, principal.companyId), eq(application.id, id)))
    .returning(columns)
  return row
}

export function applicationRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  const command = (name: "review" | "withdraw" | "reopen", summary: string, description: string) =>
    describeRoute({
      operationId: `${name}Application`,
      summary,
      description,
      security: BEARER_SECURITY,
      responses: {
        200: describeJson("The application as it now stands, with its latest decision.", Application),
        400: describeProblem("The path does not hold an id."),
        ...commonProblems("edit"),
        404: describeProblem("No application with that id in the projects this account works in."),
        409: describeProblem("The application stands where the command does not take it, in the domain's sentence."),
      },
    })

  return new Hono<AuthEnv>()
    .get(
      "/applications",
      describeRoute({
        operationId: "listApplications",
        summary: "The applications",
        description:
          "One page of the Applications of the projects the caller works in, oldest first (ids are time-ordered), each with its latest Decision. `projectId` narrows it to one of those projects, naming another is refused; `customerId`, `kind` and `status` narrow it further; `inForceOn` keeps the Applications whose latest Decision is a grant, whole or in part, whose period holds that day, `validFrom` inclusive and `validTo` exclusive, whatever their status — a grant stands while an appeal against it is reviewed — expired being a reading of the period, never a status. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of applications.", ApplicationPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a filter is not of the vocabulary or not a day, or `projectId` is not a project this account works in."),
          ...commonProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", ApplicationListQuery),
      async (c) => {
        const { limit, cursor, projectId, customerId, kind, status, inForceOn } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        // The latest decision of each, as a correlated id: a grant in force on the day is the latest's period holding it.
        const latestId = sql`(select ${applicationDecision.id} from ${applicationDecision} where ${applicationDecision.companyId} = ${application.companyId} and ${applicationDecision.applicationId} = ${application.id} order by ${applicationDecision.id} desc limit 1)`
        const inForce =
          inForceOn === undefined
            ? undefined
            : sql`exists (select 1 from ${applicationDecision} where ${applicationDecision.id} = ${latestId} and ${applicationDecision.outcome} <> 'refused' and ${applicationDecision.grantedFrom} <= ${inForceOn}::date and (${applicationDecision.grantedTo} is null or ${applicationDecision.grantedTo} > ${inForceOn}::date))`
        const rows = await tx
          .select(columns)
          .from(application)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(application.projectId, projectId),
              customerId === undefined ? undefined : eq(application.customerId, customerId),
              kind === undefined ? undefined : eq(application.kind, kind),
              status === undefined ? undefined : eq(application.status, status),
              inForce,
              after === undefined ? undefined : gt(application.id, after),
            ),
          )
          .orderBy(asc(application.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        const decisions = await latestDecisions(tx, principal.companyId, items.map((row) => row.id))
        return c.json({ items: items.map((row) => applicationOf(row, decisions.get(row.id))), nextCursor })
      },
    )
    .post(
      "/applications",
      describeRoute({
        operationId: "createApplication",
        summary: "Record an application",
        description:
          "Records an Application as it reached the office, `received`: its kind, how it came (`channel`) and the day it did (`receivedOn`), the customer — one of the company's (400 at `customerId`) — and, where it names them, one place, a property or a shared collection point of the project, and a subscription of the project (400 at the field otherwise), and the customer's statement. What it names hangs together (400 at the field): the customer is a party of the property, in any role, and the subscription is under one of the customer's agreements, as its customer or its payer, serving the place named where one is; a shared point has no parties, so any customer may name one. `receivedOn` is no later than today on the project's clock. The server numbers it, the company's next, and mints the id. No status gates it: an Application about a closed place or from an inactive customer is still theirs to make.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The application as it was recorded.", Application),
          400: describeProblem("The body is missing a field, names a member the server owns (the number, the status, a decision), names both a property and a shared collection point, a value outside the vocabulary, a project this account does not work in, a customer, place or subscription that is not the project's, a property the customer is not a party of, a subscription not the customer's or serving another place, or a day received after today."),
          ...commonProblems("create"),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", ApplicationCreate),
      async (c) => {
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, body.projectId)
        if (body.receivedOn > (await projectToday(tx, { companyId: principal.companyId, projectId: body.projectId }, now)())) throw invalidRequest("body", [{ path: "receivedOn", message: RECEIVED_AHEAD }])
        await requireCustomer(tx, principal.companyId, body.customerId)
        await requireSubject(tx, principal, body.projectId, body)
        const subject = { customerId: body.customerId, propertyId: body.propertyId ?? null, sharedCollectionPointId: body.sharedCollectionPointId ?? null, subscriptionId: body.subscriptionId ?? null }
        const refused = await subjectRefusal(tx, principal.companyId, subject, { party: true, subscription: true }, now())
        if (refused !== undefined) throw invalidRequest("body", [{ path: refused === "party" ? "propertyId" : "subscriptionId", message: SUBJECT_SENTENCES[refused] }])
        // The company's row first, so two creates take the next number one after the other; a key share, so the company's children still insert beside it.
        await tx.select({ id: company.id }).from(company).where(eq(company.id, principal.companyId)).limit(1).for("no key update")
        const [{ highest }] = await tx.select({ highest: max(application.number) }).from(application).where(eq(application.companyId, principal.companyId))
        const [row] = await tx
          .insert(application)
          .values({
            ...body,
            propertyId: body.propertyId ?? null,
            sharedCollectionPointId: body.sharedCollectionPointId ?? null,
            subscriptionId: body.subscriptionId ?? null,
            id: newId(),
            companyId: principal.companyId,
            number: (highest ?? 0) + 1,
          })
          .returning(columns)
        return created(c, "/applications", applicationOf(row, undefined))
      },
    )
    .get(
      "/applications/:id",
      describeRoute({
        operationId: "getApplication",
        summary: "One application",
        description: "One Application of the projects the caller works in, with its latest Decision. One of another project, or another company, is one that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The application.", Application),
          400: describeProblem("The path does not hold an id."),
          ...commonProblems("view"),
          404: describeProblem("No application with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findApplication(tx, principal, id)
        if (row === undefined) throw noSuchApplication(id)
        return c.json(await answer(tx, principal.companyId, row))
      },
    )
    .patch(
      "/applications/:id",
      describeRoute({
        operationId: "patchApplication",
        summary: "Correct an application",
        description:
          "Corrects an undecided Application — `received` or `in-review` — in its kind, channel, day received, place, subscription or statement; at least one must be given. The project and the customer are its own: another customer's request is another Application. A decided or withdrawn one is not corrected (409): reopen it on an appeal first.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The application as it now stands.", Application),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a member the caller does not own, names both a property and a shared collection point, a place or subscription that is not the project's, a property the customer is not a party of, a subscription not the customer's or serving another place than the Application ends with, or a day received after today."),
          ...commonProblems("edit"),
          404: describeProblem("No application with that id in the projects this account works in."),
          409: describeProblem("The application is decided or withdrawn."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ApplicationPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockRow(tx, application, { companyId: principal.companyId, id })
        const current = await findApplication(tx, principal, id)
        if (current === undefined) throw noSuchApplication(id)
        if (current.status !== "received" && current.status !== "in-review") throw problem(409, { detail: `${labelOf(current)} is ${current.status}; a correction takes one received or in review` })
        // The place the row ends with is one place at most, whichever field the patch moves.
        const propertyId = patch.propertyId === undefined ? current.propertyId : patch.propertyId
        const sharedCollectionPointId = patch.sharedCollectionPointId === undefined ? current.sharedCollectionPointId : patch.sharedCollectionPointId
        if (propertyId !== null && sharedCollectionPointId !== null) throw invalidRequest("body", [{ path: patch.sharedCollectionPointId === undefined ? "propertyId" : "sharedCollectionPointId", message: ONE_PLACE }])
        await requireSubject(tx, principal, current.projectId, patch)
        if (patch.receivedOn !== undefined && patch.receivedOn > (await projectToday(tx, { companyId: principal.companyId, projectId: current.projectId }, now)())) throw invalidRequest("body", [{ path: "receivedOn", message: RECEIVED_AHEAD }])
        // The row as it would end, judged where the patch moves the property or the subscription: a place moved under a kept subscription is told at the place.
        const placeMoved = patch.propertyId !== undefined || patch.sharedCollectionPointId !== undefined
        const subject = { customerId: current.customerId, propertyId, sharedCollectionPointId, subscriptionId: patch.subscriptionId === undefined ? current.subscriptionId : patch.subscriptionId }
        const refused = await subjectRefusal(tx, principal.companyId, subject, { party: patch.propertyId !== undefined, subscription: placeMoved || patch.subscriptionId !== undefined }, now())
        if (refused !== undefined) {
          const path = refused === "party" ? "propertyId" : refused === "customer" || patch.subscriptionId !== undefined ? "subscriptionId" : patch.propertyId !== undefined ? "propertyId" : "sharedCollectionPointId"
          throw invalidRequest("body", [{ path, message: SUBJECT_SENTENCES[refused] }])
        }
        const [row] = await tx
          .update(application)
          .set(patch)
          .where(and(eq(application.companyId, principal.companyId), eq(application.id, id)))
          .returning(columns)
        return c.json(await answer(tx, principal.companyId, row))
      },
    )
    .post(
      "/applications/:id/review",
      command("review", "Take an application into review", "Moves a `received` Application into review (409 from anywhere else)."),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      async (c) => {
        const tx = c.get("tx")
        const principal = c.get("principal")
        return c.json(await answer(tx, principal.companyId, await moved(tx, principal, c.req.valid("param").id, "review")))
      },
    )
    .post(
      "/applications/:id/decide",
      describeRoute({
        operationId: "decideApplication",
        summary: "Decide an application",
        description:
          "Decides an Application `received` or `in-review` (409 from anywhere else): appends a Decision — the outcome, what it holds the customer to (`conditions`), its period, and how to appeal it — made by the caller, and moves the Application to `decided`. A grant, whole or in part, names its first day in force and, where it ends, its first day out (ADR-0005); a refusal is in force for no period; anything less than a grant in full says how to appeal it (400 at the field otherwise, in the domain's sentences). Emits `application-decided` with the Application as it now stands, its new Decision on it: the seam each kind's effect is consumed from in its owner's lane, which this route does not apply.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The application as it now stands, with its new decision.", Application),
          400: describeProblem("The path does not hold an id, or the body names an outcome outside the vocabulary, a grant without its first day, a refusal with a period, an end on or before the start, or less than a grant in full without its appeal text."),
          ...commonProblems("edit"),
          404: describeProblem("No application with that id in the projects this account works in."),
          409: describeProblem("The application is decided or withdrawn: reopen a decided one on an appeal first."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ApplicationDecide),
      async (c) => {
        const { id } = c.req.valid("param")
        const body = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await moved(tx, principal, id, "decide")
        const at = now()
        await tx.insert(applicationDecision).values({
          id: newId(),
          companyId: principal.companyId,
          projectId: row.projectId,
          applicationId: row.id,
          outcome: body.outcome,
          conditions: body.conditions ?? null,
          grantedFrom: body.validFrom ?? null,
          grantedTo: body.validTo ?? null,
          appealText: body.appealText ?? null,
          decidedBy: principal.user.id,
          recordedAt: at,
        })
        const decided = await answer(tx, principal.companyId, row)
        await emit(tx, { companyId: principal.companyId }, { aggregate: "application", aggregateId: row.id, kind: "application-decided", payload: decided, projectId: row.projectId, occurredAt: at })
        return c.json(decided)
      },
    )
    .post(
      "/applications/:id/withdraw",
      command("withdraw", "Withdraw an application", "Withdraws an Application at the customer's word: one `received` or `in-review` and never decided moves to `withdrawn` and moves no more; one in review on an appeal withdraws the appeal and goes back to `decided`, its Decision standing (409 from anywhere else)."),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      async (c) => {
        const tx = c.get("tx")
        const principal = c.get("principal")
        return c.json(await answer(tx, principal.companyId, await moved(tx, principal, c.req.valid("param").id, "withdraw")))
      },
    )
    .post(
      "/applications/:id/reopen",
      command("reopen", "Reopen an application on an appeal", "Moves a `decided` Application back into review, on the customer's appeal (409 from anywhere else). Its Decision stands in the ledger and rides on it until the next `decide` appends another."),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      async (c) => {
        const tx = c.get("tx")
        const principal = c.get("principal")
        return c.json(await answer(tx, principal.companyId, await moved(tx, principal, c.req.valid("param").id, "reopen")))
      },
    )
    .get(
      "/applications/:id/decisions",
      describeRoute({
        operationId: "listApplicationDecisions",
        summary: "An application's decisions",
        description: "Every Decision of one Application of the projects the caller works in, oldest first: the first and every one an appeal led to.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The decisions, oldest first.", DecisionHistory),
          400: describeProblem("The path does not hold an id."),
          ...commonProblems("view"),
          404: describeProblem("No application with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findApplication(tx, principal, id)
        if (row === undefined) throw noSuchApplication(id)
        const rows = await tx
          .select(decisionColumns)
          .from(applicationDecision)
          .where(and(eq(applicationDecision.companyId, principal.companyId), eq(applicationDecision.applicationId, id)))
          .orderBy(asc(applicationDecision.id))
        return c.json({ items: rows.map(decisionOf) })
      },
    )
}
