// What a customer pays (Issue #112, ADR-0005): the Price List and its rows.
// `GET /price-lists` lists them, `POST /price-lists` writes one, `GET`/`PATCH
// /price-lists/:id` read and amend one; `GET`/`POST /price-lists/:id/rows`
// read and add a list's rows and `GET`/`PATCH /price-list-rows/:id` read and
// amend one; and `GET /price-lists/:id/resolve` is the read a person makes of
// the resolver. No delete anywhere: a list and a row end by `validTo`, and a
// row a billable event was priced by is quoted by that event.
//
// A list is a project's tariff (`PL-CPH-2026`) or a named list an agreement
// is priced under: effective-dated, one list of a code in force at a time
// (`price_list_no_overlap`), its `code` and `currency` set once, since every
// row's amount is quoted in the currency. `isDefault` names the one list an
// agreement without one is priced under — one per project whatever its
// period, which the partial unique index `price_list_default_idx` holds, so
// a new tariff year is new rows in it and not a second default list (§7.3).
// Two currency rules are the API's, each a 400 on the field the caller
// chose: a default list is in its project's currency (`isDefault`), and an
// agreement's list in the agreement's (routes/agreements.ts, `priceListId`),
// so every event under an agreement is in its currency by construction and a
// billing run never converts.
//
// A row is one price under a condition set — the product, the unit price in
// minor units, and up to five conditions: the prototype's Zone as a Planning
// Area, its Customer type as the Registry's customer kind, a container type,
// a waste fraction, and the negotiated customer a row is for alone. "Every
// sellable price (default, variation, negotiated) is a row; the default price
// is a row with no conditions", and a scheduled change is the next row: the
// database keys `price_list_row_no_overlap` on the generated `condition_key`,
// so one row of a list, a product and a condition set is in force at a time
// and a default row and a zone row of one product coexist. A row's period
// lies inside its list's — routes/periods.ts's two rules under the list's row
// lock: a row put outside is a 400 naming the bound, a list shortened under
// its rows a 409 counting them. A row's patch moves its price, its note and
// its end; a condition or a start never, since they are the key and the
// period: end the row and add another. A price is a new reference to its
// product, so the product is `active` (routes/statuses.ts, #79).
//
// The resolve read is `RESOLUTION_RULE` as code (@waste/domain/finance/pricing):
// the caller names the product, the day and the conditions, every row of the
// list for the product is handed to `resolvePrice` — the rows out of force on
// the day too, so a person reads "Not effective until" and "Expired on"
// beside the conditions a row failed — and the answer is every verdict, the
// winner first, with the winner's price, the product's VAT rate and the
// list's currency. The sentences name what a person reads, so the ids the
// rows and the query name are spelled as the rows they are (a planning
// area's, a container type's, a fraction's and a customer's name), read in
// one statement per kind and only where something names one. The read looks
// at no agreement: which list an agreement is priced under is the event's
// question (routes/billable-writes.ts), and here the office asks what a list would say.
//
// The rest is the shape every project-scoped family has: each statement
// carries the tenant and `inProjects` (auth/projects.ts), a create names a
// project the caller works in and a record never moves between projects; a
// provider's account works in no project and so reaches no list (§3). The
// grant is `commercial.price-rows` throughout, the resolve read included.
import type { CustomerKind } from "@waste/contracts/customers"
import { Page } from "@waste/contracts/pagination"
import {
  PriceList,
  PriceListCreate,
  PriceListListQuery,
  PriceListPatch,
  PriceListRow,
  PriceListRowCreate,
  PriceListRowListQuery,
  PriceListRowPatch,
  PriceResolution,
  PriceResolveQuery,
} from "@waste/contracts/price-lists"
import type { Tx } from "@waste/db/client"
import { validOn } from "@waste/db/query/valid-on"
import { containerType, product, wasteFraction } from "@waste/db/schema/catalogue"
import { customer } from "@waste/db/schema/customers"
import { priceList, priceListRow } from "@waste/db/schema/finance"
import { planningArea } from "@waste/db/schema/planning-areas"
import { resolvePrice, type PriceInput, type PriceLabels } from "@waste/domain/finance/pricing"
import { count } from "@waste/domain/text"
import { and, asc, eq, gt, inArray } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { projectCurrency } from "./fleet-lookups"
import { notWithin, periodAfter, periodOf, refuseStranded, requireOrdered, requireWithin, type Period } from "./periods"
import { NOT_A_PRODUCT, requireContainerType, requireCustomer, requirePlanningArea, requireProduct, requireWasteFraction, type Scope } from "./references"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseDuplicate, refuseOverlap, stampsOf } from "./shared"
import { refuseUnofferedProduct } from "./statuses"

