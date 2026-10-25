// The Pickup Exceptions (Issue #293, M5a): a project's charge rules, under
// `commercial.price-rows` beside the price lists they charge from, and a
// place's exception history as the rules judge it now
// (@waste/domain/execution/pickup-exceptions).
//
// A rule is effective-dated (ADR-0005): its outcome, reason and code are its
// key, and two alike are never in force at once (`pickup_exception_rule_no_overlap`,
// a 409). A patch moves the free count, the window, the ladder — replaced
// whole, by position — and the end, under the rule's row lock. A step names a
// product of the rule's project that is an additional service sold per job
// (400 at `ladder.N`), and an active one where the step is new (409, the
// status gate of routes/statuses.ts); a code names one of the company's
// (400), and an active one (409).
//
// The history reads a Property's or a Shared Collection Point's exceptions
// under two grants, the place's module and the stops': each stop missed for a
// reason the customer caused, or collected but tagged, newest service date
// first from `from` on (the 365 days before the project's today when absent),
// at most `PICKUP_EXCEPTION_HISTORY_MAX`, with the latest proof recording its outcome
// as its evidence and the rules' judgement now — counted over the stops at
// the place in each rule's window, read from before `from` as far as the
// longest window reaches. Nothing is charged here: the charge is M5b's, judged
// once at the stop's event and never re-stepped by a later correction.
import { Page } from "@waste/contracts/pagination"
import {
  PICKUP_EXCEPTION_HISTORY_MAX,
  PickupException,
  PickupExceptionHistory,
  PickupExceptionHistoryQuery,
  PickupExceptionRule,
  PickupExceptionRuleCreate,
  PickupExceptionRuleListQuery,
  PickupExceptionRulePatch,
  type PickupExceptionReason,
} from "@waste/contracts/pickup-exceptions"
import type { ProductStatus } from "@waste/contracts/catalogue"
import type { ContaminantCodeStatus } from "@waste/contracts/pickup-exceptions"
import type { Tx } from "@waste/db/client"
import { exceptionRulesOf, laddersOf, latestOutcomeProofs, pickupExceptionRows } from "@waste/db/commands/pickup-exceptions"
import { validOn } from "@waste/db/query/valid-on"
import { product } from "@waste/db/schema/catalogue"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import { pickup, route } from "@waste/db/schema/execution"
import { project } from "@waste/db/schema/organisation"
import { contaminantCode, contaminantCodeFraction, pickupExceptionRule, pickupExceptionRuleStep } from "@waste/db/schema/pickup-exceptions"
import { judgeException, type PickupExceptionStop } from "@waste/domain/execution/pickup-exceptions"
import { addDays } from "@waste/domain/route-schemes/recurrence"
import { type PickupOrigin, type PickupOutcome, type PickupReason, type PickupService, type PickupStatus } from "@waste/domain/execution/vocabulary"
import { and, asc, desc, eq, gt, gte, inArray } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { dayInTimezone } from "./days"
import { periodAfter, requireOrdered } from "./periods"
import { refuseRetiredCode, unofferedStep } from "./statuses"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseOverlap, stamp, stampsOf } from "./shared"

const MODULE = "commercial.price-rows"
const STOPS = "route-studio.pickups"

const RulePage = Page(PickupExceptionRule)

type ClockOptions = { now?: () => Date }

const columns = {
  id: pickupExceptionRule.id,
  projectId: pickupExceptionRule.projectId,
  validFrom: pickupExceptionRule.validFrom,
  validTo: pickupExceptionRule.validTo,
  outcome: pickupExceptionRule.outcome,
  reason: pickupExceptionRule.reason,
  contaminantCodeId: pickupExceptionRule.contaminantCodeId,
  freeCount: pickupExceptionRule.freeCount,
  windowDays: pickupExceptionRule.windowDays,
  createdAt: pickupExceptionRule.createdAt,
  updatedAt: pickupExceptionRule.updatedAt,
}

type Row = Pick<typeof pickupExceptionRule.$inferSelect, keyof typeof columns>

