// A project's Visit Rules (Issue #393, M4 of #293), under
// `commercial.products` as its ticket and work order charges are: how its
// recycling centres' visits are charged (@waste/domain/visits/charges).
//
// A rule is effective-dated (ADR-0005), one in force per project at a time
// (`visit_rule_no_overlap`, a 409). A patch moves everything but the project
// and the start, the ladder and the free fractions replaced whole, under the
// project's row lock and then the rule's, the order a product's patch takes
// them in. A step and the business per-visit product are products of the
// project sold per visit, and the annual-access product one sold by the month
// (400 at the field); each is active where the reference is new (409, the
// status gate of routes/statuses.ts). A free fraction is the company's (400).
// An amended rule never moves a charge already made: each visit is judged
// once, at its event.
import { Page } from "@waste/contracts/pagination"
import { TRADE_TOGETHER, VisitRule, VisitRuleCreate, VisitRuleListQuery, VisitRulePatch } from "@waste/contracts/visit-rules"
import type { Tx } from "@waste/db/client"
import { ruleSetsOf } from "@waste/db/commands/site-visits"
import { validOn } from "@waste/db/query/valid-on"
import { product, wasteFraction } from "@waste/db/schema/catalogue"
import { project } from "@waste/db/schema/organisation"
import { visitRule, visitRuleFreeFraction, visitRuleStep } from "@waste/db/schema/site-visits"
import type { ProductStatus, ProductUnit } from "@waste/domain/registry/vocabulary"
import { and, asc, eq, gt, inArray } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { periodAfter, requireOrdered } from "./periods"
import { NOT_A_PRODUCT, type Scope } from "./references"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseOverlap, stamp, stampsOf } from "./shared"
import { unofferedProduct } from "./statuses"

const MODULE = "commercial.products"

const RulePage = Page(VisitRule)

/** What a step or a business's per-visit product not sold per visit is told. */
export const SOLD_PER_VISIT = "A visit is charged at a product sold per visit"
/** What an annual-access product not sold by the month is told. */
export const ACCESS_SOLD_BY_THE_MONTH = "Annual access is a product sold by the month, subscribed under the business's agreement"
/** What a free fraction that is not the company's is told. */
export const NOT_A_FRACTION = "Not a waste fraction of this company"

const RUNNING = "visit_rule_no_overlap"
const RUNNING_SENTENCE = "A visit rule is already in force over part of that period; end it first or schedule this one after it"

const columns = {
  id: visitRule.id,
  projectId: visitRule.projectId,
  validFrom: visitRule.validFrom,
  validTo: visitRule.validTo,
  freeVisits: visitRule.freeVisits,
  businessVisitProductId: visitRule.businessVisitProductId,
  annualAccessProductId: visitRule.annualAccessProductId,
  tradeThreshold: visitRule.tradeThreshold,
  tradeWindowDays: visitRule.tradeWindowDays,
  createdAt: visitRule.createdAt,
  updatedAt: visitRule.updatedAt,
}

type Row = Pick<typeof visitRule.$inferSelect, keyof typeof columns>

/** The products and fractions a rule names beside its row. */
type Sets = { ladder: readonly string[]; freeFractionIds: readonly string[] }

function ruleOf(row: Row, sets: Sets): VisitRule {
  return {
    id: row.id,
    projectId: row.projectId,
    freeVisits: row.freeVisits,
    ladder: [...sets.ladder],
    freeFractionIds: [...sets.freeFractionIds],
    businessVisitProductId: row.businessVisitProductId,
    annualAccessProductId: row.annualAccessProductId,
    tradeThreshold: row.tradeThreshold,
    tradeWindowDays: row.tradeWindowDays,
    validFrom: row.validFrom,
    validTo: row.validTo,
    ...stampsOf(row),
  }
}

const noSuchRule = (id: string) => problem(404, { detail: `No visit rule ${id} in the projects this account works in` })

const ruleScope = (principal: Principal) => and(eq(visitRule.companyId, principal.companyId), inProjects(visitRule.projectId, principal))

