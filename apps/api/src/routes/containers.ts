// The Container and where it serves (Issue #78, ADR-0003).
// `GET /containers` lists them, `POST /containers` registers one,
// `GET`/`PATCH /containers/:id` read and correct one,
// `POST /containers/:id/placements` puts one into service, and
// `GET /placements`, `GET`/`PATCH /placements/:id` answer and end the service
// itself. No delete: a container that has been collected from is behind
// pickups and tickets, and taking one out of service is ending its placement.
//
// A Container carries no status and no location. An editable asset state is
// the option ADR-0003 rejected: whether a container is in stock, issued,
// broken or retired is Resources' projection over the Stock Movement ledger,
// and where it is, is the placement valid on the day asked. What is here is
// the identity a person reads off the bin — the label, the type, the barcode,
// the RFID, the serial number, who owns it and a note — and the label is
// unique across the company and not inside a project, because that is how it
// is read off a bin.
//
// A placement names the subscription, and through it the agreement, the
// product and the place: ADR-0003 has a placement name all four, and one
// reference that cannot disagree with itself is better than four that can.
// The container is the path's and the project is the container's, so the body
// names neither. `POST /containers/:id/placements` is the seam the "issue
// into service" command grows into when the ledger arrives.
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
import { validOn } from "@waste/db/query/valid-on"
import { subscription } from "@waste/db/schema/agreements"
import { product } from "@waste/db/schema/catalogue"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { and, asc, eq, gt, sql } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { periodAfter, periodOf, requireWithin, type Period } from "./periods"
import { requireContainerType, requireServiceFrequency, requireWasteFraction } from "./references"
import { describeJson, IdParam, refuseDuplicate, refuseOverlap, stampsOf } from "./shared"

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

type Row = Pick<typeof container.$inferSelect, keyof typeof columns>

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

/** `EXCLUDE USING gist (company_id, container_id, daterange)`: a container serves in one place at a time. */
const ALREADY_PLACED = "container_service_placement_no_overlap"
const alreadyPlaced = (label: string) => `Container ${label} is already placed over part of that period; end that placement first`

/** What a bound outside the subscription's period is told, on the create and on the patch alike. */
const OUTSIDE_SUBSCRIPTION = "Outside the subscription's period"

/** What a body is told when it names a subscription of another project; the composite key holds it to the same thing. */
const NOT_A_SUBSCRIPTION = "Not a subscription of this container's project"

const noSuchContainer = (id: string) => problem(404, { detail: `No container ${id} in the projects this account works in` })
const noSuchPlacement = (id: string) =>
  problem(404, { detail: `No container service placement ${id} in the projects this account works in` })

/** The rows of this company, in the projects the caller works in: what every container statement is bounded by. */
const scope = (principal: Principal) => and(eq(container.companyId, principal.companyId), inProjects(container.projectId, principal))

/** The same for a placement, which carries the project its container is in. */
const placementScope = (principal: Principal) =>
  and(eq(containerServicePlacement.companyId, principal.companyId), inProjects(containerServicePlacement.projectId, principal))