function ruleOf(row: Row, ladder: readonly string[]): PickupExceptionRule {
  return {
    id: row.id,
    projectId: row.projectId,
    outcome: row.outcome as PickupOutcome,
    reason: row.reason as PickupExceptionReason | null,
    contaminantCodeId: row.contaminantCodeId,
    freeCount: row.freeCount,
    windowDays: row.windowDays,
    ladder: [...ladder],
    validFrom: row.validFrom,
    validTo: row.validTo,
    ...stampsOf(row),
  }
}

const RULE_RUNNING = "pickup_exception_rule_no_overlap"
const RULE_RUNNING_SENTENCE = "A rule for this outcome, reason and code is already in force over part of that period; end it first or schedule this one after it"

/** What a step naming a product that is not an additional service sold per job is told. */
export const NOT_A_STEP = "A step charges an additional service of this project sold per job"
/** What a rule naming a code that is not the company's is told. */
export const NOT_A_CODE = "Not a contaminant code of this company"

const noSuchRule = (id: string) => problem(404, { detail: `No pickup exception rule ${id} in the projects this account works in` })

/** This company's rules, in the projects the caller works in. */
const ruleScope = (principal: Principal) => and(eq(pickupExceptionRule.companyId, principal.companyId), inProjects(pickupExceptionRule.projectId, principal))

async function findRule(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(pickupExceptionRule)
    .where(and(ruleScope(principal), eq(pickupExceptionRule.id, id)))
    .limit(1)
  return row
}

/**
 * Holds a ladder to its project's products: every step a product of the
 * project sold per job as an additional service (400 at `ladder.N`), then
 * every step new to the rule an active product (409). A step is new unless the
 * stored ladder names the same product at the same position: that one keeps
 * its product whatever its status now, since a status gates a new reference,
 * never an existing one — and a withdrawn product moved or repeated is new.
 */
async function requireLadder(tx: Tx, companyId: string, projectId: string, ladder: readonly string[], kept: readonly string[] = []): Promise<void> {
  const found = await tx
    .select({ id: product.id, kind: product.kind, unit: product.unit, status: product.status })
    .from(product)
    .where(and(eq(product.companyId, companyId), eq(product.projectId, projectId), inArray(product.id, [...new Set(ladder)])))
  const byId = new Map(found.map((row) => [row.id, row]))
  const wrong = ladder.flatMap((id, index) => {
    const step = byId.get(id)
    return step !== undefined && step.kind === "additional-service" && step.unit === "job" ? [] : [{ path: `ladder.${index}`, message: NOT_A_STEP }]
  })
  if (wrong.length > 0) throw invalidRequest("body", wrong)
  ladder.forEach((id, index) => {
    const status = byId.get(id)?.status as ProductStatus | undefined
    if (status !== undefined && status !== "active" && kept[index] !== id) throw problem(409, { detail: unofferedStep(index + 1, status) })
  })
}

/** The code a body names, as its slug and status: one of the company's, or the 400 at `contaminantCodeId`. The one lookup a rule and a tag share. */
async function codeNamed(tx: Tx, companyId: string, id: string): Promise<{ code: string; status: ContaminantCodeStatus }> {
  const [found] = await tx
    .select({ code: contaminantCode.code, status: contaminantCode.status })
    .from(contaminantCode)
    .where(and(eq(contaminantCode.companyId, companyId), eq(contaminantCode.id, id)))
    .limit(1)
  if (found === undefined) throw invalidRequest("body", [{ path: "contaminantCodeId", message: NOT_A_CODE }])
  return { code: found.code, status: found.status as ContaminantCodeStatus }
}

/** Holds a code a new rule names to the company's, and an active one. */
async function requireRuleCode(tx: Tx, companyId: string, id: string | null | undefined): Promise<void> {
  if (id == null) return
  const found = await codeNamed(tx, companyId, id)
  refuseRetiredCode(found.status, found.code, "a rule")
}

