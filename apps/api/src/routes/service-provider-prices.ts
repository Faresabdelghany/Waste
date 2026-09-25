// What the company pays a provider (Issue #112, ADR-0005): the Service
// Provider Price under an assignment. `GET /service-provider-prices` lists
// them, `POST /service-provider-prices` writes the first row of a chain,
// `GET`/`PATCH /service-provider-prices/:id` read and amend one, and `POST
// /service-provider-prices/:id/index` indexes it. No delete: a price ends by
// `validTo`, and a settlement line quotes the price it was calculated at.
//
// A price is "the contractually locked bid and the indexed current fee",
// per product, under one assignment — provider and area at once — in the
// project's currency, which the create does not take. It is effective-dated,
// one price of an assignment and a product in force at a time
// (`service_provider_price_no_overlap`), and its period lies inside its
// assignment's — routes/periods.ts's two rules under the assignment's row
// lock: a price put outside is a 400 naming the bound, an assignment
// shortened under its prices a 409 counting them (routes/service-areas.ts).
// A price is a new reference to its product, so the product is `active`
// (routes/statuses.ts, #79), as a price row's is.
//
// Indexation is a new row and never an update (§7.18): the fee on a day is
// a `validOn` read, so a settlement recalculated for March after a June
// indexation reads March's fee, and the prototype's indexation history is
// the chain of rows through `indexedFromId`. `index` ends this row on
// `appliedFrom` and writes the next from it — the same assignment, product,
// bid and currency, the fee `round(base × (1 + basisPoints / 10 000))` half
// away from zero over the bid or the fee it replaces (@waste/domain/finance/
// money, `indexedFee`), the label, the basis points and what was multiplied,
// and the old row's end as its own — under the row's lock, so two
// indexations of one row take turns and the chain never forks. The bid is
// set on the first row and copied onto every indexed one; the patch never
// takes it, and the fee moves through `index` alone. A day at or before the
// row's start is a 400 on `appliedFrom`, since the index applies inside the
// price's period; a day at or after an end the row already has is a 409,
// since that row is over and the one in force is the one to index.
//
// Two scopes, as routes/service-areas.ts has them (auth/provider.ts, §7.22):
// the office reads and writes the prices of its projects; a Service
// Provider's manager reads the prices under its own assignments and no
// other, and writes nothing here, since the company sets what it pays. The
// grant is `commercial.service-provider-prices` throughout.
import type { IndexBase } from "@waste/contracts/finance"
import { Page } from "@waste/contracts/pagination"
import {
  ServiceProviderPrice,
  ServiceProviderPriceCreate,
  ServiceProviderPriceIndex,
  ServiceProviderPriceListQuery,
  ServiceProviderPricePatch,
} from "@waste/contracts/service-provider-prices"
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { serviceAreaAssignment, serviceProviderPrice } from "@waste/db/schema/finance"
import { indexedFee } from "@waste/domain/finance/money"
import { and, asc, eq, exists, gt, sql, type SQL } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, projectIdsOf, requireProject } from "../auth/projects"
import { providerIdOf, reachesAssignments } from "../auth/provider"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { projectCurrency } from "./fleet-lookups"
import { periodAfter, periodOf, requireWithin, type Period } from "./periods"
import { requireProduct, requireServiceAreaAssignment } from "./references"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseOverlap, stampsOf } from "./shared"
import { refuseUnofferedProduct } from "./statuses"

const MODULE = "commercial.service-provider-prices"
const PricePage = Page(ServiceProviderPrice)

