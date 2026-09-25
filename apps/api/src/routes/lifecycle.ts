// The container's lifecycle as commands (Issue #101, ADR-0003): the Stock
// Movement ledger's writes, the two reads over it, and the seam into the
// Registry. A container is received from a supplier into a warehouse, issued
// into service (which is `POST /containers/:id/placements`, the Registry's
// route in containers.ts — one action, one command), returned into stock or
// into maintenance, transferred between the two, decommissioned to scrap, or
// adjusted when the ledger is wrong. Each command appends one row and, where
// the container enters or leaves service, writes or ends the Registry's
// placement in the same transaction. Either both change or neither.
//
// `move` is the one function the six commands call. The order inside it is
// the rule the ledger holds — a container is in one place at a time and every
// movement leaves from where the container is — and it holds it under the
// container's row lock:
//
//   lock        — `lockRow(container)` before anything is read, so two
//                 commands on one container take turns and the chain never
//                 forks: the second sees what the first wrote and is refused
//                 by it. The container's lock comes before the subscription's
//                 (return, decommission and the issue all take both), top
//                 down, so no two requests hold half of each other's pair
//                 (routes/shared.ts);
//   read        — the container's reading, its latest movement in recording
//                 order (@waste/db/query/asset-state says why not
//                 `occurred_at`), read for this one container and folded onto
//                 the glossary's state by the domain;
//   departure   — the state rule of the command, a 409 with the container's
//                 label and a sentence per state spelled once below: a
//                 receipt wants no record, an issue and a transfer want stock,
//                 a return wants service, a decommission wants a record that
//                 is not scrap, an adjustment wants anything but service.
//                 Where the intent passes, the movement's `from` is where the
//                 reading says the container is (a supplier when there is
//                 none);
//   arrival     — what the body named, held to the container's project
//                 (`requireWarehouse`, 400 on the field), and the Registry
//                 half where service opens or ends: the issue's placement is
//                 written by the route that owns those statements
//                 (containers.ts, handed in as `open`), and a return's or a
//                 decommission's placement is ended here by `endPlacement`,
//                 under the subscription's lock and inside its period, with
//                 the sentences the placement patch answers;
//   append      — the row, `id: newId()`, `recordedBy` the caller's account,
//                 `occurredAt` the body's or the request's clock. The row is
//                 held to its two rules where it is whole: the shape
//                 (`movementShape`, the domain's table of pairs each kind
//                 allows, a 400 on the field the intent carried its `to` in,
//                 one door before the database's `stock_movement_kind_shape`
//                 would answer a code) and the clock (a movement recorded
//                 before it happened is refused, 400 on `occurredAt`). That
//                 is after the Registry half — the row is not whole before the
//                 placement it names exists — so a refused row leaves no
//                 placement behind either, the transaction being the
//                 request's, and that is the proof the suite runs. Nothing is
//                 read back from the projection: the row just written is, by
//                 construction, the latest.
//
// Postgres's shape checks (23514) are the backstop and, unnamed, a 500 — the
// signal that a sentence is missing here. The exclusion constraint on the
// placement (23P01) still answers behind the state rule, and answers a race
// the lock lets through only in theory: two issues of one container serialise
// on the lock and the second reads the first's service.
//
// The reads: `GET /containers/:id/movements` is one container's ledger and
// `GET /stock-movements` the ledger across containers, both oldest first — a
// cursor over `id` is a cursor over recording order, the one rule every list
// of this API pages by (pagination.ts), and a ledger read newest first would
// be the one list paging the other way. The cross-container list is
// `resources.inventory`'s: what stands where and what moved is the
// inventory's question, while a command on a container is
// `resources.containers`'.
//
// This module cannot import containers.ts, which imports `move`, so the two
// things both need of a container — its scope and its 404 — are spelled here
// and read from there: `containerScope`, `noSuchContainer`, and the two
// sentences a placement's end can earn, `OUTSIDE_SUBSCRIPTION` and
// `alreadyPlaced`, since a return ends one here and the patch corrects one
// there. A warehouse a body or a query names is `requireWarehouse` in
// routes/references.ts, the containers list's helper too.
import { Page, PageRequest } from "@waste/contracts/pagination"
import {
  Adjust,
  Decommission,
  Receive,
  Return,
  StockMovement,
  StockMovementListQuery,
  Transfer,
  type AdjustmentTarget,
  type StockPlace,
} from "@waste/contracts/stock"
import type { Tx } from "@waste/db/client"
import { ASSET_STATE_COLUMNS } from "@waste/db/query/asset-state"
import { subscription } from "@waste/db/schema/agreements"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { warehouse } from "@waste/db/schema/places"
import { stockMovement } from "@waste/db/schema/stock"
import { assetStateOf as stateAfter, movementShape } from "@waste/domain/resources/asset-state"
import type { AssetStatus, StockMovementKind, StockPlaceKind } from "@waste/domain/resources/vocabulary"
import { and, asc, desc, eq, gt, gte, lte, or } from "drizzle-orm"
import { Hono, type MiddlewareHandler } from "hono"
import { describeRoute } from "hono-openapi"

