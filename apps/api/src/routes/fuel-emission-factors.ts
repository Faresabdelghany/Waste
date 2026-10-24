// A fuel's emission factor (M10 of #293): grams of CO₂e per unit of the fuel
// over a half-open period (ADR-0005), the company's configuration under
// `configure.master` beside the vehicle types. `GET /fuel-emission-factors`
// lists them — one fuel's, in force on a day where asked — `POST` adds one,
// and `GET`/`PATCH /fuel-emission-factors/:id` read and amend one. No delete:
// a factor is ended on its last day in force and the next year's added, and
// a route measured under it was measured by it.
//
// The fuel, the number and the start are the period's own, so a patch moves
// the end and the source alone; two periods of one fuel never hold a day
// together (the database's exclusion, a 409 in its sentence). The unit is
// the fuel's (`FUEL_UNIT`) and never stored, so a factor reads with it.
import { FuelEmissionFactor, FuelEmissionFactorCreate, FuelEmissionFactorListQuery, FuelEmissionFactorPatch } from "@waste/contracts/emissions"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { fuelEmissionFactor } from "@waste/db/schema/emissions"
import { FUEL_UNIT } from "@waste/domain/resources/emissions"
import type { FuelType } from "@waste/domain/resources/vocabulary"
import { and, asc, eq, gt } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, problem, validate } from "../problem"
import { periodAfter, requireOrdered } from "./periods"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseOverlap, stampsOf } from "./shared"

const MODULE = "configure.master"
const FactorPage = Page(FuelEmissionFactor)

const columns = {
  id: fuelEmissionFactor.id,
  fuel: fuelEmissionFactor.fuel,
  gramsPerUnit: fuelEmissionFactor.gramsPerUnit,
  source: fuelEmissionFactor.source,
  validFrom: fuelEmissionFactor.validFrom,
  validTo: fuelEmissionFactor.validTo,
  createdAt: fuelEmissionFactor.createdAt,
  updatedAt: fuelEmissionFactor.updatedAt,
}

type Row = Pick<typeof fuelEmissionFactor.$inferSelect, keyof typeof columns>

/** The row on the wire, with its fuel's unit. */
function factorOf(row: Row): FuelEmissionFactor {
  const fuel = row.fuel as FuelType
  return { id: row.id, fuel, unit: FUEL_UNIT[fuel], gramsPerUnit: row.gramsPerUnit, source: row.source, validFrom: row.validFrom, validTo: row.validTo, ...stampsOf(row) }
}

/** The exclusion over a fuel's periods, and what its 409 says. */
const RUNNING = "fuel_emission_factor_no_overlap"
const RUNNING_SENTENCE = "Another factor for this fuel is in force over part of that period: end it on the day before this one starts"

const noSuchFactor = (id: string) => problem(404, { detail: `No emission factor ${id} in this company` })

const scope = (principal: Principal) => eq(fuelEmissionFactor.companyId, principal.companyId)

async function findFactor(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(fuelEmissionFactor)
    .where(and(scope(principal), eq(fuelEmissionFactor.id, id)))
    .limit(1)
  return row
}

const commonProblems = (action: "view" | "edit" | "create") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`${MODULE}\`.`),
})