const MODULE = "commercial.price-rows"
const PriceListPage = Page(PriceList)
const PriceListRowPage = Page(PriceListRow)

const columns = {
  id: priceList.id,
  projectId: priceList.projectId,
  code: priceList.code,
  name: priceList.name,
  currency: priceList.currency,
  isDefault: priceList.isDefault,
  notes: priceList.notes,
  validFrom: priceList.validFrom,
  validTo: priceList.validTo,
  createdAt: priceList.createdAt,
  updatedAt: priceList.updatedAt,
}

type Row = Pick<typeof priceList.$inferSelect, keyof typeof columns>

/** The list on the wire. */
function listOf(row: Row): PriceList {
  return {
    id: row.id,
    projectId: row.projectId,
    code: row.code,
    name: row.name,
    currency: row.currency,
    isDefault: row.isDefault,
    notes: row.notes,
    validFrom: row.validFrom,
    validTo: row.validTo,
    ...stampsOf(row),
  }
}

const rowColumns = {
  id: priceListRow.id,
  projectId: priceListRow.projectId,
  priceListId: priceListRow.priceListId,
  productId: priceListRow.productId,
  unitPriceMinor: priceListRow.unitPriceMinor,
  planningAreaId: priceListRow.planningAreaId,
  customerKind: priceListRow.customerKind,
  containerTypeId: priceListRow.containerTypeId,
  wasteFractionId: priceListRow.wasteFractionId,
  customerId: priceListRow.customerId,
  note: priceListRow.note,
  validFrom: priceListRow.validFrom,
  validTo: priceListRow.validTo,
  createdAt: priceListRow.createdAt,
  updatedAt: priceListRow.updatedAt,
}

type PriceRowRow = Pick<typeof priceListRow.$inferSelect, keyof typeof rowColumns>

/** The row on the wire; `conditionKey` is the database's and never travels. `customerKind` is text with a CHECK in the database and an enum here, both off the Registry's one tuple. */
function rowOf(row: PriceRowRow): PriceListRow {
  return {
    id: row.id,
    projectId: row.projectId,
    priceListId: row.priceListId,
    productId: row.productId,
    unitPriceMinor: row.unitPriceMinor,
    planningAreaId: row.planningAreaId,
    customerKind: row.customerKind as CustomerKind | null,
    containerTypeId: row.containerTypeId,
    wasteFractionId: row.wasteFractionId,
    customerId: row.customerId,
    note: row.note,
    validFrom: row.validFrom,
    validTo: row.validTo,
    ...stampsOf(row),
  }
}

/** `EXCLUDE USING gist (company_id, project_id, code, daterange)`: one list of a code is in force at a time, and the next may follow it. */
const LIST_RUNNING = "price_list_no_overlap"
const LIST_RUNNING_SENTENCE = "A price list of this code is already in force over part of that period"

/** `unique (company_id, project_id) where is_default`: one default list per project, whatever its period. */
const DEFAULT_TAKEN = "price_list_default_idx"
const DEFAULT_TAKEN_SENTENCE = "This project already has a default price list; unset it first"

/** What a default list in another currency than its project's is refused with, at `isDefault`, since that is the field that made the rule apply. */
export const defaultListCurrency = (currency: string): string => `A default price list is in the project's currency (${currency})`

/** `EXCLUDE USING gist (company_id, price_list_id, product_id, condition_key, daterange)`: one row of a list, a product and a condition set is in force at a time; a scheduled change is the next row. */
const ROW_RUNNING = "price_list_row_no_overlap"
const ROW_RUNNING_SENTENCE = "A row of this product with these conditions is already in force over part of that period; end it first or schedule this one after it"