import { BEARER_SECURITY, type AuthEnv, type Principal } from "../auth/principal"
import { inProjects, projectIdsOf, requireProject } from "../auth/projects"
import { requireGrant } from "../auth/require"
import { newId } from "../ids"
import { afterCursor, fetchLimit, pageOf } from "../pagination"
import { describeProblem, invalidRequest, problem, validate } from "../problem"
import { requireWithin } from "./periods"
import { requireWarehouse } from "./references"
import { describeJson, IdParam, lockRow, refuseOverlap } from "./shared"

const MODULE = "resources.containers"
const INVENTORY = "resources.inventory"
const MovementPage = Page(StockMovement)

/** The container a command moves: what the route found under the caller's scope, and what every sentence below names it by. */
export type ContainerRef = { id: string; projectId: string; label: string }

/** The rows of this company, in the projects the caller works in: what every container statement is bounded by, here and in containers.ts. */
export const containerScope = (principal: Principal) => and(eq(container.companyId, principal.companyId), inProjects(container.projectId, principal))

export const noSuchContainer = (id: string) => problem(404, { detail: `No container ${id} in the projects this account works in` })

/** One container of this company by id, inside the caller's projects, as a command names it; undefined when it is neither. */
async function findContainerRef(tx: Tx, principal: Principal, id: string): Promise<ContainerRef | undefined> {
  const [row] = await tx
    .select({ id: container.id, projectId: container.projectId, label: container.label })
    .from(container)
    .where(and(containerScope(principal), eq(container.id, id)))
    .limit(1)
  return row
}

// The two sentences a placement's end can earn, spelled once for the return
// and the decommission here and the patch in containers.ts.

/** What a bound outside the subscription's period is told. */
export const OUTSIDE_SUBSCRIPTION = "Outside the subscription's period"

/** `EXCLUDE USING gist (company_id, container_id, daterange)`: a container serves in one place at a time. */
export const ALREADY_PLACED = "container_service_placement_no_overlap"
export const alreadyPlaced = (label: string) => `Container ${label} is already placed over part of that period; end that placement first`

// The state sentences, one per state a command can be refused by, each naming
// the container as a person reads it off the bin.

const noRecord = (label: string) => `Container ${label} has no stock record; receive it first`
const inService = (label: string) => `Container ${label} is in service; return it first`
const inServiceElsewhere = (label: string) => `Container ${label} is in service at another placement; return it first`
const isRetired = (label: string) => `Container ${label} is retired`
const neverComesBack = (label: string) => `Container ${label} is retired; a scrapped container does not come back — register a new one`
const alreadyInStock = (label: string, warehouseName: string) => `Container ${label} is already in stock (${warehouseName})`
const notInService = (label: string) => `Container ${label} is not in service`
const alreadyRetired = (label: string) => `Container ${label} is already retired`
const noAdjustmentInService = (label: string) =>
  `Container ${label} is in service; return or decommission it, an adjustment does not touch a placement`

// The 400s: a body that says something the ledger cannot take.

/** `occurredAt` later than the request's clock. */
export const RECORDED_AFTER_IT_HAPPENED = "A movement is recorded after it happened"
/** A transfer to the place the container already stands in. */
export const ALREADY_THERE = "Already there"
/** A decommission of a container in service that names no end for its placement. */
export const GIVE_VALID_TO = "The container is in service; give validTo, the first day it no longer serves"
/** A decommission of a container out of service that names one. */
export const VALID_TO_SAYS_NOTHING = "Not in service; validTo says nothing"
/** An adjustment correcting a movement that is not one of this container's. */
export const NOT_A_MOVEMENT_OF_THIS_CONTAINER = "Not a movement of this container"
/** A pair the domain's shape table forbids; the database's `stock_movement_kind_shape` would say 23514. */
const noSuchShape = (kind: StockMovementKind, from: StockPlaceKind, to: StockPlaceKind) => `A ${kind} does not go from ${from} to ${to}`