/** Writes a rule's ladder, position 1 first. */
async function writeLadder(tx: Tx, rule: { companyId: string; projectId: string; id: string }, ladder: readonly string[]): Promise<void> {
  await tx.insert(pickupExceptionRuleStep).values(
    ladder.map((productId, index) => ({ id: newId(), companyId: rule.companyId, projectId: rule.projectId, ruleId: rule.id, position: index + 1, productId })),
  )
}

const commonProblems = (action: "view" | "edit" | "create", module = MODULE) => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${module}\`.`),
})

// ---------------------------------------------------------------------------
// The exception history
// ---------------------------------------------------------------------------

/** The place a history is read at: a Property or a Shared Collection Point, by its column on the stop. */
type Place = { kind: "property" | "point"; id: string }

/** The most exception rows one history reads, its window's reach included; a place past it is answered from its newest rows and told `truncated`. */
const HISTORY_READ_MAX = 5000

/** One place's history: its exceptions from `from` on, newest first, judged by its project's rules over the stops at the place in each rule's window. */
async function historyAt(tx: Tx, companyId: string, projectId: string, place: Place, from: string): Promise<PickupExceptionHistory> {
  const rules = await exceptionRulesOf(tx, companyId, projectId)
  const reach = Math.max(0, ...rules.map((rule) => rule.windowDays))
  const placeColumn = place.kind === "property" ? pickup.propertyId : pickup.sharedCollectionPointId
  const read = await tx
    .select({
      id: pickup.id,
      routeId: pickup.routeId,
      projectId: pickup.projectId,
      serviceDate: route.serviceDate,
      status: pickup.status,
      reason: pickup.reason,
      contaminantCodeId: pickup.contaminantCodeId,
      origin: pickup.origin,
      service: pickup.service,
      propertyId: pickup.propertyId,
      sharedCollectionPointId: pickup.sharedCollectionPointId,
    })
    .from(pickup)
    .innerJoin(route, and(eq(route.companyId, pickup.companyId), eq(route.id, pickup.routeId)))
    .where(and(eq(pickup.companyId, companyId), eq(pickup.projectId, projectId), eq(placeColumn, place.id), gte(route.serviceDate, addDays(from, -reach)), pickupExceptionRows()))
    .orderBy(desc(route.serviceDate), desc(pickup.id))
    .limit(HISTORY_READ_MAX + 1)
  // The statement's filter is the domain's `isPickupException` in SQL, so every row read is an exception: the history the rules count over.
  const rows = read.slice(0, HISTORY_READ_MAX)
  const history: PickupExceptionStop[] = rows.map((row) => ({
    id: row.id,
    status: row.status as PickupStatus,
    reason: row.reason as PickupReason | null,
    contaminantCodeId: row.contaminantCodeId,
    origin: row.origin as PickupOrigin,
    service: row.service as PickupService,
    serviceDate: row.serviceDate,
    place: place.id,
  }))
  const shown = rows.flatMap((row, index) => (row.serviceDate >= from ? [{ row, stop: history[index] }] : []))
  const page = shown.slice(0, PICKUP_EXCEPTION_HISTORY_MAX)
  const evidence = await latestOutcomeProofs(
    tx,
    companyId,
    page.map(({ row }) => row.id),
  )
  return {
    items: page.map(
      ({ row, stop }): PickupException => ({
        pickupId: row.id,
        routeId: row.routeId,
        projectId: row.projectId,
        serviceDate: row.serviceDate,
        status: stop.status,
        reason: stop.reason,
        contaminantCodeId: row.contaminantCodeId,
        origin: stop.origin,
        service: stop.service,
        propertyId: row.propertyId,
        sharedCollectionPointId: row.sharedCollectionPointId,
        evidenceProofId: evidence.get(row.id) ?? null,
        judgement: judgeException(stop, rules, history),
      }),
    ),
    truncated: shown.length > page.length || read.length > HISTORY_READ_MAX,
  }
}