/** What a row put outside its list's period is refused with, at the bound the caller chose. */
export const OUTSIDE_PRICE_LIST = "Outside the price list's period"

/** What a list shortened under its rows is refused with; the rows in the way are not in the body, so the caller ends them first. */
const strandedRows = (rows: number) => `${count(rows, "price row")} ${rows === 1 ? "falls" : "fall"} outside the new period; end ${rows === 1 ? "it" : "them"} first`

const noSuchList = (id: string) => problem(404, { detail: `No price list ${id} in the projects this account works in` })
const noSuchRow = (id: string) => problem(404, { detail: `No price row ${id} in the projects this account works in` })

/** The rows of this company, in the projects the caller works in: what every list statement is bounded by. */
const scope = (principal: Principal) => and(eq(priceList.companyId, principal.companyId), inProjects(priceList.projectId, principal))

/** The same for a row, which carries the project its list is in. */
const rowScope = (principal: Principal) => and(eq(priceListRow.companyId, principal.companyId), inProjects(priceListRow.projectId, principal))

/** One list of this company by id, inside the caller's projects; undefined when it is neither. */
async function findList(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(priceList)
    .where(and(scope(principal), eq(priceList.id, id)))
    .limit(1)
  return row
}

/** One row of this company by id, inside the caller's projects; undefined when it is neither. */
async function findRow(tx: Tx, principal: Principal, id: string): Promise<PriceRowRow | undefined> {
  const [row] = await tx
    .select(rowColumns)
    .from(priceListRow)
    .where(and(rowScope(principal), eq(priceListRow.id, id)))
    .limit(1)
  return row
}

/** Holds a default list to its project's currency: the field that made the rule apply is `isDefault`, so the refusal sits there. */
async function requireDefaultInProjectCurrency(tx: Tx, within: Scope, currency: string): Promise<void> {
  const expected = await projectCurrency(tx, within.companyId, within.projectId)
  if (currency !== expected) throw invalidRequest("body", [{ path: "isDefault", message: defaultListCurrency(expected) }])
}

/** The `where` of the rows a list's move would strand, for `refuseStranded` (routes/periods.ts): this company's rows of the list whose period leaves the new one. */
const strandedRowsOf = (list: { companyId: string; id: string }, period: Period) =>
  and(eq(priceListRow.companyId, list.companyId), eq(priceListRow.priceListId, list.id), notWithin(priceListRow, period))

/** The four conditions a row may name beside a customer, held to the scope each key allows (routes/references.ts); a null or an absent one names nothing. */
async function requireConditions(tx: Tx, within: Scope, values: PriceListRowCreate): Promise<void> {
  await requirePlanningArea(tx, within, values.planningAreaId)
  await requireContainerType(tx, within.companyId, values.containerTypeId)
  await requireWasteFraction(tx, within.companyId, values.wasteFractionId)
  await requireCustomer(tx, within.companyId, values.customerId)
}

/** The ids of one kind the rows and the query name, each once. */
const named = (values: readonly (string | null | undefined)[]): string[] => [...new Set(values.filter((value): value is string => value != null))]

/** One kind's names by id, in one statement, or nothing when nothing names one. */
async function namesOf(tx: Tx, companyId: string, table: typeof planningArea | typeof containerType | typeof wasteFraction | typeof customer, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await tx
    .select({ id: table.id, name: table.name })
    .from(table)
    .where(and(eq(table.companyId, companyId), inArray(table.id, [...ids])))
  return new Map(rows.map((row) => [row.id, row.name]))
}

/**
 * How the ids in a verdict's sentence are spelled: the name of the planning
 * area, the container type, the waste fraction or the customer they name, so
 * a person reads "Waste fraction is Glass, not Residual" and not two uuids.
 * One statement per kind, and only for a kind something names; an id the
 * company does not have (a row of the query's own that is not there) stands
 * as itself, which the domain does when a label gives none.
 */