async function findRule(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(visitRule)
    .where(and(ruleScope(principal), eq(visitRule.id, id)))
    .limit(1)
  return row
}

async function setsOf(tx: Tx, companyId: string, ids: readonly string[]): Promise<(id: string) => Sets> {
  const { ladders, freeFractions } = await ruleSetsOf(tx, companyId, ids)
  return (id) => ({ ladder: ladders.get(id) ?? [], freeFractionIds: freeFractions.get(id) ?? [] })
}

/** A product reference as the rule's body names it: the field, the product, and the product the rule named there before, if any. */
type Named = { path: string; id: string; unit: ProductUnit; message: string; kept: string | null }

/**
 * Holds every product a rule names to its project's, at the unit its place
 * asks — a step and the business's per-visit product sold per visit, the
 * annual access by the month (400 at the field) — and then each one new to
 * its place to an active product (409): a status gates a new reference,
 * never an existing one.
 */
async function requireProducts(tx: Tx, scope: Scope, named: readonly Named[]): Promise<void> {
  if (named.length === 0) return
  const found = await tx
    .select({ id: product.id, unit: product.unit, status: product.status })
    .from(product)
    .where(and(eq(product.companyId, scope.companyId), eq(product.projectId, scope.projectId), inArray(product.id, [...new Set(named.map((entry) => entry.id))])))
  const byId = new Map(found.map((row) => [row.id, row]))
  const wrong = named.flatMap((entry) => {
    const row = byId.get(entry.id)
    if (row === undefined) return [{ path: entry.path, message: NOT_A_PRODUCT }]
    return row.unit === entry.unit ? [] : [{ path: entry.path, message: entry.message }]
  })
  if (wrong.length > 0) throw invalidRequest("body", wrong)
  for (const entry of named) {
    const status = byId.get(entry.id)?.status as ProductStatus | undefined
    if (status !== undefined && status !== "active" && entry.kept !== entry.id) throw problem(409, { detail: unofferedProduct(status) })
  }
}

/** The products a body names, each at its place, beside what the rule named there. */
function productsNamed(body: { ladder?: readonly string[]; businessVisitProductId?: string | null; annualAccessProductId?: string | null }, before: { ladder: readonly string[]; businessVisitProductId: string | null; annualAccessProductId: string | null } | null): Named[] {
  return [
    ...(body.ladder ?? []).map((id, index): Named => ({ path: `ladder.${index}`, id, unit: "visit", message: SOLD_PER_VISIT, kept: before?.ladder[index] ?? null })),
    ...(body.businessVisitProductId == null ? [] : [{ path: "businessVisitProductId", id: body.businessVisitProductId, unit: "visit" as const, message: SOLD_PER_VISIT, kept: before?.businessVisitProductId ?? null }]),
    ...(body.annualAccessProductId == null ? [] : [{ path: "annualAccessProductId", id: body.annualAccessProductId, unit: "month" as const, message: ACCESS_SOLD_BY_THE_MONTH, kept: before?.annualAccessProductId ?? null }]),
  ]
}

/** Holds each free fraction to the company's (400 at `freeFractionIds.N`). */
async function requireFractions(tx: Tx, companyId: string, ids: readonly string[] | undefined): Promise<void> {
  if (ids === undefined || ids.length === 0) return
  const found = await tx
    .select({ id: wasteFraction.id })
    .from(wasteFraction)
    .where(and(eq(wasteFraction.companyId, companyId), inArray(wasteFraction.id, [...ids])))
  const known = new Set(found.map((row) => row.id))
  const wrong = ids.flatMap((id, index) => (known.has(id) ? [] : [{ path: `freeFractionIds.${index}`, message: NOT_A_FRACTION }]))
  if (wrong.length > 0) throw invalidRequest("body", wrong)
}