/** A place a movement leaves from or arrives at: a kind, and the warehouse when the kind is at one. */
type Place = { kind: StockPlaceKind; warehouseId: string | null }

/** A place in stock as a body names it: a warehouse, or maintenance at one. */
export type StockPlaceRef = { kind: StockPlace; warehouseId: string }

const SUPPLIER: Place = { kind: "supplier", warehouseId: null }
const SERVICE: Place = { kind: "service", warehouseId: null }
const SCRAP: Place = { kind: "scrap", warehouseId: null }

/** What every command may say beside its own: when it happened, why, what paper it quotes — and the request's clock, which `occurredAt` defaults to and may not pass. */
type Says = { occurredAt?: string; reason?: string; reference?: string; at: Date }

/**
 * What a command intends. The kind is the route's, the destination is the
 * body's where the body has one, and the Registry half is either handed in
 * (`open`, the issue's placement written by containers.ts and its id
 * answered) or asked for (`validTo`, the day a return or a decommission ends
 * the placement the container is in service at).
 */
export type Intent = Says &
  (
    | { kind: "receipt"; to: StockPlaceRef }
    | { kind: "issue"; open: () => Promise<string> }
    | { kind: "return"; to: StockPlaceRef; validTo: string }
    | { kind: "transfer"; to: StockPlaceRef }
    | { kind: "decommission"; validTo?: string }
    | { kind: "adjustment"; to: { kind: AdjustmentTarget; warehouseId: string | null }; correctsMovementId?: string }
  )

/** The ledger's reading of one container: its latest movement, where that left it, and the state that is. */
type Reading = {
  movementId: string
  toKind: StockPlaceKind
  warehouseId: string | null
  placementId: string | null
  occurredAt: Date
  status: AssetStatus
}

/**
 * Takes the container's row lock and reads where the ledger says it is: the
 * first two steps of every command, in this order, so the reading is the one
 * the command's write will follow. Null for a container with no movement yet.
 */
export async function lockedReading(tx: Tx, principal: Principal, subject: ContainerRef): Promise<Reading | null> {
  await lockRow(tx, container, { companyId: principal.companyId, id: subject.id })
  const [row] = await tx
    .select(ASSET_STATE_COLUMNS)
    .from(stockMovement)
    .where(and(eq(stockMovement.companyId, principal.companyId), eq(stockMovement.containerId, subject.id)))
    .orderBy(desc(stockMovement.id))
    .limit(1)
  if (row === undefined) return null
  const toKind = row.toKind as StockPlaceKind
  const status = stateAfter({ toKind })
  // The kind check keeps every arrival at a place with a state; a row without one is a broken invariant, not a client's doing.
  if (status === null) throw new Error(`stock_movement ${row.movementId} arrived at a place with no asset state`)
  return { movementId: row.movementId, toKind, warehouseId: row.toWarehouseId, placementId: row.placementId, occurredAt: row.occurredAt, status }
}

/** Where the reading says the container stands: the place its latest movement arrived at. */
const placeOf = (reading: Reading): Place => ({ kind: reading.toKind, warehouseId: reading.warehouseId })

/** The name of the warehouse a refusal names, so "already in stock" says where; the id when the row is somehow gone. */
async function warehouseName(tx: Tx, companyId: string, id: string | null): Promise<string> {
  if (id === null) return "in stock"
  const [row] = await tx
    .select({ name: warehouse.name })
    .from(warehouse)
    .where(and(eq(warehouse.companyId, companyId), eq(warehouse.id, id)))
    .limit(1)
  return row?.name ?? id
}

/**
 * The state rule of each command, as a sentence, and where the movement
 * leaves from when the rule passes. The reading is what the container is
 * refused by, so every sentence names its label and the state it is in.
 */