async function labelsFor(tx: Tx, companyId: string, rows: readonly PriceListRow[], input: PriceInput): Promise<PriceLabels> {
  const [areas, types, fractions, customers] = await Promise.all([
    namesOf(tx, companyId, planningArea, named([...rows.map((row) => row.planningAreaId), input.planningAreaId])),
    namesOf(tx, companyId, containerType, named([...rows.map((row) => row.containerTypeId), input.containerTypeId])),
    namesOf(tx, companyId, wasteFraction, named([...rows.map((row) => row.wasteFractionId), input.wasteFractionId])),
    namesOf(tx, companyId, customer, named([...rows.map((row) => row.customerId), input.customerId])),
  ])
  const spell = (names: Map<string, string>) => (id: string) => names.get(id) ?? id
  return { planningAreaId: spell(areas), containerTypeId: spell(types), wasteFractionId: spell(fractions), customerId: spell(customers) }
}

export function priceListRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/price-lists",
      describeRoute({
        operationId: "listPriceLists",
        summary: "The price lists of the caller's projects",
        description:
          "One page of price lists, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page: a provider never sees a customer's prices. `projectId` narrows it to one of those projects; naming another is refused. `validOn` asks for the lists in force on that day, `validFrom` inclusive and `validTo` exclusive, which is how Upcoming, Active and Expired are asked for; `isDefault` picks the project's default list (`true`) or the named ones (`false`). Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of price lists.", PriceListPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `validOn` is not a calendar day, `isDefault` is not `true` or `false`, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `commercial.price-rows`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", PriceListListQuery),
      async (c) => {
        const { limit, cursor, projectId, validOn: day, isDefault } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(columns)
          .from(priceList)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(priceList.projectId, projectId),
              day === undefined ? undefined : validOn(priceList, day),
              isDefault === undefined ? undefined : eq(priceList.isDefault, isDefault),
              after === undefined ? undefined : gt(priceList.id, after),
            ),
          )
          .orderBy(asc(priceList.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(listOf), limit))
      },
    )
    .post(
      "/price-lists",
      describeRoute({
        operationId: "createPriceList",
        summary: "Write a price list",
        description:
          "Writes a price list in one project, which must be a project the caller works in. The code is the stable reference a person quotes (`pl-cph-2026`) and is set once; one list of a code is in force at a time, so a period overlapping another list of the code is refused (409). The currency is set once too — every row's amount is quoted in it — and is the project's when absent; a default list (`isDefault: true`) is always in the project's currency, and one in another is refused (400 on `isDefault`, `A default price list is in the project's currency (DKK)`). A project has one default list whatever its period — the list an agreement without one is priced under — so a second is refused (409, `This project already has a default price list; unset it first`): a new tariff year is new rows in it, not a new default list. The period is half-open, `validFrom` the first day in force and `validTo` the first day out of it, absent meaning the list is still running. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The price list as it was written.", PriceList),
          400: describeProblem("The body is missing a field, names a member the server owns, names a project this account does not work in, ends on or before the day it starts, or makes a default list in another currency than the project's."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `commercial.price-rows`."),
          409: describeProblem("A price list of this code is already in force over part of that period, or the project already has a default price list."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", PriceListCreate),
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        const within: Scope = { companyId: principal.companyId, projectId: values.projectId }
        const currency = values.currency ?? (await projectCurrency(tx, within.companyId, within.projectId))
        if (values.isDefault) await requireDefaultInProjectCurrency(tx, within, currency)
        const [row] = await refuseOverlap({ [LIST_RUNNING]: LIST_RUNNING_SENTENCE }, () =>
          refuseDuplicate({ [DEFAULT_TAKEN]: DEFAULT_TAKEN_SENTENCE }, () =>
            tx
              .insert(priceList)
              .values({ ...values, currency, id: newId(), companyId: principal.companyId })
              .returning(columns),
          ),
        )
        return created(c, "/price-lists", listOf(row))
      },
    )
    .get(
      "/price-lists/:id",
      describeRoute({
        operationId: "getPriceList",
        summary: "One price list",
        description:
          "One price list of a project the caller works in. A list of another company, or of a project this account does not work in, is a list that does not exist here. Its rows are `GET /price-lists/{id}/rows`.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The price list.", PriceList),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `commercial.price-rows`."),
          404: describeProblem("No price list with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findList(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchList(id)
        return c.json(listOf(row))
      },
    )
    .patch(
      "/price-lists/:id",
      describeRoute({
        operationId: "patchPriceList",
        summary: "Amend a price list",
        description:
          "Changes the name, the default flag, the notes or the period of one price list of a project the caller works in; every field is optional and at least one must be given. The code and the currency do not change — the rows are quoted in the currency, and a list that needs another is another list — and the project is not patchable, since a record does not move between projects. Moving the period is held to three rules under the list's row lock: the end still comes after the start, which a body naming one bound cannot see by itself; the new period still holds every row of the list — a shortening that would leave one outside is refused (409) counting them, and the rows have to be ended first; and the period may not overlap another list of the code (409). `isDefault: true` makes this the project's default list, refused when the list is not in the project's currency (400 on `isDefault`) or when the project already has one (409); `isDefault: false` on the default list is taken, and the agreements priced under no list of their own are then blocked with `no-price-list` until another is set.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The price list as it now stands.", PriceList),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own (the code, the currency and the project included), ends on or before the day it starts, or makes a default list in another currency than the project's."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `commercial.price-rows`."),
          404: describeProblem("No price list with that id in the projects this account works in."),
          409: describeProblem("Rows of the list would fall outside the new period, another list of the code is in force over part of it, or the project already has a default price list."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", PriceListPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The row this patch counts rows against, locked before it is read: a
        // shortening and a row being added to it are the two halves of one
        // rule, and they serialise here (routes/shared.ts).
        await lockRow(tx, priceList, { companyId: principal.companyId, id })
        const current = await findList(tx, principal, id)
        if (current === undefined) throw noSuchList(id)

        const period = patch.validFrom !== undefined || patch.validTo !== undefined ? periodAfter(current, patch) : undefined
        if (period !== undefined) requireOrdered(period)
        if (patch.isDefault === true) await requireDefaultInProjectCurrency(tx, { companyId: principal.companyId, projectId: current.projectId }, current.currency)

        // Every 400 above, every 409 below.
        if (period !== undefined) await refuseStranded(tx, priceListRow, strandedRowsOf({ companyId: principal.companyId, id }, period), strandedRows)

        const duplicates: Record<string, string> = patch.isDefault === true ? { [DEFAULT_TAKEN]: DEFAULT_TAKEN_SENTENCE } : {}
        const [row] = await refuseOverlap({ [LIST_RUNNING]: LIST_RUNNING_SENTENCE }, () =>
          refuseDuplicate(duplicates, () =>
            tx
              .update(priceList)
              .set(patch)
              .where(and(scope(principal), eq(priceList.id, id)))
              .returning(columns),
          ),
        )
        if (row === undefined) throw noSuchList(id)
        return c.json(listOf(row))
      },
    )
    .get(
      "/price-lists/:id/rows",
      describeRoute({
        operationId: "listPriceListRows",
        summary: "One price list's rows",
        description:
          "One page of the list's rows, oldest first (ids are time-ordered). The path says the list, so the filters are `productId`, the rows pricing that product, and `validOn`, the rows in force on that day — `validFrom` inclusive and `validTo` exclusive — which is how the tariff on a day is read. A list of another company, or of a project this account does not work in, is a list that does not exist here. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the list's rows.", PriceListRowPage),
          400: describeProblem("The path does not hold an id, the page size is outside 1..200, the cursor is not one this API wrote, `productId` is not an id, or `validOn` is not a calendar day."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `commercial.price-rows`."),
          404: describeProblem("No price list with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", PriceListRowListQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit, cursor, productId, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if ((await findList(tx, principal, id)) === undefined) throw noSuchList(id)
        const rows = await tx
          .select(rowColumns)
          .from(priceListRow)
          .where(
            and(
              rowScope(principal),
              eq(priceListRow.priceListId, id),
              productId === undefined ? undefined : eq(priceListRow.productId, productId),
              day === undefined ? undefined : validOn(priceListRow, day),
              after === undefined ? undefined : gt(priceListRow.id, after),
            ),
          )
          .orderBy(asc(priceListRow.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(rowOf), limit))
      },
    )
    .post(
      "/price-lists/:id/rows",
      describeRoute({
        operationId: "createPriceListRow",
        summary: "Add a row to a price list",
        description:
          "Adds one price to the list in the path, which must be a list of a project the caller works in: the product, the unit price in the list's currency and in minor units (a free service is a price of zero, not a missing row), and up to five conditions — a planning area of the project (the prototype's Zone, matched against the route's scheme's planning area), a customer kind (its Customer type, matched against the agreement's customer), a container type and a waste fraction of this company, and the customer a negotiated row is for alone; a row with no conditions is the default price. The product is a product of the project (400 on `productId`) and `active`, since a price is a new reference to it (409 otherwise). The period lies inside the list's (400 on the bound outside), and one row of a product with one condition set is in force at a time, so a period overlapping such a row is refused (409, `A row of this product with these conditions is already in force over part of that period; end it first or schedule this one after it`): a scheduled change is a row starting when the current one ends. The server mints the id; the row is read at `/price-list-rows/{id}`.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The row as it was written.", PriceListRow),
          400: describeProblem("The path does not hold an id, or the body is missing a field, names a member the server owns, ends on or before the day it starts, puts a bound outside the list's period, or names a product, planning area, container type, waste fraction or customer that is not this project's or this company's."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `commercial.price-rows`."),
          404: describeProblem("No price list with that id in the projects this account works in."),
          409: describeProblem("The product is not active, or a row of this product with these conditions is already in force over part of that period."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", PriceListRowCreate),
      async (c) => {
        const { id } = c.req.valid("param")
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The list's lock, then the list: a row being added and the list
        // being shortened are the two halves of one rule (routes/periods.ts).
        await lockRow(tx, priceList, { companyId: principal.companyId, id })
        const list = await findList(tx, principal, id)
        if (list === undefined) throw noSuchList(id)
        const within: Scope = { companyId: principal.companyId, projectId: list.projectId }
        const productStatus = await requireProduct(tx, within, values.productId)
        await requireConditions(tx, within, values)
        requireWithin(list, periodOf(values), OUTSIDE_PRICE_LIST)

        // Every 400 above, every 409 below (routes/statuses.ts).
        refuseUnofferedProduct(productStatus)
        const [row] = await refuseOverlap({ [ROW_RUNNING]: ROW_RUNNING_SENTENCE }, () =>
          tx
            .insert(priceListRow)
            .values({ ...values, id: newId(), companyId: principal.companyId, projectId: list.projectId, priceListId: list.id })
            .returning(rowColumns),
        )
        return created(c, "/price-list-rows", rowOf(row))
      },
    )
    .get(
      "/price-lists/:id/resolve",
      describeRoute({
        operationId: "resolvePriceListPrice",
        summary: "What a price list says for a product on a day",
        description:
          "The resolver as a read: hands every row of the list for `productId` to the resolution rule — \"The row matching the most conditions wins. A negotiated row for the specific customer always wins. Remaining ties go to the row with the newest effective-from date.\", a further tie going to the row made first — judged on the day `on` against the conditions the query names: `planningAreaId` (the route's scheme's planning area), `customerKind` (the agreement's customer's kind), `containerTypeId`, `wasteFractionId` and `customerId` (the agreement's customer, which a negotiated row is for alone). Answers every row's verdict, the winner first — eligible or not, the sentence it lost with (`Requires container type 660 L`, `Waste fraction is Glass, not Residual`, `Negotiated for Østerbro Housing Association, not this customer`, `Not effective until 2027-01-01`, `Expired on 2026-12-31`), what it matched, its score, whether it won — beside the winner's unit price (null when no row is eligible), the product's VAT rate on the day (null where the product has none, which would block an event with `no-vat-rate`) and the list's currency. The product is a product of the list's project (400 on `productId`). The read looks at no agreement: the caller names the conditions, and which list an agreement is priced under is the event's question.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("Every verdict, the winner, the winning price, the VAT rate and the currency.", PriceResolution),
          400: describeProblem("The path does not hold an id, `productId` is missing or not a product of the list's project, `on` is not a calendar day, `customerKind` is not one of the two, or a condition is not an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `commercial.price-rows`."),
          404: describeProblem("No price list with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", PriceResolveQuery),
      async (c) => {
        const { id } = c.req.valid("param")
        const { productId, on, ...conditions } = c.req.valid("query")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const list = await findList(tx, principal, id)
        if (list === undefined) throw noSuchList(id)
        // The product's rate, and the proof it is the list's project's, in one statement; a query names it, so the refusal sits on the query string.
        const [priced] = await tx
          .select({ vatPercent: product.vatPercent })
          .from(product)
          .where(and(eq(product.companyId, principal.companyId), eq(product.projectId, list.projectId), eq(product.id, productId)))
          .limit(1)
        if (priced === undefined) throw invalidRequest("query", [{ path: "productId", message: NOT_A_PRODUCT }])
        // Every row of the list for the product, whatever its period: a row out of force on the day loses with the sentence saying which way.
        const rows = (
          await tx
            .select(rowColumns)
            .from(priceListRow)
            .where(and(eq(priceListRow.companyId, principal.companyId), eq(priceListRow.priceListId, list.id), eq(priceListRow.productId, productId)))
            .orderBy(asc(priceListRow.id))
        ).map(rowOf)
        const input: PriceInput = { on, ...conditions }
        const resolution = resolvePrice(rows, input, await labelsFor(tx, principal.companyId, rows, input))
        const answer: PriceResolution = {
          verdicts: resolution.verdicts,
          winner: resolution.winner,
          unitPriceMinor: resolution.winner?.row.unitPriceMinor ?? null,
          vatPercent: priced.vatPercent,
          currency: list.currency,
        }
        return c.json(answer)
      },
    )
    .get(
      "/price-list-rows/:id",
      describeRoute({
        operationId: "getPriceListRow",
        summary: "One price row",
        description:
          "One row of a price list of a project the caller works in. A row of another company, or of a project this account does not work in, is a row that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The row.", PriceListRow),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `commercial.price-rows`."),
          404: describeProblem("No price row with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findRow(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchRow(id)
        return c.json(rowOf(row))
      },
    )
    .patch(
      "/price-list-rows/:id",
      describeRoute({
        operationId: "patchPriceListRow",
        summary: "Amend a price row",
        description:
          "Changes the unit price, the note or the end of one row of a price list of a project the caller works in; every field is optional and at least one must be given. A condition, the product and the start do not change — they are the row's key and its period, so a price under other conditions or from another day is another row, and this one is ended on the day the other starts. Moving the end is held under the list's lock and then the row's: the end still comes after the start, the row still lies inside the list's period (400 on `validTo`), and the row still overlaps no other row of the product with these conditions (409) — a reopened or lengthened row meeting the scheduled one after it is refused there.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The row as it now stands.", PriceListRow),
          400: describeProblem("The path does not hold an id, or the patch is empty, names a field the caller does not own (a condition, the product, the start and the list included), ends on or before the day the row starts, or puts the end outside the list's period."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `commercial.price-rows`."),
          404: describeProblem("No price row with that id in the projects this account works in."),
          409: describeProblem("Another row of this product with these conditions is in force over part of the new period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", PriceListRowPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The row is read once to learn its list, then both locks are taken
        // from the top down — the list before the row, as the list's patch
        // and the row's create take them — and the row is read again under
        // them, so a list shortened while this waited is what the end is
        // held inside (routes/periods.ts).
        const named = await findRow(tx, principal, id)
        if (named === undefined) throw noSuchRow(id)
        await lockRow(tx, priceList, { companyId: principal.companyId, id: named.priceListId })
        await lockRow(tx, priceListRow, { companyId: principal.companyId, id })
        const current = await findRow(tx, principal, id)
        if (current === undefined) throw noSuchRow(id)
        if (patch.validTo !== undefined) {
          const list = await findList(tx, principal, current.priceListId)
          if (list === undefined) throw noSuchRow(id)
          requireWithin(list, periodAfter(current, patch), OUTSIDE_PRICE_LIST)
        }

        const [row] = await refuseOverlap({ [ROW_RUNNING]: ROW_RUNNING_SENTENCE }, () =>
          tx
            .update(priceListRow)
            .set(patch)
            .where(and(rowScope(principal), eq(priceListRow.id, id)))
            .returning(rowColumns),
        )
        if (row === undefined) throw noSuchRow(id)
        return c.json(rowOf(row))
      },
    )
}