/** Writes a rule's ladder, position 1 first, and its free fractions, each replacing what the rule held where given. */
async function writeSets(tx: Tx, rule: { companyId: string; projectId: string; id: string }, sets: Partial<Sets>, replace: boolean): Promise<void> {
  if (sets.ladder !== undefined) {
    if (replace) await tx.delete(visitRuleStep).where(and(eq(visitRuleStep.companyId, rule.companyId), eq(visitRuleStep.ruleId, rule.id)))
    if (sets.ladder.length > 0) await tx.insert(visitRuleStep).values(sets.ladder.map((productId, index) => ({ id: newId(), companyId: rule.companyId, projectId: rule.projectId, ruleId: rule.id, position: index + 1, productId })))
  }
  if (sets.freeFractionIds !== undefined) {
    if (replace) await tx.delete(visitRuleFreeFraction).where(and(eq(visitRuleFreeFraction.companyId, rule.companyId), eq(visitRuleFreeFraction.ruleId, rule.id)))
    if (sets.freeFractionIds.length > 0) await tx.insert(visitRuleFreeFraction).values(sets.freeFractionIds.map((wasteFractionId) => ({ id: newId(), companyId: rule.companyId, projectId: rule.projectId, ruleId: rule.id, wasteFractionId })))
  }
}

const problems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