async function departure(tx: Tx, principal: Principal, subject: ContainerRef, reading: Reading | null, intent: Intent): Promise<Place> {
  const { label } = subject
  switch (intent.kind) {
    case "receipt":
      if (reading === null) return SUPPLIER
      if (reading.status === "in-service") throw problem(409, { detail: inService(label) })
      if (reading.status === "retired") throw problem(409, { detail: neverComesBack(label) })
      throw problem(409, { detail: alreadyInStock(label, await warehouseName(tx, principal.companyId, reading.warehouseId)) })
    case "issue":
    case "transfer":
      if (reading === null) throw problem(409, { detail: noRecord(label) })
      if (reading.status === "in-service") throw problem(409, { detail: intent.kind === "issue" ? inServiceElsewhere(label) : inService(label) })
      if (reading.status === "retired") throw problem(409, { detail: isRetired(label) })
      return placeOf(reading)
    case "return":
      if (reading === null || reading.status !== "in-service") throw problem(409, { detail: notInService(label) })
      return placeOf(reading)
    case "decommission":
      if (reading === null) throw problem(409, { detail: noRecord(label) })
      if (reading.status === "retired") throw problem(409, { detail: alreadyRetired(label) })
      return placeOf(reading)
    case "adjustment":
      if (reading === null) return SUPPLIER
      if (reading.status === "in-service") throw problem(409, { detail: noAdjustmentInService(label) })
      return placeOf(reading)
  }
}

/**
 * Ends the placement a container is in service at, on `validTo`: the Registry
 * half of a return and of a decommission in service. Under the subscription's
 * lock, taken after the container's (top down), and read again underneath it,
 * since the read before only said which subscription to lock. The new end is
 * held inside the subscription's period (400 on `validTo`, naming the bound;
 * the ordering rule with it, routes/periods.ts) and may not run the placement
 * into the next one (the exclusion constraint, a 409). A placement the
 * reading names and the table does not have is a broken invariant, not a
 * client's doing.
 */
async function endPlacement(tx: Tx, principal: Principal, subject: ContainerRef, placementId: string, validTo: string): Promise<void> {
  const { companyId } = principal
  const held = () =>
    tx
      .select({
        subscriptionId: containerServicePlacement.subscriptionId,
        validFrom: containerServicePlacement.validFrom,
        subscriptionValidFrom: subscription.validFrom,
        subscriptionValidTo: subscription.validTo,
      })
      .from(containerServicePlacement)
      .innerJoin(subscription, and(eq(subscription.companyId, companyId), eq(subscription.id, containerServicePlacement.subscriptionId)))
      .where(
        and(
          eq(containerServicePlacement.companyId, companyId),
          eq(containerServicePlacement.containerId, subject.id),
          eq(containerServicePlacement.id, placementId),
        ),
      )
      .limit(1)
  const missing = () => new Error(`container ${subject.id} is in service at placement ${placementId}, which is not there to end`)
  const [before] = await held()
  if (before === undefined) throw missing()
  await lockRow(tx, subscription, { companyId, id: before.subscriptionId })
  const [current] = await held()
  if (current === undefined) throw missing()
  requireWithin({ validFrom: current.subscriptionValidFrom, validTo: current.subscriptionValidTo }, { validFrom: current.validFrom, validTo }, OUTSIDE_SUBSCRIPTION)
  await refuseOverlap({ [ALREADY_PLACED]: alreadyPlaced(subject.label) }, () =>
    tx
      .update(containerServicePlacement)
      .set({ validTo })
      .where(and(eq(containerServicePlacement.companyId, companyId), eq(containerServicePlacement.id, placementId))),
  )
}

/** The movement an adjustment says it corrects: one of this container's, or a 400 naming the field. */
async function requireMovementOf(tx: Tx, principal: Principal, subject: ContainerRef, id: string | undefined): Promise<void> {
  if (id === undefined) return
  const [row] = await tx
    .select({ id: stockMovement.id })
    .from(stockMovement)
    .where(and(eq(stockMovement.companyId, principal.companyId), eq(stockMovement.containerId, subject.id), eq(stockMovement.id, id)))
    .limit(1)
  if (row === undefined) throw invalidRequest("body", [{ path: "correctsMovementId", message: NOT_A_MOVEMENT_OF_THIS_CONTAINER }])
}

