// The Container and where it serves (Issue #78, ADR-0003).
// `GET /containers` lists them, `POST /containers` registers one,
// `GET`/`PATCH /containers/:id` read and correct one,
// `POST /containers/:id/placements` puts one into service, and
// `GET /placements`, `GET`/`PATCH /placements/:id` answer and correct the
// service itself. No delete: a container that has been collected from is
// behind pickups and tickets, and taking one out of service is a command of
// the ledger (routes/lifecycle.ts), never a form.
//
// A Container carries no status and no location of its own. An editable
// asset state is the option ADR-0003 rejected: whether a container is in
// stock, issued, broken or retired is Resources' projection over the Stock
// Movement ledger, and where it is, is the placement valid on the day asked.
// What is here is the identity a person reads off the bin — the label, the
// type, the barcode, the RFID, the serial number, who owns it and a note —
// and the label is unique across the company and not inside a project,
// because that is how it is read off a bin.
//
// The Container carries the ledger's reading since Resources (Issue #101):
// `assetState`, its latest Stock Movement folded onto the glossary's four
// states, read on every request through `assetStateOf` (@waste/db/query/
// asset-state) — a LATERAL lookup per row, one probe into the ledger's index,
// joined onto every statement here that answers a Container, the create's and
// the patch's answers read back through it so what a write answers is what
// the next read says — and null for a container with no movement yet. The
// list asks by it: `assetStatus`, and `warehouseId` for the containers
// standing in a warehouse, in stock or in maintenance, held to the projects
// the caller works in like every other filter that names a row.
//
// A placement names the subscription, and through it the agreement, the
// product and the place: ADR-0003 has a placement name all four, and one
// reference that cannot disagree with itself is better than four that can.
// The container is the path's and the project is the container's, so the body
// names neither.
//
// The seam into the ledger (Issue #101): `POST /containers/:id/placements` is
// the `issue` command, one action and one command, and the only door into
// service; `return` and `decommission` (lifecycle.ts) are the doors out, each
// ending the placement and appending the movement together. So a placement's
// end is the ledger's: a create carries none (the contracts refuse `validTo`
// by name), and `PATCH /placements/:id` corrects the end of a placement
// already ended, refusing to set one on an open placement (409) — and a null,
// which would take the end off, is refused by the contracts before the route
// sees it, since the ledger says when the container left. The issue route
// holds what the body names before the ledger is consulted — a subscription
// of another project, a fraction of another company, a start outside the
// subscription's period — so a body that names nothing real is a 400
// whatever the container's state; then hands `move` the placement's
// statements as the Registry half of the movement: `move` takes the
// container's row lock, reads its state, refuses a container that is not in a
// warehouse or in maintenance (409 naming the state — no record, in service
// at another placement, retired), runs `open`, which locks the subscription,
// reads its period again underneath (a read before the lock only says which
// subscription to lock) and writes the placement, and appends the `issue`
// movement from the warehouse the container stood in, `placement_id` the new
// row's. Either both rows exist or neither. A placement starts inside the
// subscription's period and, open, may outlive a bounded subscription on
// paper until the container is returned — the return holds its `validTo`
// inside the period, and a subscription cannot be shortened under an open
// placement (agreements.ts counts it) — since the person issuing the
// container cannot say when it comes back. `occurredAt` and `reference` on
// the body are the movement's and never the placement's.
//
// The cadence in force is read and never written. A placement's
// `serviceFrequencyId` is an override and null is the ordinary case, so the
// answer carries `effectiveServiceFrequencyId`, the coalesce of the
// placement's and the product's, computed in the select on every read — which
// is why every statement here joins the subscription and the product, and why
// a create answers by reading the row back through that same select rather
// than from its own `returning`: what a write answers has to be what the next
// read says. Change the product's cadence and every placement that inherited
// it changes with it, which a stored copy could not do.
//
// The period rules are routes/periods.ts's, the same two the agreements
// module states: a placement lies inside its subscription's period (a 400
// naming the bound), and the subscription's own patch counts the placements
// its new period would strand (a 409 there). What the database holds by
// itself is one container in service in one place at a time — an exclusion
// constraint over `container_id` alone (23P01), turned into a sentence by
// `refuseOverlap`.
//
// A status gates a new reference and never an existing one (routes/statuses.ts,
// Issue #79): a container is not put into service at a place that no longer
// serves — a property not active, a point not open or restricted — which the
// statement proving the subscription is there reads through it and the route
// judges after every 400 it has, while the placements already there are ended
// by their period and not by the status.
//
// The grant is `resources.containers` throughout, placements included: a
// placement is where a container stands and not a surface of its own.
import {
  Container,
  ContainerCreate,
  ContainerListQuery,
  ContainerPatch,
  ContainerServicePlacement,
  ContainerServicePlacementCreate,
  ContainerServicePlacementPatch,
  PlacementListQuery,
  type ContainerOwnership,
} from "@waste/contracts/containers"
import { Page } from "@waste/contracts/pagination"
import type { Tx } from "@waste/db/client"
import type { AssetState } from "@waste/contracts/stock"
import { assetStateOf, assetStatus } from "@waste/db/query/asset-state"
import { validOn } from "@waste/db/query/valid-on"
import { subscription } from "@waste/db/schema/agreements"
import { product } from "@waste/db/schema/catalogue"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { property, sharedCollectionPoint } from "@waste/db/schema/customers"
import type { AssetStatus } from "@waste/domain/resources/vocabulary"
import { and, asc, eq, gt, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, projectIdsOf, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { ALREADY_PLACED, alreadyPlaced, containerScope, move, noSuchContainer, OUTSIDE_SUBSCRIPTION, type LifecycleOptions } from "./lifecycle"
import { periodAfter, requireWithin, type Period } from "./periods"
import { requireContainerType, requireServiceFrequency, requireWarehouse, requireWasteFraction, type Scope } from "./references"
import { created, describeCreated, describeJson, IdParam, lockRow, refuseDuplicate, refuseOverlap, stampsOf } from "./shared"
import { refuseUnservedPlace, type Place } from "./statuses"

const MODULE = "resources.containers"
const ContainerPage = Page(Container)
const PlacementPage = Page(ContainerServicePlacement)

const columns = {
  id: container.id,
  projectId: container.projectId,
  label: container.label,
  containerTypeId: container.containerTypeId,
  barcode: container.barcode,
  rfid: container.rfid,
  serialNumber: container.serialNumber,
  ownership: container.ownership,
  notes: container.notes,
  createdAt: container.createdAt,
  updatedAt: container.updatedAt,
}

/** The ledger's reading beside the container's own columns: its latest movement, nulls for a container with none. */
const stateColumns = (state: ReturnType<typeof assetStateOf>) => ({
  stateStatus: assetStatus(state.toKind),
  stateWarehouseId: state.toWarehouseId,
  statePlacementId: state.placementId,
  stateSince: state.occurredAt,
  stateMovementId: state.movementId,
})

/** The container's columns and the projection's, as the one statement below selects them; the projection's are null on a LATERAL left join that found no movement. */
type Row = Pick<typeof container.$inferSelect, keyof typeof columns> & {
  stateStatus: AssetStatus | null
  stateWarehouseId: string | null
  statePlacementId: string | null
  stateSince: Date | null
  stateMovementId: string | null
}

/**
 * The one statement every container is read through: the row with the
 * ledger's reading joined LATERAL — one probe per row for the container's
 * latest movement (`assetStateOf`) — so a page, a single read and the answer
 * to a write all say the same thing about where a container is. The
 * subquery is handed back beside the query for a filter over it.
 */
function containersFrom(tx: Tx, companyId: string) {
  const state = assetStateOf(tx, companyId, container.id)
  return { state, query: tx.select({ ...columns, ...stateColumns(state) }).from(container).leftJoinLateral(state, sql`true`) }
}

/** The reading as the wire spells it: null with no movement, else where the latest one left the container. */
function assetStateOfRow(row: Row): AssetState | null {
  if (row.stateMovementId === null) return null
  if (row.stateStatus === null || row.stateSince === null) {
    // A movement is NOT NULL on `occurred_at`, and the kind check keeps every arrival at a place with a state: a null beside a movement is a broken invariant, not a client's doing.
    throw new Error(`stock_movement ${row.stateMovementId} has no ${row.stateStatus === null ? "asset state" : "occurred_at"} to answer`)
  }
  return { status: row.stateStatus, warehouseId: row.stateWarehouseId, placementId: row.statePlacementId, since: row.stateSince.toISOString(), movementId: row.stateMovementId }
}

/** The reading a container has before any movement: what a create answers, since a row just made has none by construction. */
const NO_STATE = { stateStatus: null, stateWarehouseId: null, statePlacementId: null, stateSince: null, stateMovementId: null }

/** The row on the wire. `ownership` is text with a CHECK in the database and an enum here; the vocabulary holds the two in lockstep. */
function containerOf(row: Row): Container {
  return {
    id: row.id,
    projectId: row.projectId,
    label: row.label,
    containerTypeId: row.containerTypeId,
    barcode: row.barcode,
    rfid: row.rfid,
    serialNumber: row.serialNumber,
    ownership: row.ownership as ContainerOwnership,
    notes: row.notes,
    assetState: assetStateOfRow(row),
    ...stampsOf(row),
  }
}


/**
 * The placement as the wire spells it, the last field computed rather than
 * stored: the placement's cadence where it overrides, the product's
 * otherwise. Every read and every write answer goes through this selection,
 * so an override that is taken off is the product's cadence again on the very
 * next read and nothing has to be rewritten when a product changes.
 */
const placementColumns = {
  id: containerServicePlacement.id,
  projectId: containerServicePlacement.projectId,
  containerId: containerServicePlacement.containerId,
  subscriptionId: containerServicePlacement.subscriptionId,
  wasteFractionId: containerServicePlacement.wasteFractionId,
  serviceFrequencyId: containerServicePlacement.serviceFrequencyId,
  effectiveServiceFrequencyId: sql<string | null>`coalesce(${containerServicePlacement.serviceFrequencyId}, ${product.serviceFrequencyId})`,
  validFrom: containerServicePlacement.validFrom,
  validTo: containerServicePlacement.validTo,
  createdAt: containerServicePlacement.createdAt,
  updatedAt: containerServicePlacement.updatedAt,
}

/** The stored columns of the selection above, plus the one it computes. */
type PlacementRow = Pick<
  typeof containerServicePlacement.$inferSelect,
  Exclude<keyof typeof placementColumns, "effectiveServiceFrequencyId">
> & { effectiveServiceFrequencyId: string | null }

function placementOf(row: PlacementRow): ContainerServicePlacement {
  return {
    id: row.id,
    projectId: row.projectId,
    containerId: row.containerId,
    subscriptionId: row.subscriptionId,
    wasteFractionId: row.wasteFractionId,
    serviceFrequencyId: row.serviceFrequencyId,
    effectiveServiceFrequencyId: row.effectiveServiceFrequencyId,
    validFrom: row.validFrom,
    validTo: row.validTo,
    ...stampsOf(row),
  }
}

/** `unique (company_id, label)`: a label is read off a bin anywhere in the company, so it is the company's and not a project's. */
const LABEL_TAKEN = "container_label_key"
const labelTaken = (label: string) => `This company already has a container labelled ${label}`

/** What a body is told when it names a subscription of another project; the composite key holds it to the same thing. */
const NOT_A_SUBSCRIPTION = "Not a subscription of this container's project"

/**
 * A placement starts inside the subscription's period: on or after its first
 * day and before its first day out, refused at `validFrom` with the sentence
 * every bound outside the subscription earns. The end is not judged here,
 * since a create has none — the ledger sets it, and holds it inside the
 * period then (routes/lifecycle.ts, `endPlacement`).
 */
function requireStartsWithin(served: Period, validFrom: string): void {
  if (validFrom < served.validFrom || (served.validTo !== null && validFrom >= served.validTo)) {
    throw invalidRequest("body", [{ path: "validFrom", message: OUTSIDE_SUBSCRIPTION }])
  }
}

// The patch's rule since the ledger (Issue #101): a placement is ended by a
// command, never by a form, and the ledger's word on when the container left
// is not taken back by one either — the contracts' `validTo` takes no null,
// so that half is the schema's 400 and the route holds only the other.

/** What a patch setting an end on an open placement is told. */
export const END_BY_COMMAND = "End this placement by returning or decommissioning the container"

const noSuchPlacement = (id: string) =>
  problem(404, { detail: `No container service placement ${id} in the projects this account works in` })

/** The rows of this company, in the projects the caller works in: what every container statement is bounded by (spelled in lifecycle.ts, which the ledger's routes read too). */
const scope = containerScope

/** The same for a placement, which carries the project its container is in. */
const placementScope = (principal: Principal) =>
  and(eq(containerServicePlacement.companyId, principal.companyId), inProjects(containerServicePlacement.projectId, principal))

/** One container of this company by id, inside the caller's projects, with the ledger's reading; undefined when it is neither. */
async function findContainer(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await containersFrom(tx, principal.companyId)
    .query.where(and(scope(principal), eq(container.id, id)))
    .limit(1)
  return row
}

/** The row a patch just changed, read back through the one statement, so the answer carries the reading the next read will; a create needs none, since a new container has no movement. */
async function readBack(tx: Tx, principal: Principal, id: string): Promise<Row> {
  const row = await findContainer(tx, principal, id)
  if (row === undefined) throw new Error(`container ${id} was written and is not there to read back`)
  return row
}

/**
 * The one statement every placement is read through, and the three joins it
 * takes: the subscription because a place and a period hang off it, the
 * product because the cadence in force coalesces onto its, and the container
 * because the sentence a refused overlap answers names its label. Each join
 * carries `company_id` beside the key, the way every statement of this API
 * does (ADR-0001).
 *
 * A page selects the same columns a single read does and drops the last two
 * on the way to the wire: one selection means what a page says and what a
 * read says cannot drift, and the two extra values are a join on a primary
 * key either way.
 */
function placementsFrom(tx: Tx, companyId: string) {
  return tx
    .select({
      ...placementColumns,
      label: container.label,
      subscriptionValidFrom: subscription.validFrom,
      subscriptionValidTo: subscription.validTo,
    })
    .from(containerServicePlacement)
    .innerJoin(
      subscription,
      and(eq(subscription.companyId, companyId), eq(subscription.id, containerServicePlacement.subscriptionId)),
    )
    .innerJoin(product, and(eq(product.companyId, companyId), eq(product.id, subscription.productId)))
    .innerJoin(container, and(eq(container.companyId, companyId), eq(container.id, containerServicePlacement.containerId)))
}

/** The period a placement of this row has to lie inside, as the row carries it. */
const servedPeriod = (row: { subscriptionValidFrom: string; subscriptionValidTo: string | null }): Period => ({
  validFrom: row.subscriptionValidFrom,
  validTo: row.subscriptionValidTo,
})

/**
 * One placement, with the two things a write of it is held against: the
 * container's label, which the overlap sentence names, and the period of the
 * subscription it serves. Both come off the statement above, so a patch costs
 * one round trip and not three.
 */
async function findPlacement(tx: Tx, principal: Principal, id: string) {
  const [row] = await placementsFrom(tx, principal.companyId)
    .where(and(placementScope(principal), eq(containerServicePlacement.id, id)))
    .limit(1)
  return row
}

/**
 * The subscription a placement names, held to the container's project and
 * answered with its period and the state of its place: the containment check
 * needs the period and the status gate (routes/statuses.ts) needs the place,
 * so the lookup that proves the subscription is there is the one that fetches
 * both, rather than `requireRow` and then two more statements. The place is
 * reached through the subscription, as ADR-0003 has it, so its two tables are
 * joined here and not named by the body; each join carries `company_id`. The
 * two statuses are text the columns' checks hold to the vocabulary, read as
 * the statuses they are.
 */
async function findServedSubscription(tx: Tx, within: Scope, id: string): Promise<Period & Place> {
  const [row] = await tx
    .select({
      validFrom: subscription.validFrom,
      validTo: subscription.validTo,
      propertyStatus: property.status,
      sharedCollectionPointStatus: sharedCollectionPoint.status,
    })
    .from(subscription)
    .leftJoin(property, and(eq(property.companyId, within.companyId), eq(property.id, subscription.propertyId)))
    .leftJoin(
      sharedCollectionPoint,
      and(eq(sharedCollectionPoint.companyId, within.companyId), eq(sharedCollectionPoint.id, subscription.sharedCollectionPointId)),
    )
    .where(and(eq(subscription.companyId, within.companyId), eq(subscription.projectId, within.projectId), eq(subscription.id, id)))
    .limit(1)
  if (row === undefined) throw invalidRequest("body", [{ path: "subscriptionId", message: NOT_A_SUBSCRIPTION }])
  return row as Period & Place
}

export function containerRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: LifecycleOptions = {}) {
  return new Hono<AuthEnv>()
    .get(
      "/containers",
      describeRoute({
        operationId: "listContainers",
        summary: "The containers the caller's projects hold",
        description:
          "One page of containers, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused, and `containerTypeId` narrows it to one type. Each container carries `assetState`, the ledger's reading — its latest Stock Movement folded onto in-warehouse, in-service, in-maintenance or retired, null for a container with no movement yet — and `assetStatus` narrows the page to one state, `warehouseId` to the containers standing in that warehouse, in stock or in maintenance; a warehouse outside the project named, or the projects this account works in, is refused. Where a container serves is the placement valid on the day asked, `GET /placements`. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of containers, each with the ledger's reading.", ContainerPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, `projectId` is not a project this account works in, or `warehouseId` is not a warehouse of one."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `resources.containers`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", ContainerListQuery),
      async (c) => {
        const { limit, cursor, projectId, containerTypeId, assetStatus: status, warehouseId } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        // The warehouse asked about is one the caller may see: the project named, or any the caller works in.
        if (warehouseId !== undefined) await requireWarehouse(tx, { companyId: principal.companyId, projectId: projectId ?? projectIdsOf(principal) }, warehouseId, "warehouseId", "query")
        const { state, query } = containersFrom(tx, principal.companyId)
        const rows = await query
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(container.projectId, projectId),
              containerTypeId === undefined ? undefined : eq(container.containerTypeId, containerTypeId),
              // The ledger's reading, filtered in SQL: the status the latest movement folds onto, and the warehouse it arrived at.
              status === undefined ? undefined : eq(assetStatus(state.toKind), status),
              warehouseId === undefined ? undefined : eq(state.toWarehouseId, warehouseId),
              after === undefined ? undefined : gt(container.id, after),
            ),
          )
          .orderBy(asc(container.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(containerOf), limit))
      },
    )
    .post(
      "/containers",
      describeRoute({
        operationId: "createContainer",
        summary: "Register a container",
        description:
          "Registers a container in one project, which must be a project the caller works in. The label is the visible Container ID a person reads off the bin and is unique across the company, not inside a project. The container type is this company's. The ownership defaults to `company`. There is no status and no location of its own: `assetState` is the ledger's reading and is null until a movement is recorded, and where it serves is `POST /containers/{id}/placements`. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The container as it was written, with no asset state yet.", Container),
          400: describeProblem(
            "The body is missing a field, names a member the server owns, names a project this account does not work in, or names a container type that is not this company's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `resources.containers`."),
          409: describeProblem("The company already has a container with that label."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("json", ContainerCreate),
      async (c) => {
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        requireProject(principal, values.projectId)
        await requireContainerType(tx, principal.companyId, values.containerTypeId)
        const [row] = await refuseDuplicate({ [LABEL_TAKEN]: labelTaken(values.label) }, () =>
          tx
            .insert(container)
            .values({ ...values, id: newId(), companyId: principal.companyId })
            .returning(columns),
        )
        // A container just registered has no movement, so its state is null by construction and needs no probe.
        return created(c, "/containers", containerOf({ ...row, ...NO_STATE }))
      },
    )
    .get(
      "/containers/:id",
      describeRoute({
        operationId: "getContainer",
        summary: "One container",
        description:
          "One container of a project the caller works in, with `assetState`, the ledger's reading: where its latest Stock Movement left it, null with no movement yet. A container of another company, or of a project this account does not work in, is a container that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The container, with the ledger's reading.", Container),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `resources.containers`."),
          404: describeProblem("No container with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findContainer(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchContainer(id)
        return c.json(containerOf(row))
      },
    )
    .patch(
      "/containers/:id",
      describeRoute({
        operationId: "patchContainer",
        summary: "Correct a container",
        description:
          "Corrects one container of a project the caller works in; every field is optional and at least one must be given. A null clears the barcode, the RFID, the serial number or the note. The project is not patchable, since a record does not move between projects, and where the container stands is a placement and not a field.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The container as it now stands.", Container),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (the project included), or names a container type that is not this company's.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `resources.containers`."),
          404: describeProblem("No container with that id in the projects this account works in."),
          409: describeProblem("The company already has another container with that label."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ContainerPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        // The row first, then what the patch points at: an id nobody minted
        // is a 404 here as in every other family, and not a 400 about a type
        // that was never going to be written.
        if ((await findContainer(tx, principal, id)) === undefined) throw noSuchContainer(id)
        await requireContainerType(tx, principal.companyId, patch.containerTypeId)

        const sentences: Record<string, string> = patch.label === undefined ? {} : { [LABEL_TAKEN]: labelTaken(patch.label) }
        const [row] = await refuseDuplicate(sentences, () =>
          tx
            .update(container)
            .set(patch)
            .where(and(scope(principal), eq(container.id, id)))
            .returning({ id: container.id }),
        )
        if (row === undefined) throw noSuchContainer(id)
        return c.json(containerOf(await readBack(tx, principal, row.id)))
      },
    )
    .post(
      "/containers/:id/placements",
      describeRoute({
        operationId: "createPlacement",
        summary: "Issue a container into service",
        description:
          "Puts the container the path names into service under a subscription, which says the agreement, the product and the place it serves. The container says the project, so the body names neither it nor the project, and the subscription must be that project's. The place, read through the subscription, must still serve: a property no longer active, or a point no longer open or restricted, is refused (409) naming the status it has, while the placements already there are ended by their period, since a status gates a new reference and never an existing one. The waste fraction is this company's; the service frequency, where given, is the project's and overrides the product's — leave it out and the cadence in force is the product's, answered as `effectiveServiceFrequencyId`. The placement starts inside the subscription's period (400 on `validFrom`) and carries no end: a placement ends only through `POST /containers/{id}/return` or `/decommission`, which end it on the day they say and append the movement together, so `validTo` on this body is refused by name. The container may not already be placed over part of the period: one container serves in one place at a time. This is the `issue` command of the Stock Movement ledger and the only door into service: the container must be in a warehouse or in maintenance — one with no stock record (receive it first), one in service at another placement (return it first) or one retired is refused (409 naming the state), though a body that names nothing real is a 400 whatever the state — and the placement and the `issue` movement from the warehouse it stood in are written in one transaction, both or neither. `occurredAt` is when it was issued, the request's clock when absent and at most five minutes ahead of it (400), and `reference` the paper it quotes; both are the movement's, read through `GET /containers/{id}/movements`. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeCreated("The placement as it was written, open, with the cadence in force; the issue movement is on the container's ledger.", ContainerServicePlacement),
          400: describeProblem(
            "The path does not hold an id, or the body is missing a field, names a member the server owns (`validTo` included: a placement ends through the ledger's commands), starts outside the subscription's period, names a subscription, waste fraction or service frequency outside the scope its key allows, or dates the issue more than five minutes after the request.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `resources.containers`."),
          404: describeProblem("No container with that id in the projects this account works in."),
          409: describeProblem("The container is not in stock — no record, in service at another placement, or retired — is already placed over part of that period, or the subscription's place no longer serves: a property not active, or a point not open or restricted."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", ContainerServicePlacementCreate),
      async (c) => {
        const { id } = c.req.valid("param")
        const { occurredAt, reference, ...values } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        const into = await findContainer(tx, principal, id)
        if (into === undefined) throw noSuchContainer(id)
        const within = { companyId: principal.companyId, projectId: into.projectId }
        // What the body names, held before the ledger is consulted: a body
        // that names nothing real, or starts outside the subscription's
        // period, is refused whatever the container's state. The period is
        // read again and held again under the subscription's lock inside
        // `open`; this unlocked check is the cheap one that answers first.
        const served = await findServedSubscription(tx, within, values.subscriptionId)
        await requireWasteFraction(tx, principal.companyId, values.wasteFractionId)
        await requireServiceFrequency(tx, within, values.serviceFrequencyId)
        requireStartsWithin(served, values.validFrom)

        const movement = await move(tx, principal, into, {
          kind: "issue",
          // The Registry half, run once the container is locked and its state
          // allows: the subscription locked (after the container's, top
          // down), its period and its place's state read again underneath,
          // the start held inside the period and the place held to still
          // serve, then the placement written, open.
          open: async () => {
            await lockRow(tx, subscription, { companyId: principal.companyId, id: values.subscriptionId })
            const served = await findServedSubscription(tx, within, values.subscriptionId)
            requireStartsWithin(served, values.validFrom)
            // Every 400 above, every 409 below (routes/statuses.ts).
            refuseUnservedPlace(served, "placement")
            const [written] = await refuseOverlap({ [ALREADY_PLACED]: alreadyPlaced(into.label) }, () =>
              tx
                .insert(containerServicePlacement)
                .values({
                  ...values,
                  id: newId(),
                  companyId: principal.companyId,
                  projectId: into.projectId,
                  containerId: into.id,
                })
                .returning({ id: containerServicePlacement.id }),
            )
            return written.id
          },
          ...(occurredAt === undefined ? {} : { occurredAt }),
          ...(reference === undefined ? {} : { reference }),
          at: now(),
        })
        // An issue arrives at the placement `open` wrote, so the movement names it; a row that does not is a broken invariant, not a client's doing.
        if (movement.placementId === null) throw new Error(`the issue movement ${movement.id} of container ${into.id} names no placement`)
        // Read back through the one select every placement is answered from,
        // since the cadence in force is a join and not a column.
        const row = await findPlacement(tx, principal, movement.placementId)
        if (row === undefined) throw noSuchPlacement(movement.placementId)
        return created(c, "/placements", placementOf(row))
      },
    )
    .get(
      "/placements",
      describeRoute({
        operationId: "listPlacements",
        summary: "Where containers are in service",
        description:
          "One page of container service placements, oldest first (ids are time-ordered), from the projects the caller works in. `containerId` answers one container's service history and `subscriptionId` one subscription's containers. `propertyId` and `sharedCollectionPointId` answer what stands at a place, which is reached through the subscription and is only answerable for a day, so either takes `validOn` with it. `validOn` on its own answers the placements in force that day, `validFrom` inclusive and `validTo` exclusive — a container between two placements is in neither. Every item carries `effectiveServiceFrequencyId`, the placement's cadence where it overrides and the product's otherwise. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of placements, each with the cadence in force.", PlacementPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, a place was asked for without a day, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `resources.containers`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", PlacementListQuery),
      async (c) => {
        const { limit, cursor, projectId, containerId, subscriptionId, propertyId, sharedCollectionPointId, validOn: day } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await placementsFrom(c.get("tx"), principal.companyId)
          .where(
            and(
              placementScope(principal),
              projectId === undefined ? undefined : eq(containerServicePlacement.projectId, projectId),
              containerId === undefined ? undefined : eq(containerServicePlacement.containerId, containerId),
              subscriptionId === undefined ? undefined : eq(containerServicePlacement.subscriptionId, subscriptionId),
              propertyId === undefined ? undefined : eq(subscription.propertyId, propertyId),
              sharedCollectionPointId === undefined ? undefined : eq(subscription.sharedCollectionPointId, sharedCollectionPointId),
              day === undefined ? undefined : validOn(containerServicePlacement, day),
              after === undefined ? undefined : gt(containerServicePlacement.id, after),
            ),
          )
          .orderBy(asc(containerServicePlacement.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(placementOf), limit))
      },
    )
    .get(
      "/placements/:id",
      describeRoute({
        operationId: "getPlacement",
        summary: "One placement",
        description:
          "One container service placement of a project the caller works in, with `effectiveServiceFrequencyId`: the placement's cadence where it overrides, the product's otherwise, read on every request and never stored. A placement of another company, or of a project this account does not work in, is a placement that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The placement, with the cadence in force.", ContainerServicePlacement),
          400: describeProblem("The path does not hold an id."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `resources.containers`."),
          404: describeProblem("No placement with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      async (c) => {
        const { id } = c.req.valid("param")
        const row = await findPlacement(c.get("tx"), c.get("principal"), id)
        if (row === undefined) throw noSuchPlacement(id)
        return c.json(placementOf(row))
      },
    )
    .patch(
      "/placements/:id",
      describeRoute({
        operationId: "patchPlacement",
        summary: "Correct a placement",
        description:
          "Corrects the fraction a placement takes, changes the cadence override (a null takes the override off again), or corrects the end of a placement that already has one. `validFrom` and the subscription do not change: a placement that starts on another day or serves another subscription is another placement. Nor does the patch end an open placement or reopen an ended one: the container leaves service through `POST /containers/{id}/return` or `/decommission`, which end the placement and append the movement together, so a `validTo` on an open placement is refused (409), and `validTo` takes no null (400): the ledger says when the container left, and a form does not take that back. A corrected end is held to three rules — it still comes after the start, it still lies inside the subscription's period (400 naming the bound), and it may not run the placement into the next one, since a container serves in one place at a time.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The placement as it now stands, with the cadence in force.", ContainerServicePlacement),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (`validFrom` and the subscription included), gives `validTo` as null, ends on or before the day it starts, falls outside the subscription's period, or names a waste fraction or service frequency outside the scope its key allows.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `resources.containers`."),
          404: describeProblem("No placement with that id in the projects this account works in."),
          409: describeProblem("The patch would end an open placement, which the ledger's commands do, or the container is already placed over part of that period."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", ContainerServicePlacementPatch),
      async (c) => {
        const { id } = c.req.valid("param")
        const patch = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        let current = await findPlacement(tx, principal, id)
        if (current === undefined) throw noSuchPlacement(id)
        const within = { companyId: principal.companyId, projectId: current.projectId }
        await requireWasteFraction(tx, principal.companyId, patch.wasteFractionId)
        await requireServiceFrequency(tx, within, patch.serviceFrequencyId)

        if (patch.validTo !== undefined) {
          // The subscription this placement is held inside, locked and then
          // read again underneath the lock: the read above only said which
          // subscription to lock.
          await lockRow(tx, subscription, { companyId: principal.companyId, id: current.subscriptionId })
          current = await findPlacement(tx, principal, id)
          if (current === undefined) throw noSuchPlacement(id)
          // The end is the ledger's to set and to keep: a form corrects a
          // day the container already left on, and nothing else (a null,
          // which would take the end off, never reaches here: the contracts
          // refuse it).
          if (current.validTo === null) throw problem(409, { detail: END_BY_COMMAND })
          requireWithin(servedPeriod(current), periodAfter(current, patch), OUTSIDE_SUBSCRIPTION)
        }

        const [written] = await refuseOverlap({ [ALREADY_PLACED]: alreadyPlaced(current.label) }, () =>
          tx
            .update(containerServicePlacement)
            .set(patch)
            .where(and(placementScope(principal), eq(containerServicePlacement.id, id)))
            .returning({ id: containerServicePlacement.id }),
        )
        if (written === undefined) throw noSuchPlacement(id)
        const row = await findPlacement(tx, principal, id)
        if (row === undefined) throw noSuchPlacement(id)
        return c.json(placementOf(row))
      },
    )
}