export function visitRuleRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/visit-rules",
      describeRoute({
        operationId: "listVisitRules",
        summary: "The projects' Visit Rules",
        description:
          "One page of the rules that charge a project's recycling-centre visits, oldest first, from the projects the caller works in, each with its ladder by position and its free fractions. `projectId` narrows it to one of those projects; `validOn` asks for the rule in force on that day. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of rules.", RulePage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `validOn` is not a calendar day, or `projectId` is not a project this account works in."),
          ...problems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", VisitRuleListQuery),
      async (c) => {
        const { limit, cursor, projectId, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(columns)
          .from(visitRule)
          .where(
            and(
              ruleScope(principal),
              projectId === undefined ? undefined : eq(visitRule.projectId, projectId),
              day === undefined ? undefined : validOn(visitRule, day),
              after === undefined ? undefined : gt(visitRule.id, after),
            ),
          )
          .orderBy(asc(visitRule.id))
          .limit(fetchLimit(limit))
        const page = pageOf(rows, limit)
        const sets = await setsOf(
          tx,
          principal.companyId,
          page.items.map((row) => row.id),
        )
        return c.json({ ...page, items: page.items.map((row) => ruleOf(row, sets(row.id))) })
      },
    )
    .post(
      "/visit-rules",
      describeRoute({
        operationId: "createVisitRule",
        summary: "Add a Visit Rule",
        description:
          "Adds a rule to a project the caller works in (400 at `projectId` otherwise): a household's free visits per calendar year and the ladder of per-visit products after them, the last step repeating (empty includes every visit); the free fractions, whose visits are neither counted nor charged (each the company's, 400); a business's per-visit product and its annual-access product (none charges nothing, and none gives no annual access); and the likely-trade threshold with its window, both or neither. A step and the per-visit product are products of the project sold per visit, the annual access one sold by the month (400 at the field), each active (409). One rule per project is in force at a time (409).",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The rule as it was written.", VisitRule),
          400: describeProblem("The body is missing a field, names a member the server owns, a fraction twice or one that is not the company's, a threshold without its window, a period ending on or before it starts, a project this account does not work in, or a product that is not the project's or not sold as its place asks."),
          ...problems("create"),
          409: describeProblem("A product is not active, or a rule of the project is in force over part of the period."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", VisitRuleCreate),
      async (c) => {
        const { ladder, freeFractionIds, ...values } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        const scope = { companyId: principal.companyId, projectId: values.projectId }
        await lockRow(tx, project, { companyId: scope.companyId, id: scope.projectId })
        await requireFractions(tx, principal.companyId, freeFractionIds)
        await requireProducts(tx, scope, productsNamed({ ladder, ...values }, null))
        const [row] = await refuseOverlap({ [RUNNING]: RUNNING_SENTENCE }, () =>
          tx
            .insert(visitRule)
            .values({
              id: newId(),
              companyId: principal.companyId,
              projectId: values.projectId,
              freeVisits: values.freeVisits,
              businessVisitProductId: values.businessVisitProductId ?? null,
              annualAccessProductId: values.annualAccessProductId ?? null,
              tradeThreshold: values.tradeThreshold ?? null,
              tradeWindowDays: values.tradeWindowDays ?? null,
              validFrom: values.validFrom,
              validTo: values.validTo ?? null,
            })
            .returning(columns),
        )
        await writeSets(tx, { ...scope, id: row.id }, { ladder, freeFractionIds }, false)
        return created(c, "/visit-rules", ruleOf(row, { ladder, freeFractionIds }))
      },
    )
    .get(
      "/visit-rules/:id",
      describeRoute({
        operationId: "getVisitRule",
        summary: "One Visit Rule",
        description: "One rule of a project the caller works in, with its ladder by position and its free fractions. A rule of another company, or of a project this account does not work in, is one that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The rule.", VisitRule),
          400: describeProblem("The path does not hold an id."),
          ...problems("view"),
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
        return c.json(ruleOf(row, (await setsOf(tx, principal.companyId, [row.id]))(row.id)))
      },
    )
    .patch(
      "/visit-rules/:id",
      describeRoute({
        operationId: "patchVisitRule",
        summary: "Amend a Visit Rule",
        description:
          "Changes anything but the project and the start of one rule of a project the caller works in — the ladder and the free fractions replaced whole — or ends it; every field is optional and at least one must be given. Under the project's row lock and then the rule's: the end still comes after the start (400 on `validTo`), a product is held as on the create — one the rule already names at the same place keeps it whatever its status now — and the rule still overlaps no other of its project (409). A charge already made keeps its product: each visit is judged once, at its event.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The rule as it now stands.", VisitRule),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own (the project and the start included), ends on or before the day the rule starts, names a fraction that is not the company's, or a product that is not the project's or not sold as its place asks."),
          ...problems("edit"),
          404: describeProblem("No rule with that id in the projects this account works in."),
          409: describeProblem("A new product is not active, or a rule of the project is in force over part of the new period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", VisitRulePatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const { ladder, freeFractionIds, ...fields } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const found = await findRule(tx, principal, id)
        if (found === undefined) throw noSuchRule(id)
        await lockRow(tx, project, { companyId: principal.companyId, id: found.projectId })
        await lockRow(tx, visitRule, { companyId: principal.companyId, id })
        const current = (await findRule(tx, principal, id)) ?? found
        const scope = { companyId: principal.companyId, projectId: current.projectId }
        requireOrdered(periodAfter(current, fields))
        const stored = (await setsOf(tx, principal.companyId, [id]))(id)
        const threshold = fields.tradeThreshold === undefined ? current.tradeThreshold : fields.tradeThreshold
        const window = fields.tradeWindowDays === undefined ? current.tradeWindowDays : fields.tradeWindowDays
        if ((threshold === null) !== (window === null)) throw invalidRequest("body", [{ path: "tradeWindowDays", message: TRADE_TOGETHER }])
        await requireFractions(tx, principal.companyId, freeFractionIds)
        await requireProducts(tx, scope, productsNamed({ ladder, ...fields }, { ladder: stored.ladder, businessVisitProductId: current.businessVisitProductId, annualAccessProductId: current.annualAccessProductId }))
        // The sets alone still move the rule: they are part of it on the wire.
        const set = Object.keys(fields).length === 0 ? stamp() : fields
        const [row] = await refuseOverlap({ [RUNNING]: RUNNING_SENTENCE }, () =>
          tx
            .update(visitRule)
            .set(set)
            .where(and(ruleScope(principal), eq(visitRule.id, id)))
            .returning(columns),
        )
        await writeSets(tx, { ...scope, id }, { ladder, freeFractionIds }, true)
        return c.json(ruleOf(row, { ladder: ladder ?? stored.ladder, freeFractionIds: freeFractionIds ?? stored.freeFractionIds }))
      },
    )
}