/** Where the intent arrives, held to the container's project, and the Registry half where service opens or ends. */
async function arrival(tx: Tx, principal: Principal, subject: ContainerRef, reading: Reading | null, from: Place, intent: Intent): Promise<{ to: Place; placementId: string | null }> {
  const within = { companyId: principal.companyId, projectId: subject.projectId }
  switch (intent.kind) {
    case "receipt":
      await requireWarehouse(tx, within, intent.to.warehouseId)
      return { to: intent.to, placementId: null }
    case "issue":
      return { to: SERVICE, placementId: await intent.open() }
    case "return":
      await requireWarehouse(tx, within, intent.to.warehouseId)
      // `departure` let a return through only in service, and service is a placement.
      if (reading?.placementId == null) throw new Error(`container ${subject.id} is in service at no placement`)
      await endPlacement(tx, principal, subject, reading.placementId, intent.validTo)
      return { to: intent.to, placementId: reading.placementId }
    case "transfer":
      await requireWarehouse(tx, within, intent.to.warehouseId)
      if (intent.to.kind === from.kind && intent.to.warehouseId === from.warehouseId) {
        throw invalidRequest("body", [{ path: "warehouseId", message: ALREADY_THERE }])
      }
      return { to: intent.to, placementId: null }
    case "decommission":
      if (from.kind === "service") {
        if (intent.validTo === undefined) throw invalidRequest("body", [{ path: "validTo", message: GIVE_VALID_TO }])
        if (reading?.placementId == null) throw new Error(`container ${subject.id} is in service at no placement`)
        await endPlacement(tx, principal, subject, reading.placementId, intent.validTo)
        return { to: SCRAP, placementId: reading.placementId }
      }
      if (intent.validTo !== undefined) throw invalidRequest("body", [{ path: "validTo", message: VALID_TO_SAYS_NOTHING }])
      return { to: SCRAP, placementId: null }
    case "adjustment":
      await requireMovementOf(tx, principal, subject, intent.correctsMovementId)
      await requireWarehouse(tx, within, intent.to.warehouseId)
      return { to: intent.to, placementId: null }
  }
}

const columns = {
  id: stockMovement.id,
  recordedAt: stockMovement.recordedAt,
  projectId: stockMovement.projectId,
  containerId: stockMovement.containerId,
  kind: stockMovement.kind,
  fromKind: stockMovement.fromKind,
  fromWarehouseId: stockMovement.fromWarehouseId,
  toKind: stockMovement.toKind,
  toWarehouseId: stockMovement.toWarehouseId,
  placementId: stockMovement.placementId,
  occurredAt: stockMovement.occurredAt,
  recordedBy: stockMovement.recordedBy,
  reason: stockMovement.reason,
  reference: stockMovement.reference,
  correctsMovementId: stockMovement.correctsMovementId,
}

type Row = Pick<typeof stockMovement.$inferSelect, keyof typeof columns>

/** The row on the wire. The three coded fields are text with a CHECK in the database and enums here; the vocabulary holds the two in lockstep. */
function movementOf(row: Row): StockMovement {
  return {
    id: row.id,
    recordedAt: row.recordedAt.toISOString(),
    projectId: row.projectId,
    containerId: row.containerId,
    kind: row.kind as StockMovementKind,
    fromKind: row.fromKind as StockPlaceKind,
    fromWarehouseId: row.fromWarehouseId,
    toKind: row.toKind as StockPlaceKind,
    toWarehouseId: row.toWarehouseId,
    placementId: row.placementId,
    occurredAt: row.occurredAt.toISOString(),
    recordedBy: row.recordedBy,
    reason: row.reason,
    reference: row.reference,
    correctsMovementId: row.correctsMovementId,
  }
}

/** Where a body carries the destination a refused shape is answered on; the body as a whole where the route fixed it. */
const toKindPath = (kind: StockMovementKind): string => (kind === "return" || kind === "transfer" || kind === "adjustment" ? "toKind" : "")

/**
 * Appends the row, whole: held to the shape table and to the clock, then
 * inserted. `recordedAt` is the database's now; `occurredAt` is the body's
 * word or the request's clock.
 */
async function append(
  tx: Tx,
  principal: Principal,
  subject: ContainerRef,
  movement: { kind: StockMovementKind; from: Place; to: Place; placementId: string | null; correctsMovementId?: string },
  says: Says,
): Promise<StockMovement> {
  const { kind, from, to } = movement
  if (!movementShape(kind, from.kind, to.kind)) {
    throw invalidRequest("body", [{ path: toKindPath(kind), message: noSuchShape(kind, from.kind, to.kind) }])
  }
  const occurredAt = says.occurredAt === undefined ? says.at : new Date(says.occurredAt)
  if (occurredAt.getTime() > says.at.getTime()) throw invalidRequest("body", [{ path: "occurredAt", message: RECORDED_AFTER_IT_HAPPENED }])
  const [row] = await tx
    .insert(stockMovement)
    .values({
      id: newId(),
      companyId: principal.companyId,
      projectId: subject.projectId,
      containerId: subject.id,
      kind,
      fromKind: from.kind,
      fromWarehouseId: from.warehouseId,
      toKind: to.kind,
      toWarehouseId: to.warehouseId,
      placementId: movement.placementId,
      occurredAt,
      recordedBy: principal.user.id,
      reason: says.reason ?? null,
      reference: says.reference ?? null,
      correctsMovementId: movement.correctsMovementId ?? null,
    })
    .returning(columns)
  return movementOf(row)
}