export function fuelEmissionFactorRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/fuel-emission-factors",
      describeRoute({
        operationId: "listFuelEmissionFactors",
        summary: "The company's fuel emission factors",
        description:
          "One page of the emission factors the company measures its routes by, oldest first (ids are time-ordered): for each fuel, grams of CO₂e per unit of it — `unit`, a litre, a kilogram of gas or a kilowatt-hour — over a period, with the source the number is quoted from. `fuel` narrows the page to one fuel's; `validOn` to the factors in force on that day, `validFrom` inclusive and `validTo` exclusive. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of factors.", FactorPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `fuel` is not a fuel of the vocabulary, or `validOn` is not a calendar day."),
          ...commonProblems("view"),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", FuelEmissionFactorListQuery),
      async (c) => {
        const { limit, cursor, fuel, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        const rows = await tx
          .select(columns)
          .from(fuelEmissionFactor)
          .where(
            and(
              scope(principal),
              fuel === undefined ? undefined : eq(fuelEmissionFactor.fuel, fuel),
              day === undefined ? undefined : validOn(fuelEmissionFactor, day),
              after === undefined ? undefined : gt(fuelEmissionFactor.id, after),
            ),
          )
          .orderBy(asc(fuelEmissionFactor.id))
          .limit(fetchLimit(limit))
        const { items, nextCursor } = pageOf(rows, limit)
        return c.json({ items: items.map(factorOf), nextCursor })
      },
    )
    .post(
      "/fuel-emission-factors",
      describeRoute({
        operationId: "createFuelEmissionFactor",
        summary: "Add a fuel emission factor",
        description:
          "Adds a factor for one fuel from `validFrom`, open-ended unless `validTo` (the first day out of force) is given: grams of CO₂e per unit of the fuel, a whole number from 0 to 10 000 — zero for a fuel counted as nothing burnt, as the published rules count a biofuel documented as sustainable — and the source the number is quoted from, the published list and its year or a demo value. Two factors of one fuel are never in force on the same day (409). The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The factor as it was written, with its fuel's unit.", FuelEmissionFactor),
          400: describeProblem("The body is missing a field, names a member the server owns (the unit among them), names a fuel the vocabulary does not hold, gives grams that are not a whole number from 0 to 10 000, gives an empty source, or ends on or before it starts."),
          ...commonProblems("create"),
          409: describeProblem("Another factor for this fuel is in force over part of the period."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", FuelEmissionFactorCreate),
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const [row] = await refuseOverlap({ [RUNNING]: RUNNING_SENTENCE }, () =>
          tx
            .insert(fuelEmissionFactor)
            .values({ ...values, validTo: values.validTo ?? null, id: newId(), companyId: principal.companyId })
            .returning(columns),
        )
        return created(c, "/fuel-emission-factors", factorOf(row))
      },
    )
    .get(
      "/fuel-emission-factors/:id",
      describeRoute({
        operationId: "getFuelEmissionFactor",
        summary: "One fuel emission factor",
        description: "One emission factor of the caller's company, with its fuel's unit. Another company's factor is one that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The factor.", FuelEmissionFactor),
          400: describeProblem("The path does not hold an id."),
          ...commonProblems("view"),
          404: describeProblem("No emission factor with that id in this company."),
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
      "/fuel-emission-factors/:id",
      describeRoute({
        operationId: "patchFuelEmissionFactor",
        summary: "End or re-source a fuel emission factor",
        description:
          "Changes the end or the source of one factor; at least one must be given. A day ends the factor, the first day out of force, and null reopens it. The fuel, the number and the start do not change: they are the period's own, so a revised number is the next period's factor, added from the day this one ends. Under the factor's row lock: the end still comes after the start (400 on `validTo`), and the factor still overlaps no other of its fuel (409).",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The factor as it now stands.", FuelEmissionFactor),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own (the fuel, the grams and the start included), gives an empty source, or ends on or before the day the factor starts."),
          ...commonProblems("edit"),
          404: describeProblem("No emission factor with that id in this company."),
          409: describeProblem("Another factor for this fuel is in force over part of the new period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", FuelEmissionFactorPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        await lockRow(tx, fuelEmissionFactor, { companyId: principal.companyId, id })
        const current = await findFactor(tx, principal, id)
        if (current === undefined) throw noSuchFactor(id)
        requireOrdered(periodAfter(current, patch))
        const [row] = await refuseOverlap({ [RUNNING]: RUNNING_SENTENCE }, () =>
          tx
            .update(fuelEmissionFactor)
            .set(patch)
            .where(and(scope(principal), eq(fuelEmissionFactor.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchFactor(id)
        return c.json(factorOf(row))
      },
    )
}