/** One container of this company by id, inside the caller's projects; undefined when it is neither. */
async function findContainer(tx: Tx, principal: Principal, id: string): Promise<Row | undefined> {
  const [row] = await tx
    .select(columns)
    .from(container)
    .where(and(scope(principal), eq(container.id, id)))
    .limit(1)
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
 * answered with its period: the containment check needs the period, so the
 * lookup that proves the subscription is there is the one that fetches it,
 * rather than `requireRow` and then a second statement for the days.
 */
async function findSubscriptionPeriod(tx: Tx, within: { companyId: string; projectId: string }, id: string): Promise<Period> {
  const [row] = await tx
    .select({ validFrom: subscription.validFrom, validTo: subscription.validTo })
    .from(subscription)
    .where(and(eq(subscription.companyId, within.companyId), eq(subscription.projectId, within.projectId), eq(subscription.id, id)))
    .limit(1)
  if (row === undefined) throw invalidRequest("body", [{ path: "subscriptionId", message: NOT_A_SUBSCRIPTION }])
  return row
}

export function containerRoutes(guard: MiddlewareHandler<AuthEnv>) {
  return new Hono<AuthEnv>()
    .get(
      "/containers",
      describeRoute({
        operationId: "listContainers",
        summary: "The containers the caller's projects hold",
        description:
          "One page of containers, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused, and `containerTypeId` narrows it to one type. Where a container stands is not here: that is the placement valid on the day asked, `GET /placements`. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of containers.", ContainerPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, or `projectId` is not a project this account works in."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `resources.containers`."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("query", ContainerListQuery),
      async (c) => {
        const { limit, cursor, projectId, containerTypeId } = c.req.valid("query")
        const after = afterCursor(cursor)
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        const rows = await c
          .get("tx")
          .select(columns)
          .from(container)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(container.projectId, projectId),
              containerTypeId === undefined ? undefined : eq(container.containerTypeId, containerTypeId),
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
          "Registers a container in one project, which must be a project the caller works in. The label is the visible Container ID a person reads off the bin and is unique across the company, not inside a project. The container type is this company's. The ownership defaults to `company`. There is no status and no location: whether a container is in stock, issued or broken is Resources' ledger, and where it is, is `POST /containers/{id}/placements`. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The container as it was written.", Container),
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
        return c.json(containerOf(row), 201)
      },
    )
    .get(
      "/containers/:id",
      describeRoute({
        operationId: "getContainer",
        summary: "One container",
        description:
          "One container of a project the caller works in. A container of another company, or of a project this account does not work in, is a container that does not exist here.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The container.", Container),
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
        await requireContainerType(tx, principal.companyId, patch.containerTypeId)
        const sentences: Record<string, string> = patch.label === undefined ? {} : { [LABEL_TAKEN]: labelTaken(patch.label) }
        const [row] = await refuseDuplicate(sentences, () =>
          tx
            .update(container)
            .set(patch)
            .where(and(scope(principal), eq(container.id, id)))
            .returning(columns),
        )
        if (row === undefined) throw noSuchContainer(id)
        return c.json(containerOf(row))
      },
    )
    .post(
      "/containers/:id/placements",
      describeRoute({
        operationId: "createPlacement",
        summary: "Put a container into service",
        description:
          "Puts the container the path names into service under a subscription, which says the agreement, the product and the place it serves. The container says the project, so the body names neither it nor the project, and the subscription must be that project's. The waste fraction is this company's; the service frequency, where given, is the project's and overrides the product's — leave it out and the cadence in force is the product's, answered as `effectiveServiceFrequencyId`. The period lies inside the subscription's, naming the bound that does not, and the container may not already be placed over part of it: one container serves in one place at a time. The server mints the id.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The placement as it was written, with the cadence in force.", ContainerServicePlacement),
          400: describeProblem(
            "The path does not hold an id, or the body is missing a field, names a member the server owns, ends on or before the day it starts, falls outside the subscription's period, or names a subscription, waste fraction or service frequency outside the scope its key allows.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `create` on `resources.containers`."),
          404: describeProblem("No container with that id in the projects this account works in."),
          409: describeProblem("The container is already placed over part of that period."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", ContainerServicePlacementCreate),
      async (c) => {
        const { id } = c.req.valid("param")
        const values = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")

        const into = await findContainer(tx, principal, id)
        if (into === undefined) throw noSuchContainer(id)
        const within = { companyId: principal.companyId, projectId: into.projectId }
        const served = await findSubscriptionPeriod(tx, within, values.subscriptionId)
        await requireWasteFraction(tx, principal.companyId, values.wasteFractionId)
        await requireServiceFrequency(tx, within, values.serviceFrequencyId)
        requireWithin(served, periodOf(values), OUTSIDE_SUBSCRIPTION)

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
        // Read back through the one select every placement is answered from,
        // since the cadence in force is a join and not a column.
        const row = await findPlacement(tx, principal, written.id)
        if (row === undefined) throw noSuchPlacement(written.id)
        return c.json(placementOf(row), 201)
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
        summary: "End or correct a placement",
        description:
          "Ends a placement by giving it a `validTo`, corrects the fraction it takes, or changes the cadence override; a null takes the end or the override off again. `validFrom` and the subscription do not change: a placement that starts on another day or serves another subscription is another placement. A new end is held to three rules — it still comes after the start, it still lies inside the subscription's period (400 naming the bound), and it may not run the placement into the next one, since a container serves in one place at a time.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("The placement as it now stands, with the cadence in force.", ContainerServicePlacement),
          400: describeProblem(
            "The path does not hold an id, or the patch is empty, names a field the caller does not own (`validFrom` and the subscription included), ends on or before the day it starts, falls outside the subscription's period, or names a waste fraction or service frequency outside the scope its key allows.",
          ),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `edit` on `resources.containers`."),
          404: describeProblem("No placement with that id in the projects this account works in."),
          409: describeProblem("The container is already placed over part of that period."),
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

        const current = await findPlacement(tx, principal, id)
        if (current === undefined) throw noSuchPlacement(id)
        const within = { companyId: principal.companyId, projectId: current.projectId }
        await requireWasteFraction(tx, principal.companyId, patch.wasteFractionId)
        await requireServiceFrequency(tx, within, patch.serviceFrequencyId)
        if (patch.validTo !== undefined) requireWithin(servedPeriod(current), periodAfter(current, patch), OUTSIDE_SUBSCRIPTION)

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