/**
 * The one function the commands call: lock, read, departure, arrival, append
 * (the header says why in that order). The route has found the container
 * under the caller's scope; everything else the command does happens here,
 * inside the request's transaction, so a refusal at any step leaves nothing
 * behind.
 */
export async function move(tx: Tx, principal: Principal, subject: ContainerRef, intent: Intent): Promise<StockMovement> {
  const reading = await lockedReading(tx, principal, subject)
  const from = await departure(tx, principal, subject, reading, intent)
  const { to, placementId } = await arrival(tx, principal, subject, reading, from, intent)
  return await append(
    tx,
    principal,
    subject,
    { kind: intent.kind, from, to, placementId, ...(intent.kind === "adjustment" ? { correctsMovementId: intent.correctsMovementId } : {}) },
    intent,
  )
}

/** The rows of this company, in the projects the caller works in: what every ledger statement is bounded by. */
const scope = (principal: Principal) => and(eq(stockMovement.companyId, principal.companyId), inProjects(stockMovement.projectId, principal))

/** What every command describes the same way: no usable token, no grant, no such container. */
const commandProblems = (action: "create" | "edit") => ({
  401: describeProblem("No usable token (see WWW-Authenticate)."),
  403: describeProblem(`No active account here, or the caller's role does not allow \`${action}\` on \`resources.containers\`.`),
  404: describeProblem("No container with that id in the projects this account works in."),
})

export type LifecycleOptions = {
  /** The request's clock, what `occurredAt` defaults to and may not pass; the app's, so a test can pin it. */
  now?: () => Date
}