const columns = {
  id: serviceProviderPrice.id,
  projectId: serviceProviderPrice.projectId,
  serviceAreaAssignmentId: serviceProviderPrice.serviceAreaAssignmentId,
  productId: serviceProviderPrice.productId,
  bidMinor: serviceProviderPrice.bidMinor,
  unitPriceMinor: serviceProviderPrice.unitPriceMinor,
  currency: serviceProviderPrice.currency,
  indexedFromId: serviceProviderPrice.indexedFromId,
  indexLabel: serviceProviderPrice.indexLabel,
  indexBasisPoints: serviceProviderPrice.indexBasisPoints,
  indexBase: serviceProviderPrice.indexBase,
  notes: serviceProviderPrice.notes,
  validFrom: serviceProviderPrice.validFrom,
  validTo: serviceProviderPrice.validTo,
  createdAt: serviceProviderPrice.createdAt,
  updatedAt: serviceProviderPrice.updatedAt,
}

type Row = Pick<typeof serviceProviderPrice.$inferSelect, keyof typeof columns>

/** The price on the wire. `indexBase` is text with a CHECK in the database and an enum here, both off the one vocabulary tuple. */
function priceOf(row: Row): ServiceProviderPrice {
  return {
    id: row.id,
    projectId: row.projectId,
    serviceAreaAssignmentId: row.serviceAreaAssignmentId,
    productId: row.productId,
    bidMinor: row.bidMinor,
    unitPriceMinor: row.unitPriceMinor,
    currency: row.currency,
    indexedFromId: row.indexedFromId,
    indexLabel: row.indexLabel,
    indexBasisPoints: row.indexBasisPoints,
    indexBase: row.indexBase as IndexBase | null,
    notes: row.notes,
    validFrom: row.validFrom,
    validTo: row.validTo,
    ...stampsOf(row),
  }
}

/** `EXCLUDE USING gist (company_id, service_area_assignment_id, product_id, daterange)`: one price of an assignment and a product is in force at a time; an indexation is the next row. */
const PRICE_RUNNING = "service_provider_price_no_overlap"
const PRICE_RUNNING_SENTENCE = "This assignment already prices this product over part of that period; end it first"

/** What a price put outside its assignment's period is refused with, at the bound the caller chose. */
export const OUTSIDE_ASSIGNMENT = "Outside the assignment's period"

/** What an indexation applied on or before the row's start is refused with, at `appliedFrom`. */
export const INDEX_OUTSIDE_PERIOD = "The index applies inside the price's period"

/** What an indexation of a row already over is refused with: the row in force is the one to index. */
export const priceEnded = (validTo: string): string => `This price ended on ${validTo}; index the price in force`

const noSuchPrice = (id: string) => problem(404, { detail: `No service provider price ${id} this account reaches` })

/**
 * The prices the caller reads: the office's projects' (`inProjects`), or,
 * for a provider's account, the prices under the assignments naming its own
 * provider, through `exists` over the assignment (auth/provider.ts).
 */
const readable = (tx: Tx, principal: Principal) =>
  and(
    eq(serviceProviderPrice.companyId, principal.companyId),
    providerIdOf(principal) === null
      ? inProjects(serviceProviderPrice.projectId, principal)
      : exists(
          tx
            .select({ one: sql`1` })
            .from(serviceAreaAssignment)
            .where(and(eq(serviceAreaAssignment.companyId, principal.companyId), eq(serviceAreaAssignment.id, serviceProviderPrice.serviceAreaAssignmentId), reachesAssignments(principal))),
        ),
  )

/** The prices the caller writes: the office's projects' and no other, since the company sets what it pays. */
const writable = (principal: Principal) => and(eq(serviceProviderPrice.companyId, principal.companyId), inProjects(serviceProviderPrice.projectId, principal))

/** One price by id under a scope; undefined when it is not there. */
async function findPrice(tx: Tx, where: SQL | undefined, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(serviceProviderPrice)
    .where(and(where, eq(serviceProviderPrice.id, id)))
    .limit(1)
  return row
}

