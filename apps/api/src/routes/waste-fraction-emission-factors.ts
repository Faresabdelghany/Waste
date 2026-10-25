// A waste fraction's emission factor (M13 of #293): kilograms CO₂e a tonne
// of the fraction emits once treated, and avoids where its treatment
// displaces anything, over a half-open period (ADR-0005) — the company's
// configuration under `configure.master` beside the fractions it prices in
// CO₂e. `GET /waste-fraction-emission-factors` lists them — one fraction's,
// in force on a day where asked — `POST` adds one, and `GET`/`PATCH
// /waste-fraction-emission-factors/:id` read and amend one. No delete: a
// factor is ended on its last day in force and the next one added, and a
// report read under it was read by it.
//
// The fraction, the figures and the start are the period's own, so a patch
// moves the end and the source alone; two periods of one fraction never hold
// a day together (the database's exclusion, a 409 in its sentence).
import { Page } from "@waste/contracts/pagination"
import { WasteFractionEmissionFactor, WasteFractionEmissionFactorCreate, WasteFractionEmissionFactorListQuery, WasteFractionEmissionFactorPatch } from "@waste/contracts/sustainability"
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { wasteFractionEmissionFactor } from "@waste/db/schema/sustainability"
import { KG_PER_TONNE_MAX } from "@waste/domain/insight/sustainability"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { periodAfter, requireOrdered } from "./periods"
import { requireWasteFraction } from "./references"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseOverlap, stampsOf } from "./shared"

const MODULE = "configure.master"
const FactorPage = Page(WasteFractionEmissionFactor)
const BOUND = KG_PER_TONNE_MAX.toLocaleString("en").replace(",", " ")

const columns = {
  id: wasteFractionEmissionFactor.id,
  wasteFractionId: wasteFractionEmissionFactor.wasteFractionId,
  footprintKgPerTonne: wasteFractionEmissionFactor.footprintKgPerTonne,
  avoidedKgPerTonne: wasteFractionEmissionFactor.avoidedKgPerTonne,
  source: wasteFractionEmissionFactor.source,
  validFrom: wasteFractionEmissionFactor.validFrom,
  validTo: wasteFractionEmissionFactor.validTo,
  createdAt: wasteFractionEmissionFactor.createdAt,
  updatedAt: wasteFractionEmissionFactor.updatedAt,
}

type Row = Pick<typeof wasteFractionEmissionFactor.$inferSelect, keyof typeof columns>

const factorOf = (row: Row): WasteFractionEmissionFactor => ({
  id: row.id,
  wasteFractionId: row.wasteFractionId,
  footprintKgPerTonne: row.footprintKgPerTonne,
  avoidedKgPerTonne: row.avoidedKgPerTonne,
  source: row.source,
  validFrom: row.validFrom,
  validTo: row.validTo,
  ...stampsOf(row),
})

/** The exclusion over a fraction's periods, and what its 409 says. */
const RUNNING = "waste_fraction_emission_factor_no_overlap"
const RUNNING_SENTENCE = "Another factor for this waste fraction is in force over part of that period: end it on the day before this one starts"

const noSuchFactor = (id: string) => problem(404, { detail: `No waste fraction emission factor ${id} in this company` })

const scope = (principal: Principal) => eq(wasteFractionEmissionFactor.companyId, principal.companyId)

async function findFactor(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(wasteFractionEmissionFactor)
    .where(and(scope(principal), eq(wasteFractionEmissionFactor.id, id)))
    .limit(1)
  return row
}

const commonProblems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

export function wasteFractionEmissionFactorRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/waste-fraction-emission-factors",
      describeRoute({
        operationId: "listWasteFractionEmissionFactors",
        summary: "The company's waste fraction emission factors",
        description:
          "One page of the emission factors the sustainability report reads a Customer's waste by, oldest first (ids are time-ordered): for each waste fraction, kilograms CO₂e per tonne its treatment emits and, where it displaces anything, avoids, over a period, with the source the figures are quoted from. `wasteFractionId` narrows the page to one fraction's; `validOn` to the factors in force on that day, `validFrom` inclusive and `validTo` exclusive. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of factors.", FactorPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `wasteFractionId` is not an id, or `validOn` is not a calendar day."),
          ...commonProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", WasteFractionEmissionFactorListQuery),
      async (c) => {
        const { limit, cursor, wasteFractionId, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const rows = await c
          .get("tx")
          .select(columns)
          .from(wasteFractionEmissionFactor)
          .where(
            and(
              scope(c.get("principal")),
              wasteFractionId === undefined ? undefined : eq(wasteFractionEmissionFactor.wasteFractionId, wasteFractionId),
              day === undefined ? undefined : validOn(wasteFractionEmissionFactor, day),
              after === undefined ? undefined : gt(wasteFractionEmissionFactor.id, after),
            ),
          )
          .orderBy(asc(wasteFractionEmissionFactor.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(factorOf), nextCursor })
      },
    )
    .post(
      "/waste-fraction-emission-factors",
      describeRoute({
        operationId: "createWasteFractionEmissionFactor",
        summary: "Add a waste fraction emission factor",
        description: `Adds a factor for one of the company's waste fractions from \`validFrom\`, open-ended unless \`validTo\` (the first day out of force) is given: kilograms CO₂e a tonne of the fraction emits once treated, a whole number from 0 to ${BOUND}, and, where its treatment displaces anything, the kilograms per tonne it avoids, likewise; and the source the figures are quoted from, the publication and its year. Two factors of one fraction are never in force on the same day (409). The server mints the id.`,
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The factor as it was written.", WasteFractionEmissionFactor),
          400: describeProblem(`The body is missing a field, names a member the server owns, names a waste fraction that is not the company's, gives figures that are not whole numbers from 0 to ${BOUND}, gives an empty source, or ends on or before it starts.`),
          ...commonProblems("create"),
          409: describeProblem("Another factor for this waste fraction is in force over part of the period."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", WasteFractionEmissionFactorCreate),
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await requireWasteFraction(tx, principal.companyId, values.wasteFractionId)
        const [row] = await refuseOverlap({ [RUNNING]: RUNNING_SENTENCE }, () =>
          tx
            .insert(wasteFractionEmissionFactor)
            .values({ ...values, avoidedKgPerTonne: values.avoidedKgPerTonne ?? null, validTo: values.validTo ?? null, id: newId(), companyId: principal.companyId })
            .returning(columns),
        )
        return created(c, "/waste-fraction-emission-factors", factorOf(row))
      },
    )
    .get(
      "/waste-fraction-emission-factors/:id",
      describeRoute({
        operationId: "getWasteFractionEmissionFactor",
        summary: "One waste fraction emission factor",
        description: "One emission factor of the caller's company. Another company's factor is one that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The factor.", WasteFractionEmissionFactor),
          400: describeProblem("The path does not hold an id."),
          ...commonProblems("view"),
          404: describeProblem("No waste fraction emission factor with that id in this company."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findFactor(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchFactor(id)
        return c.json(factorOf(row))
      },
    )
    .patch(
      "/waste-fraction-emission-factors/:id",
      describeRoute({
        operationId: "patchWasteFractionEmissionFactor",
        summary: "End or re-source a waste fraction emission factor",
        description:
          "Changes the end or the source of one factor; at least one must be given. A day ends the factor, the first day out of force, and null reopens it. The fraction, the figures and the start do not change: they are the period's own, so a revised figure is the next period's factor, added from the day this one ends. Under the factor's row lock: the end still comes after the start (400 on `validTo`), and the factor still overlaps no other of its fraction (409).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The factor as it now stands.", WasteFractionEmissionFactor),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own (the fraction, the figures and the start included), gives an empty source, or ends on or before the day the factor starts."),
          ...commonProblems("edit"),
          404: describeProblem("No waste fraction emission factor with that id in this company."),
          409: describeProblem("Another factor for this waste fraction is in force over part of the new period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", WasteFractionEmissionFactorPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockRow(tx, wasteFractionEmissionFactor, { companyId: principal.companyId, id })
        const current = await findFactor(tx, principal, id)
        if (current === undefined) throw noSuchFactor(id)
        requireOrdered(periodAfter(current, patch))
        const [row] = await refuseOverlap({ [RUNNING]: RUNNING_SENTENCE }, () =>
          tx
            .update(wasteFractionEmissionFactor)
            .set(patch)
            .where(and(scope(principal), eq(wasteFractionEmissionFactor.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchFactor(id)
        return c.json(factorOf(row))
      },
    )
}