/** The first service date a history reads when the query names none: the 365 days before the project's today. */
async function defaultFrom(tx: Tx, companyId: string, projectId: string, now: Date): Promise<string> {
  const [found] = await tx
    .select({ timezone: project.timezone })
    .from(project)
    .where(and(eq(project.companyId, companyId), eq(project.id, projectId)))
    .limit(1)
  return addDays(dayInTimezone(now, found?.timezone ?? "UTC"), -365)
}

const historyDescription = (place: string) =>
  `The ${place}'s Pickup Exceptions: each stop there missed for a reason the customer caused — contamination, a bin not presented, a bin not reached, or the driver's other — or collected but tagged with a contaminant code, newest service date first from \`from\` on (the 365 days before the project's today when absent), at most ${PICKUP_EXCEPTION_HISTORY_MAX} with \`truncated\` saying whether more were left out. Each names the proof that recorded its outcome — the driver's, or the office's correction — and what the project's rules in force on its service date say of it now: the rule, how many matching exceptions came before it at this ${place} in the rule's window, and the ladder's product once the free count is spent, null while free. A stop the office added, or a work order, is listed with no judgement: neither is charged. Nothing here is a charge; the charge is judged once at the stop's event (M5b) and a later correction never re-steps it.`

export function pickupExceptionRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: ClockOptions = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/pickup-exception-rules",
      describeRoute({
        operationId: "listPickupExceptionRules",
        summary: "The projects' pickup exception rules",
        description:
          "One page of the rules that may charge a Pickup Exception, oldest first (ids are time-ordered), from the projects the caller works in, each with its ladder by position. `projectId` narrows it to one of those projects; naming another is refused. `validOn` asks for the rules in force on that day, `validFrom` inclusive and `validTo` exclusive. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of rules.", RulePage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `validOn` is not a calendar day, or `projectId` is not a project this account works in."),
          ...commonProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", PickupExceptionRuleListQuery),
      async (c) => {
        const { limit, cursor, projectId, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(columns)
          .from(pickupExceptionRule)
          .where(
            and(
              ruleScope(principal),
              projectId === undefined ? undefined : eq(pickupExceptionRule.projectId, projectId),
              day === undefined ? undefined : validOn(pickupExceptionRule, day),
              after === undefined ? undefined : gt(pickupExceptionRule.id, after),
            ),
          )
          .orderBy(asc(pickupExceptionRule.id))
          .limit(fetchLimit(limit))
        const page = pageOf(rows, limit)
        const ladders = await laddersOf(
          tx,
          principal.companyId,
          page.items.map((row) => row.id),
        )
        return c.json({ ...page, items: page.items.map((row) => ruleOf(row, ladders.get(row.id) ?? [])) })
      },
    )
    .post(
      "/pickup-exception-rules",
      describeRoute({
        operationId: "createPickupExceptionRule",
        summary: "Add a pickup exception rule",
        description:
          "Adds a rule to a project the caller works in (400 at `projectId` otherwise): the outcome it governs — `failed`, `skipped`, or `completed` for a collection tagged with a contaminant code — the reason it narrows to among the customer's (null for any; none on a tagged collection's rule), the code it narrows to (null for any; with contamination or any reason), how many matching exceptions in the window cost nothing, the window in days, and the ladder: the products charged by occurrence once the free count is spent, the last repeating. A code is one of the company's (400) and active (409, `The contaminant code … is retired; a rule names an active one`); a step is a product of the project that is an additional service sold per job (400 at `ladder.N`) and active (409). Two rules for the same outcome, reason and code are never in force at once (409). Nothing is charged by a rule until M5b's consumer reads it.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The rule as it was written.", PickupExceptionRule),
          400: describeProblem("The body is missing a field, names a member the server owns, a reason the customer does not cause, a reason with a tagged collection, a code with another reason, a period ending on or before it starts, a project this account does not work in, a code that is not the company's, or a step that is not an additional service of the project sold per job."),
          ...commonProblems("create"),
          409: describeProblem("The code is retired, a step's product is not active, or a rule for this outcome, reason and code is in force over part of the period."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", PickupExceptionRuleCreate),
      async (c) => {
        const { ladder, ...values } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        await requireLadder(tx, principal.companyId, values.projectId, ladder)
        await requireRuleCode(tx, principal.companyId, values.contaminantCodeId)
        const id = newId()
        const [row] = await refuseOverlap({ [RULE_RUNNING]: RULE_RUNNING_SENTENCE }, () =>
          tx
            .insert(pickupExceptionRule)
            .values({
              ...values,
              reason: values.reason ?? null,
              contaminantCodeId: values.contaminantCodeId ?? null,
              validTo: values.validTo ?? null,
              id,
              companyId: principal.companyId,
            })
            .returning(columns),
        )
        await writeLadder(tx, { companyId: principal.companyId, projectId: row.projectId, id: row.id }, ladder)
        return created(c, "/pickup-exception-rules", ruleOf(row, ladder))
      },
    )
    .get(
      "/pickup-exception-rules/:id",
      describeRoute({
        operationId: "getPickupExceptionRule",
        summary: "One pickup exception rule",
        description: "One rule of a project the caller works in, with its ladder by position. A rule of another company, or of a project this account does not work in, is a rule that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The rule.", PickupExceptionRule),
          400: describeProblem("The path does not hold an id."),
          ...commonProblems("view"),
          404: describeProblem("No rule with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const row = await findRule(tx, principal, id)
        if (row === undefined) throw noSuchRule(id)
        return c.json(ruleOf(row, (await laddersOf(tx, principal.companyId, [row.id])).get(row.id) ?? []))
      },
    )
    .patch(
      "/pickup-exception-rules/:id",
      describeRoute({
        operationId: "patchPickupExceptionRule",
        summary: "Amend a pickup exception rule",
        description:
          "Changes the free count, the window, the ladder — replaced whole, by position — or the end of one rule of a project the caller works in; every field is optional and at least one must be given. The outcome, the reason, the code and the start do not change: they are the rule's key and its period, so a rule for another case or from another day is another rule, and this one is ended on the day the other starts. Under the rule's row lock: the end still comes after the start (400 on `validTo`), a step is held as on the create — a step the rule already charged keeps its product whatever its status now (a status gates a new reference) — and the rule still overlaps no other alike (409). A judgement already made is not moved by an amended rule: M5b judges each exception once, at its event.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The rule as it now stands.", PickupExceptionRule),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own (the key and the start included), ends on or before the day the rule starts, or names a step that is not an additional service of the project sold per job."),
          ...commonProblems("edit"),
          404: describeProblem("No rule with that id in the projects this account works in."),
          409: describeProblem("A new step's product is not active, or a rule for this outcome, reason and code is in force over part of the new period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", PickupExceptionRulePatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const { ladder, ...fields } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockRow(tx, pickupExceptionRule, { companyId: principal.companyId, id })
        const current = await findRule(tx, principal, id)
        if (current === undefined) throw noSuchRule(id)
        requireOrdered(periodAfter(current, fields))
        const stored = (await laddersOf(tx, principal.companyId, [id])).get(id) ?? []
        if (ladder !== undefined) await requireLadder(tx, principal.companyId, current.projectId, ladder, stored)
        // The ladder alone still moves the rule: it is part of the rule on the wire.
        const set = Object.keys(fields).length === 0 ? stamp() : fields
        const [row] = await refuseOverlap({ [RULE_RUNNING]: RULE_RUNNING_SENTENCE }, () =>
          tx
            .update(pickupExceptionRule)
            .set(set)
            .where(and(ruleScope(principal), eq(pickupExceptionRule.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchRule(id)
        if (ladder !== undefined) {
          await tx.delete(pickupExceptionRuleStep).where(and(eq(pickupExceptionRuleStep.companyId, principal.companyId), eq(pickupExceptionRuleStep.ruleId, id)))
          await writeLadder(tx, { companyId: principal.companyId, projectId: row.projectId, id }, ladder)
        }
        return c.json(ruleOf(row, ladder ?? stored))
      },
    )
    .get(
      "/properties/:id/pickup-exceptions",
      describeRoute({
        operationId: "listPropertyPickupExceptions",
        summary: "A property's Pickup Exceptions",
        description: historyDescription("property"),
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The property's exception history.", PickupExceptionHistory),
          400: describeProblem("The path does not hold an id, or `from` is not a calendar day."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`customers.properties\` and on \`${STOPS}\`.`),
          404: describeProblem("No property with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant("customers.properties", "view"),
      requireGrant(STOPS, "view"),
      validate("param", IdParam),
      validate("query", PickupExceptionHistoryQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const { from } = c.req.valid("query")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const [found] = await tx
          .select({ projectId: property.projectId })
          .from(property)
          .where(and(eq(property.companyId, principal.companyId), inProjects(property.projectId, principal), eq(property.id, id)))
          .limit(1)
        if (found === undefined) throw problem(404, { detail: `No property ${id} in the projects this account works in` })
        const day = from ?? (await defaultFrom(tx, principal.companyId, found.projectId, now()))
        return c.json(await historyAt(tx, principal.companyId, found.projectId, { kind: "property", id }, day))
      },
    )
    .get(
      "/shared-collection-points/:id/pickup-exceptions",
      describeRoute({
        operationId: "listSharedCollectionPointPickupExceptions",
        summary: "A shared collection point's Pickup Exceptions",
        description: historyDescription("shared collection point"),
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The shared collection point's exception history.", PickupExceptionHistory),
          400: describeProblem("The path does not hold an id, or `from` is not a calendar day."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem(`No active account here, or the caller's role does not allow \`view\` on \`customers.shared\` and on \`${STOPS}\`.`),
          404: describeProblem("No shared collection point with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant("customers.shared", "view"),
      requireGrant(STOPS, "view"),
      validate("param", IdParam),
      validate("query", PickupExceptionHistoryQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const { from } = c.req.valid("query")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const [found] = await tx
          .select({ projectId: sharedCollectionPoint.projectId })
          .from(sharedCollectionPoint)
          .where(and(eq(sharedCollectionPoint.companyId, principal.companyId), inProjects(sharedCollectionPoint.projectId, principal), eq(sharedCollectionPoint.id, id)))
          .limit(1)
        if (found === undefined) throw problem(404, { detail: `No shared collection point ${id} in the projects this account works in` })
        const day = from ?? (await defaultFrom(tx, principal.companyId, found.projectId, now()))
        return c.json(await historyAt(tx, principal.companyId, found.projectId, { kind: "point", id }, day))
      },
    )
}

/** What a tag naming a code that does not apply to the stop's fraction is told. */
export const CODE_NOT_FOR_FRACTION = "The contaminant code does not apply to this stop's waste fraction"

/**
 * Holds the code a correction tags a stop with (M5a): one of the company's
 * (400) and, where it is new to the stop, applying to the stop's fraction
 * where the code names fractions (400) and active (409). A stop keeps the
 * code it was tagged with, retired or narrowed since or not.
 */
export async function requireTag(tx: Tx, companyId: string, stop: { contaminantCodeId: string | null; wasteFractionId: string }, id: string | null | undefined): Promise<void> {
  if (id == null) return
  const found = await codeNamed(tx, companyId, id)
  if (stop.contaminantCodeId === id) return
  const fractions = await tx
    .select({ wasteFractionId: contaminantCodeFraction.wasteFractionId })
    .from(contaminantCodeFraction)
    .where(and(eq(contaminantCodeFraction.companyId, companyId), eq(contaminantCodeFraction.contaminantCodeId, id)))
  if (fractions.length > 0 && !fractions.some((row) => row.wasteFractionId === stop.wasteFractionId)) {
    throw invalidRequest("body", [{ path: "contaminantCodeId", message: CODE_NOT_FOR_FRACTION }])
  }
  refuseRetiredCode(found.status, found.code, "a tag")
}