export function lifecycleRoutes(guard: MiddlewareHandler<AuthEnv>, { now = () => new Date() }: LifecycleOptions = {}) {
  return new Hono<AuthEnv>()
    .post(
      "/containers/:id/receive",
      describeRoute({
        operationId: "receiveContainer",
        summary: "Receive a container into a warehouse",
        description:
          "Appends the container's first Stock Movement: from a supplier into a warehouse of its project. Only a container with no stock record yet can be received — one already in stock (409 naming the warehouse), in service (409: return it first) or retired (409: a scrapped container does not come back; register a new one) is refused, and a wrong first record is repaired through `adjust`. `occurredAt` is when it happened, on the caller's word, the request's clock when absent, and never later than that (400); `reference` is the delivery note. The server mints the id and records who asked.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The receipt as it was appended.", StockMovement),
          400: describeProblem("The path does not hold an id, or the body is missing the warehouse, names a member the ledger owns, names a warehouse that is not this container's project's, or dates the receipt after the request."),
          ...commandProblems("create"),
          409: describeProblem("The container already has a stock record: it is in stock, in service or retired."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", Receive),
      async (c) => {
        const { id } = c.req.valid("param")
        const { warehouseId, ...says } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const subject = await findContainerRef(tx, principal, id)
        if (subject === undefined) throw noSuchContainer(id)
        return c.json(await move(tx, principal, subject, { kind: "receipt", to: { kind: "warehouse", warehouseId }, ...says, at: now() }), 201)
      },
    )
    .post(
      "/containers/:id/return",
      describeRoute({
        operationId: "returnContainer",
        summary: "Take a container out of service into stock",
        description:
          "Ends the placement the container is in service at on `validTo` — the first day it no longer serves, held inside the subscription's period (400 naming the bound) and off the next placement (409) — and appends the return in the same transaction: from that placement into a warehouse of its project, or into maintenance at one when `toKind` says so. Either both change or neither. A container that is not in service is refused (409). `occurredAt` and `reference` are the movement's; `reason` says why it came back.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The return as it was appended; the placement now ends on `validTo`.", StockMovement),
          400: describeProblem(
            "The path does not hold an id, or the body is missing the warehouse or `validTo`, names a member the ledger owns, names a warehouse that is not this container's project's, ends the placement on or before the day it started or outside the subscription's period, or dates the return after the request.",
          ),
          ...commandProblems("create"),
          409: describeProblem("The container is not in service, or the new end would run its placement into the next one."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", Return),
      async (c) => {
        const { id } = c.req.valid("param")
        const { warehouseId, toKind, validTo, ...says } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const subject = await findContainerRef(tx, principal, id)
        if (subject === undefined) throw noSuchContainer(id)
        return c.json(await move(tx, principal, subject, { kind: "return", to: { kind: toKind, warehouseId }, validTo, ...says, at: now() }), 201)
      },
    )
    .post(
      "/containers/:id/transfer",
      describeRoute({
        operationId: "transferContainer",
        summary: "Move a container between places in stock",
        description:
          "Appends a transfer from where the container stands — a warehouse, or maintenance at one — to another warehouse of its project, or into or out of maintenance, recorded on arrival: a container on a truck between two warehouses reads as still in the first until the second records it. The same place and the same kind is refused (400 on `warehouseId`: already there). A container with no stock record, in service or retired is refused (409).",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The transfer as it was appended.", StockMovement),
          400: describeProblem("The path does not hold an id, or the body is missing the warehouse, names a member the ledger owns, names a warehouse that is not this container's project's, names the place the container already stands in, or dates the transfer after the request."),
          ...commandProblems("create"),
          409: describeProblem("The container is not in stock: it has no record, is in service or is retired."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", Transfer),
      async (c) => {
        const { id } = c.req.valid("param")
        const { warehouseId, toKind, ...says } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const subject = await findContainerRef(tx, principal, id)
        if (subject === undefined) throw noSuchContainer(id)
        return c.json(await move(tx, principal, subject, { kind: "transfer", to: { kind: toKind, warehouseId }, ...says, at: now() }), 201)
      },
    )
    .post(
      "/containers/:id/decommission",
      describeRoute({
        operationId: "decommissionContainer",
        summary: "Scrap a container",
        description:
          "Appends the decommission: from wherever the container stands to scrap, with the reason. In service, `validTo` is required (400) and ends the placement in the same transaction, as a return does; out of service, `validTo` is refused (400), since there is no placement to end. A container with no stock record (409) or already retired (409) is refused. A retired container never comes back through `receive`; a wrong decommission is corrected through `adjust`.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The decommission as it was appended; a placement it ended now ends on `validTo`.", StockMovement),
          400: describeProblem(
            "The path does not hold an id, or the body is missing the reason, names a member the ledger owns, gives `validTo` out of service or withholds it in service, ends the placement on or before the day it started or outside the subscription's period, or dates the decommission after the request.",
          ),
          ...commandProblems("create"),
          409: describeProblem("The container has no stock record, is already retired, or the placement's new end would run it into the next one."),
        },
      }),
      guard,
      requireGrant(MODULE, "create"),
      validate("param", IdParam),
      validate("json", Decommission),
      async (c) => {
        const { id } = c.req.valid("param")
        const { validTo, ...says } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const subject = await findContainerRef(tx, principal, id)
        if (subject === undefined) throw noSuchContainer(id)
        return c.json(await move(tx, principal, subject, { kind: "decommission", ...(validTo === undefined ? {} : { validTo }), ...says, at: now() }), 201)
      },
    )
    .post(
      "/containers/:id/adjust",
      describeRoute({
        operationId: "adjustContainer",
        summary: "Correct the ledger's reading of a container",
        description:
          "The correction door: appends an adjustment from wherever the ledger says the container is — a supplier when it has no record, which is how an import that skipped the receipt is repaired — to a warehouse of its project, to maintenance at one, or to scrap, with the reason and, where it corrects one, the movement it corrects, which must be this container's (400). Neither side may be service: a container in service is refused (409) and is returned or decommissioned instead, since an adjustment does not touch a placement. `edit` on `resources.containers`, not `create`: this rewrites what the ledger says rather than recording what happened.",
        security: BEARER_SECURITY,
        responses: {
          201: describeJson("The adjustment as it was appended.", StockMovement),
          400: describeProblem(
            "The path does not hold an id, or the body is missing the reason or the target, names a member the ledger owns, names a warehouse with scrap or none with a place in stock, names a warehouse that is not this container's project's, names a movement that is not this container's, or dates the adjustment after the request.",
          ),
          ...commandProblems("edit"),
          409: describeProblem("The container is in service: return or decommission it."),
        },
      }),
      guard,
      requireGrant(MODULE, "edit"),
      validate("param", IdParam),
      validate("json", Adjust),
      async (c) => {
        const { id } = c.req.valid("param")
        const { toKind, warehouseId, correctsMovementId, ...says } = c.req.valid("json")
        const tx = c.get("tx")
        const principal = c.get("principal")
        const subject = await findContainerRef(tx, principal, id)
        if (subject === undefined) throw noSuchContainer(id)
        return c.json(
          await move(tx, principal, subject, {
            kind: "adjustment",
            to: { kind: toKind, warehouseId: warehouseId ?? null },
            ...(correctsMovementId === undefined ? {} : { correctsMovementId }),
            ...says,
            at: now(),
          }),
          201,
        )
      },
    )
    .get(
      "/containers/:id/movements",
      describeRoute({
        operationId: "listContainerMovements",
        summary: "One container's ledger",
        description:
          "One page of the container's Stock Movements, oldest first: ids are time-ordered, so a cursor over them is a cursor over recording order, and the last item of the last page is the movement `assetState` reads. `occurredAt` is when each happened, on the caller's word; `recordedAt` is when it was appended. A container of another company, or of a project this account does not work in, is a container that does not exist here. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of the container's movements.", MovementPage),
          400: describeProblem("The path does not hold an id, the page size is outside 1..200, or the cursor is not one this API wrote."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `resources.containers`."),
          404: describeProblem("No container with that id in the projects this account works in."),
        },
      }),
      guard,
      requireGrant(MODULE, "view"),
      validate("param", IdParam),
      validate("query", PageRequest),
      async (c) => {
        const { id } = c.req.valid("param")
        const { limit, cursor } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if ((await findContainerRef(tx, principal, id)) === undefined) throw noSuchContainer(id)
        const rows = await tx
          .select(columns)
          .from(stockMovement)
          .where(and(scope(principal), eq(stockMovement.containerId, id), after === undefined ? undefined : gt(stockMovement.id, after)))
          .orderBy(asc(stockMovement.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(movementOf), limit))
      },
    )
    .get(
      "/stock-movements",
      describeRoute({
        operationId: "listStockMovements",
        summary: "The ledger across containers",
        description:
          "One page of Stock Movements, oldest first (ids are time-ordered), from the projects the caller works in — an account that works in none, such as a service provider's, reads an empty page. `projectId` narrows it to one of those projects; naming another is refused. `containerId` is one container's ledger, `warehouseId` every movement that left from or arrived at that warehouse (a warehouse outside the projects this account works in is refused), `kind` one kind, and `from`/`to` the window over `occurredAt`, both inclusive. What stands in a warehouse today is `GET /containers?warehouseId=`, the projection; this is what moved. Hand `nextCursor` back as `cursor` for the next page.",
        security: BEARER_SECURITY,
        responses: {
          200: describeJson("One page of movements.", MovementPage),
          400: describeProblem("The page size is outside 1..200, the cursor is not one this API wrote, the window runs backwards, `projectId` is not a project this account works in, or `warehouseId` is not a warehouse of one."),
          401: describeProblem("No usable token (see WWW-Authenticate)."),
          403: describeProblem("No active account here, or the caller's role does not allow `view` on `resources.inventory`."),
        },
      }),
      guard,
      requireGrant(INVENTORY, "view"),
      validate("query", StockMovementListQuery),
      async (c) => {
        const { limit, cursor, projectId, containerId, warehouseId, kind, from, to } = c.req.valid("query")
        const after = afterCursor(cursor)
        const tx = c.get("tx")
        const principal = c.get("principal")
        if (projectId !== undefined) requireProject(principal, projectId, "projectId", "query")
        // The warehouse asked about is one the caller may see: the project named, or any the caller works in — the containers list's rule.
        if (warehouseId !== undefined) {
          await requireWarehouse(tx, { companyId: principal.companyId, projectId: projectId ?? projectIdsOf(principal) }, warehouseId, "warehouseId", "query")
        }
        const rows = await tx
          .select(columns)
          .from(stockMovement)
          .where(
            and(
              scope(principal),
              projectId === undefined ? undefined : eq(stockMovement.projectId, projectId),
              containerId === undefined ? undefined : eq(stockMovement.containerId, containerId),
              warehouseId === undefined ? undefined : or(eq(stockMovement.fromWarehouseId, warehouseId), eq(stockMovement.toWarehouseId, warehouseId)),
              kind === undefined ? undefined : eq(stockMovement.kind, kind),
              from === undefined ? undefined : gte(stockMovement.occurredAt, new Date(from)),
              to === undefined ? undefined : lte(stockMovement.occurredAt, new Date(to)),
              after === undefined ? undefined : gt(stockMovement.id, after),
            ),
          )
          .orderBy(asc(stockMovement.id))
          .limit(fetchLimit(limit))
        return c.json(pageOf(rows.map(movementOf), limit))
      },
    )
}