/** The period of the assignment a stored price hangs on, for the containment a patch is held to; the key says it is there, so its absence is a bug. */
async function assignmentPeriodOf(tx: Tx, companyId: string, id: string): Promise<Period> {
  const [row] = await tx
    .select({ validFrom: serviceAreaAssignment.validFrom, validTo: serviceAreaAssignment.validTo })
    .from(serviceAreaAssignment)
    .where(and(eq(serviceAreaAssignment.companyId, companyId), eq(serviceAreaAssignment.id, id)))
    .limit(1)
  if (row === undefined) throw new Error(`assignmentPeriodOf: no assignment ${id} in company ${companyId}`)
  return row
}

/** The prices under every assignment naming a provider, for the list's `serviceProviderId` filter. */
const underProvider = (tx: Tx, companyId: string, serviceProviderId: string) =>
  exists(
    tx
      .select({ one: sql`1` })
      .from(serviceAreaAssignment)
      .where(and(eq(serviceAreaAssignment.companyId, companyId), eq(serviceAreaAssignment.id, serviceProviderPrice.serviceAreaAssignmentId), eq(serviceAreaAssignment.serviceProviderId, serviceProviderId))),
  )

export function serviceProviderPriceRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/service-provider-prices",
      describeRoute({
        operationId: "listServiceProviderPrices",
        summary: "The service provider prices the caller reaches",
        description:
          "One page of service provider prices, oldest first (ids are time-ordered). An office account reads the prices of the projects it works in; a service provider's account, which works in no project, reads the prices under the assignments naming its own provider and no other. `projectId` narrows it to one of the caller's projects; naming another is refused. `serviceAreaAssignmentId` narrows it to one assignment's, `serviceProviderId` to the prices under every assignment naming that provider, `productId` to one product's, and `validOn` to the prices in force on that day, `validFrom` inclusive and `validTo` exclusive — which is how the fee on a day is read across an indexation. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of service provider prices.", PricePage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `validOn` is not a calendar day, a filter is not an id, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `commercial.service-provider-prices`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", ServiceProviderPriceListQuery),
      async (c) => {
        const { limit, cursor, projectId, serviceAreaAssignmentId, serviceProviderId, productId, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await tx
          .select(columns)
          .from(serviceProviderPrice)
          .where(
            and(
              readable(tx, principal),
              projectId === undefined ? undefined : eq(serviceProviderPrice.projectId, projectId),
              serviceAreaAssignmentId === undefined ? undefined : eq(serviceProviderPrice.serviceAreaAssignmentId, serviceAreaAssignmentId),
              serviceProviderId === undefined ? undefined : underProvider(tx, principal.companyId, serviceProviderId),
              productId === undefined ? undefined : eq(serviceProviderPrice.productId, productId),
              day === undefined ? undefined : validOn(serviceProviderPrice, day),
              after === undefined ? undefined : gt(serviceProviderPrice.id, after),
            ),
          )
          .orderBy(asc(serviceProviderPrice.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(priceOf), limit))
      },
    )
    .post(
      "/service-provider-prices",
      describeRoute({
        operationId: "createServiceProviderPrice",
        summary: "Write a service provider price",
        description:
          "Writes the first row of a price chain under one assignment, which must be an assignment of a project the caller works in (400 on `serviceAreaAssignmentId`; the body names no project, since the assignment's is the price's): the product, a product of that project (400 on `productId`) and `active`, since a price is a new reference to it (409 otherwise); the bid in minor units, contractually locked from here on; the current fee, the bid when absent; and the period, half-open and inside the assignment's (400 on the bound outside). The currency is the project's and is not in the body. One price of an assignment and a product is in force at a time, so a period overlapping one is refused (409, `This assignment already prices this product over part of that period; end it first`); a new fee is not a second row here but an indexation, `POST /service-provider-prices/{id}/index`. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The price as it was written.", ServiceProviderPrice),
          400: describeProblem("The body is missing a field, names a member the server owns (the currency and the index columns included), ends on or before the day it starts, puts a bound outside the assignment's period, or names an assignment outside the caller's projects or a product that is not the assignment's project's."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `commercial.service-provider-prices`."),
          409: describeProblem("The product is not active, or the assignment already prices this product over part of that period."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", ServiceProviderPriceCreate),
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The assignment's lock, then the assignment: a price being added and
        // the assignment being shortened are the two halves of one rule
        // (routes/periods.ts). An id nobody minted locks nothing and is the
        // 400 the check below spells.
        await lockRow(tx, serviceAreaAssignment, { companyId: principal.companyId, id: values.serviceAreaAssignmentId })
        const assignment = await requireServiceAreaAssignment(tx, { companyId: principal.companyId, projectId: projectIdsOf(principal) }, values.serviceAreaAssignmentId)
        if (assignment === undefined) throw new Error("requireServiceAreaAssignment answers the row for an id that is there")
        const within = { companyId: principal.companyId, projectId: assignment.projectId }
        const productStatus = await requireProduct(tx, within, values.productId)
        requireWithin(assignment, periodOf(values), OUTSIDE_ASSIGNMENT)

        // Every 400 above, every 409 below (routes/statuses.ts).
        refuseUnofferedProduct(productStatus)
        const currency = await projectCurrency(tx, principal.companyId, assignment.projectId)
        const [row] = await refuseOverlap({ [PRICE_RUNNING]: PRICE_RUNNING_SENTENCE }, () =>
          tx
            .insert(serviceProviderPrice)
            .values({
              ...values,
              id: newId(),
              companyId: principal.companyId,
              projectId: assignment.projectId,
              unitPriceMinor: values.unitPriceMinor ?? values.bidMinor,
              currency,
            })
            .returning(columns),
        )
        return created(c, "/service-provider-prices", priceOf(row))
      },
    )
    .get(
      "/service-provider-prices/:id",
      describeRoute({
        operationId: "getServiceProviderPrice",
        summary: "One service provider price",
        description:
          "One price the caller reaches: of a project an office account works in, or under an assignment naming a service provider account's own provider. A price outside that is a price that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The price.", ServiceProviderPrice),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `commercial.service-provider-prices`."),
          404: describeProblem("No service provider price with that id this account reaches."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const tx = c.get("tx")
        const row = await findPrice(tx, readable(tx, c.get("principal")), id)
        if (row === undefined) throw noSuchPrice(id)
        return c.json(priceOf(row))
      },
    )
    .patch(
      "/service-provider-prices/:id",
      describeRoute({
        operationId: "patchServiceProviderPrice",
        summary: "Amend a service provider price",
        description:
          "Changes the notes or the end of one price of a project the caller works in; every field is optional and at least one must be given. The bid never changes — it is contractually locked — and the fee moves through `POST /service-provider-prices/{id}/index` alone; the assignment, the product, the start and the project are not patchable either. Moving the end is held under the assignment's lock and then the price's: the end still comes after the start, the price still lies inside the assignment's period (400 on `validTo`), and the price still overlaps no other row of the chain (409): a reopened or lengthened row meeting the indexed one after it is refused there. A service provider's account changes nothing here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The price as it now stands.", ServiceProviderPrice),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own (the bid, the fee, the assignment, the product and the start included), ends on or before the day the price starts, or puts the end outside the assignment's period."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `commercial.service-provider-prices`."),
          404: describeProblem("No service provider price with that id in the projects this account works in."),
          409: describeProblem("Another price of the assignment and the product is in force over part of the new period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ServiceProviderPricePatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The price is read once to learn its assignment, then both locks are
        // taken from the top down — the assignment before the price, as the
        // assignment's patch and the price's create take them — and the price
        // is read again under them, so an assignment shortened while this
        // waited is what the end is held inside (routes/periods.ts).
        const named = await findPrice(tx, writable(principal), id)
        if (named === undefined) throw noSuchPrice(id)
        await lockRow(tx, serviceAreaAssignment, { companyId: principal.companyId, id: named.serviceAreaAssignmentId })
        await lockRow(tx, serviceProviderPrice, { companyId: principal.companyId, id })
        const current = await findPrice(tx, writable(principal), id)
        if (current === undefined) throw noSuchPrice(id)
        if (patch.validTo !== undefined) {
          const assignment = await assignmentPeriodOf(tx, principal.companyId, current.serviceAreaAssignmentId)
          requireWithin(assignment, periodAfter(current, patch), OUTSIDE_ASSIGNMENT)
        }
        const [row] = await refuseOverlap({ [PRICE_RUNNING]: PRICE_RUNNING_SENTENCE }, () =>
          tx
            .update(serviceProviderPrice)
            .set(patch)
            .where(and(writable(principal), eq(serviceProviderPrice.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchPrice(id)
        return c.json(priceOf(row))
      },
    )
    .post(
      "/service-provider-prices/:id/index",
      describeRoute({
        operationId: "indexServiceProviderPrice",
        summary: "Index a service provider price",
        description:
          "Applies an indexation to one price of a project the caller works in, as a new row and never an update: this row is ended on `appliedFrom` and the next is written from it with the same assignment, product, bid and currency, the new fee — `round(base × (1 + basisPoints / 10 000))` in minor units, half away from zero, `base` the locked bid or the fee this row carries (`bid` or `current-fee`, the latter compounding earlier indexations) — `indexedFromId` naming this row, the label, the basis points (negative is a deflator) and the base, and this row's end as its own, so the fee on any day stays a read of the row in force on it and the chain through `indexedFromId` is the history. `appliedFrom` is after this row's start (400 on `appliedFrom`, `The index applies inside the price's period`); a row already ended on or before `appliedFrom` is over and not the one to index (409, `This price ended on 2026-12-31; index the price in force`). Held under the row's lock, so two indexations take turns. Answers the new row, 201 with `Location`, since a row was made.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The indexed price, the new row of the chain.", ServiceProviderPrice),
          400: describeProblem("The path does not hold an id, or the body is missing a field, names a member the server owns, gives a base outside the two, or applies the index on or before the row's start."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `commercial.service-provider-prices`."),
          404: describeProblem("No service provider price with that id in the projects this account works in."),
          409: describeProblem("The price already ended on or before the day the index applies from."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ServiceProviderPriceIndex),
      async (c) => {
        const { id } = c.req.valid("param")
        const index = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The row's lock before it is read, so two indexations of one row
        // take turns and the second sees the end the first wrote.
        await lockRow(tx, serviceProviderPrice, { companyId: principal.companyId, id })
        const current = await findPrice(tx, writable(principal), id)
        if (current === undefined) throw noSuchPrice(id)
        if (index.appliedFrom <= current.validFrom) throw invalidRequest("body", [{ path: "appliedFrom", message: INDEX_OUTSIDE_PERIOD }])
        if (current.validTo !== null && index.appliedFrom >= current.validTo) throw problem(409, { detail: priceEnded(current.validTo) })

        const base = index.base === "bid" ? current.bidMinor : current.unitPriceMinor
        await tx
          .update(serviceProviderPrice)
          .set({ validTo: index.appliedFrom })
          .where(and(eq(serviceProviderPrice.companyId, principal.companyId), eq(serviceProviderPrice.id, id)))
        const [row] = await refuseOverlap({ [PRICE_RUNNING]: PRICE_RUNNING_SENTENCE }, () =>
          tx
            .insert(serviceProviderPrice)
            .values({
              id: newId(),
              companyId: principal.companyId,
              projectId: current.projectId,
              serviceAreaAssignmentId: current.serviceAreaAssignmentId,
              productId: current.productId,
              bidMinor: current.bidMinor,
              unitPriceMinor: indexedFee(base, index.basisPoints),
              currency: current.currency,
              indexedFromId: current.id,
              indexLabel: index.label,
              indexBasisPoints: index.basisPoints,
              indexBase: index.base,
              notes: null,
              validFrom: index.appliedFrom,
              validTo: current.validTo,
            })
            .returning(columns),
        )
        return created(c, "/service-provider-prices", priceOf(row))
      },
    )
}
