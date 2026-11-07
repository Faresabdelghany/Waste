// The Stock Movement ledger's commands (Issue #101, ADR-0003): a container is
// received from a supplier into a warehouse, issued into service, returned
// into stock or into maintenance, transferred between the two, decommissioned
// to scrap, or adjusted when the ledger is wrong. Each command appends one row
// and, where the container enters or leaves service, writes or ends the
// Registry's placement in the same transaction. Either both change or
// neither. The office's commands (apps/api's routes/lifecycle.ts and the
// issue, routes/containers.ts) and a work order's completion at the driver
// door or the office's correction (`work-orders.ts`) run the same statements
// here; the caller has found the container under its own scope.
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
//                 down, so no two transactions hold half of each other's pair.
//                 A ledger row is never locked: `wms_api` may not, so the
//                 container stands for its chain;
//   read        — the container's reading, its latest movement in recording
//                 order (`../query/asset-state` says why not `occurred_at`),
//                 read for this one container and folded onto the glossary's
//                 state by the domain;
//   departure   — the state rule of the command, a conflict with the
//                 container's label and a sentence per state spelled once
//                 below: a receipt wants no record, an issue and a transfer
//                 want stock, a return wants service, a decommission wants a
//                 record that is not scrap, an adjustment wants anything but
//                 service. Where the intent passes, the movement's `from` is
//                 where the reading says the container is (a supplier when
//                 there is none);
//   hold        — the row's two rules, where they can first be judged and
//                 before any Registry statement runs: the shape
//                 (`movementShape`, the domain's table of pairs each kind
//                 allows, over where the movement leaves from and the kind of
//                 place the intent arrives at, which the intent says before
//                 any warehouse is looked up — invalid at the input the intent
//                 carried its `to` in, one door before the database's
//                 `stock_movement_kind_shape` would answer a code) and the
//                 clock (`occurredAt` may run ahead of the caller's clock by
//                 `OCCURRED_AT_SKEW_MS`, a device's clock being a device's, and
//                 no further). An intent that says something the ledger cannot
//                 take is refused with nothing to roll back;
//   arrival     — what the intent named, held to the container's project
//                 (`NOT_A_WAREHOUSE`) and to a warehouse that takes stock (a
//                 conflict naming the status: a closed or draft warehouse
//                 takes no new movement, while what stands there stands —
//                 #79's rule), and the Registry half where service opens or
//                 ends: the issue's placement is written by `issueContainer`
//                 (handed in as `open`), and a return's or a decommission's
//                 placement is ended by `endPlacement` — the Registry's
//                 placement in force for the container, not the issue's
//                 (#291) — under the subscription's lock and inside its period;
//   append      — the row, `id: newId()`, `recordedBy` the actor's account,
//                 `occurredAt` the instant `hold` settled. Nothing is read
//                 back from the projection: the row just written is, by
//                 construction, the latest. The transaction is the caller's,
//                 so a refusal anywhere above leaves no placement behind.
//
// Every refusal is the domain's `Refused`, which each door answers as its
// own: the API as the 409 or 400 it names, a work order's completion as the
// office's task carrying its sentence. Postgres's shape checks (23514) are the
// backstop and, unnamed, the API's 500 — the signal that a sentence is
// missing here. The exclusion constraint on the placement (23P01) still
// answers behind the state rule, and answers a race the lock lets through
// only in theory: two issues of one container serialise on the lock and the
// second reads the first's service.
import type { AdjustmentTarget, StockMovement, StockPlace } from "@waste/contracts/stock"
import { ENDS_AFTER_IT_STARTS } from "@waste/contracts/validity"
import { aheadOfClock, NOT_A_FRACTION, RECORDED_AFTER_IT_HAPPENED } from "@waste/domain/execution/commands"
import type { Period } from "@waste/domain/periods"
import { Refused } from "@waste/domain/refusal"
import { refuseUnservedPlace, type Place as ServedPlace } from "@waste/domain/registry/served-places"
import { assetStateOf as stateAfter, movementShape } from "@waste/domain/resources/asset-state"
import type { AssetStatus, DecommissionReasonStatus, StockMovementKind, StockPlaceKind, WarehouseStatus } from "@waste/domain/resources/vocabulary"
import { and, asc, desc, eq, gte, lt, type SQL } from "drizzle-orm"

import type { Tx } from "../client"
import { newId } from "../ids"
import { ASSET_STATE_COLUMNS } from "../query/asset-state"
import { subscription } from "../schema/agreements"
import { serviceFrequency, wasteFraction } from "../schema/catalogue"
import { container, containerServicePlacement } from "../schema/containers"
import { property, sharedCollectionPoint } from "../schema/customers"
import { warehouse } from "../schema/places"
import { decommissionReason, stockMovement } from "../schema/stock"
import { stockMovementColumns, stockMovementOf } from "../shapes/stock-movements"
import { lockRow, refuseOverlap, type Actor, type TenantTable } from "./shared"

/** The container a command moves: what the caller found under its scope, and what every sentence below names it by. */
export type ContainerRef = { id: string; projectId: string; label: string }

/** What a bound outside the subscription's period is told: a return's or a decommission's end here, an issue's start, and the placement patch's end. */
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
/**
 * A return or a decommission ending service before a placement of the
 * container that begins later — a change of service planned for that day —
 * which would then stand after the container had left (#291). The later
 * placement is the Registry's to end first; the intent is fine, so a conflict
 * like the other states.
 */
export const placedAgainFrom = (label: string, day: string) => `Container ${label} is placed again from ${day}; end that placement before returning it earlier`

// The invalid inputs: an intent that says something the ledger cannot take.

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

/** What an intent naming a warehouse outside the container's project is told; the API's lookups of a warehouse a body or a query names say the same. */
export const NOT_A_WAREHOUSE = "Not a warehouse of this project"
/** What a decommission naming no reason of this company is told (O30 of #290). */
export const NOT_A_DECOMMISSION_REASON = "Not a decommission reason of this company"
/** What a decommission naming a retired reason is told (O30 of #290). */
export const retiredReason = (name: string): string => `The decommission reason ${JSON.stringify(name)} is retired; a decommission names an active one`
/** What an issue naming a subscription of another project is told; the composite key holds it to the same thing. */
const NOT_A_SUBSCRIPTION = "Not a subscription of this container's project"
/** The same for the point a public placement names (M12 of #293). */
const NOT_A_POINT = "Not a shared collection point of this container's project"
/** What an issue naming another project's cadence is told; the API's lookup of a service frequency a body names says the same. */
export const NOT_A_SERVICE_FREQUENCY = "Not a service frequency of this project"

// Resources, round A (Issue #101 review): the warehouse a movement arrives at.
// A closed or draft warehouse takes no new stock — nothing is received,
// returned, transferred or adjusted into it — and what stands there stands:
// the ledger's rows are never rewritten, the projection goes on reading them,
// and a transfer out of it is a movement into somewhere else, which is the
// way to empty it. `active` and `restricted` take stock; what `restricted`
// restricts is inventory's question, not the ledger's. The refusal is a
// conflict naming the warehouse and its status — the row named is really
// there, and no better intent would do while the warehouse stands as it does.

/** The warehouse statuses a movement may not arrive at. */
export const WAREHOUSE_TAKES_NO_STOCK: readonly WarehouseStatus[] = ["draft", "closed"]

/** What a movement into a closed or draft warehouse is told, naming the warehouse and its status. */
export const takesNoStock = (name: string, status: WarehouseStatus): string => `${name} is ${status}; a movement arrives only at an active or restricted warehouse`

/** Holds the warehouse a movement arrives at open for stock: the #79 rule as the ledger applies it, and as a work order's booking judges the movement its completion will make. */
export function requireWarehouseTakesStock(found: { name: string; status: WarehouseStatus }): void {
  if (WAREHOUSE_TAKES_NO_STOCK.includes(found.status)) throw Refused.conflict(takesNoStock(found.name, found.status))
}

/** A place a movement leaves from or arrives at: a kind, and the warehouse when the kind is at one. */
type Place = { kind: StockPlaceKind; warehouseId: string | null }

/** A place in stock as an intent names it: a warehouse, or maintenance at one. */
export type StockPlaceRef = { kind: StockPlace; warehouseId: string }

const SUPPLIER: Place = { kind: "supplier", warehouseId: null }
const SERVICE: Place = { kind: "service", warehouseId: null }
const SCRAP: Place = { kind: "scrap", warehouseId: null }

/** What every command may say beside its own: when it happened, why, what paper it quotes — and the caller's clock, which `occurredAt` defaults to and may not pass. */
type Says = { occurredAt?: string; reason?: string; reference?: string; at: Date }

/**
 * What a command intends. The kind is the command's, the destination the
 * caller's where it has one, and the Registry half is either handed in
 * (`open`, the issue's placement written by `issueContainer` and its id
 * answered) or asked for (`validTo`, the day a return or a decommission ends
 * the placement the container is in service at).
 */
export type Intent = Says &
  (
    | { kind: "receipt"; to: StockPlaceRef }
    | { kind: "issue"; open: () => Promise<string> }
    | { kind: "return"; to: StockPlaceRef; validTo: string }
    | { kind: "transfer"; to: StockPlaceRef }
    | { kind: "decommission"; validTo?: string; decommissionReasonId: string }
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

/** Whether a row of the table answers the condition: the one lookup the references an intent names are held by. */
async function present(tx: Tx, table: TenantTable, where: SQL | undefined): Promise<boolean> {
  const [row] = await tx.select({ id: table.id }).from(table).where(where).limit(1)
  return row !== undefined
}

/**
 * Takes the container's row lock and reads where the ledger says it is: the
 * first two steps of every command, in this order, so the reading is the one
 * the command's write will follow. Null for a container with no movement yet.
 */
async function lockedReading(tx: Tx, companyId: string, subject: ContainerRef): Promise<Reading | null> {
  await lockRow(tx, container, { companyId, id: subject.id })
  const [row] = await tx
    .select(ASSET_STATE_COLUMNS)
    .from(stockMovement)
    .where(and(eq(stockMovement.companyId, companyId), eq(stockMovement.containerId, subject.id)))
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
async function departure(tx: Tx, companyId: string, subject: ContainerRef, reading: Reading | null, kind: Intent["kind"]): Promise<Place> {
  const { label } = subject
  switch (kind) {
    case "receipt":
      if (reading === null) return SUPPLIER
      if (reading.status === "in-service") throw Refused.conflict(inService(label))
      if (reading.status === "retired") throw Refused.conflict(neverComesBack(label))
      throw Refused.conflict(alreadyInStock(label, await warehouseName(tx, companyId, reading.warehouseId)))
    case "issue":
    case "transfer":
      if (reading === null) throw Refused.conflict(noRecord(label))
      if (reading.status === "in-service") throw Refused.conflict(kind === "issue" ? inServiceElsewhere(label) : inService(label))
      if (reading.status === "retired") throw Refused.conflict(isRetired(label))
      return placeOf(reading)
    case "return":
      if (reading === null || reading.status !== "in-service") throw Refused.conflict(notInService(label))
      return placeOf(reading)
    case "decommission":
      if (reading === null) throw Refused.conflict(noRecord(label))
      if (reading.status === "retired") throw Refused.conflict(alreadyRetired(label))
      return placeOf(reading)
    case "adjustment":
      if (reading === null) return SUPPLIER
      if (reading.status === "in-service") throw Refused.conflict(noAdjustmentInService(label))
      return placeOf(reading)
  }
}

/**
 * Whether the container may leave where it stands as an issue or a return
 * would — the command's state rule under the container's lock, refused with
 * the sentence spelled above — writing nothing: a ledger work order's booking
 * (O3b of #290) holds the container to the move its completion will make.
 */
export async function requireDeparture(tx: Tx, companyId: string, subject: ContainerRef, kind: "issue" | "return"): Promise<void> {
  await departure(tx, companyId, subject, await lockedReading(tx, companyId, subject), kind)
}

/**
 * Ends the container's placement in force on `validTo`: the Registry half of
 * a return and of a decommission in service. The placement is the
 * Registry's — the container's latest to begin before `validTo` — and never
 * the one the ledger's issue named (#291, slice 10): a change of service
 * hands a container on to the subscription replacing its own without a
 * movement, since nothing moved, and a termination ends the placement while
 * the bin stays where it is until someone removes it. Under its
 * subscription's lock, taken after the container's (top down), and read again
 * underneath it — once more should a change have handed the container on
 * meanwhile, whose replacement's lock is then taken too. One that already
 * ended on or before `validTo` — a terminated agreement's, an import's — ends
 * nothing more, and the movement records it. Otherwise the new end is held
 * inside the subscription's period (invalid at `validTo`; its start was held
 * inside when it was written, and the subscription's own patch strands no
 * placement). A placement of the container beginning on or after `validTo` —
 * a change planned for a later day — would stand after the container had left
 * it, and is a conflict naming its day, after the invalid inputs. An end on
 * or before every placement's start is the ordering refusal at `validTo`; a
 * container the ledger has in service with no placement at all is a broken
 * invariant, not a client's doing, and is thrown. Answers the placement the
 * movement records.
 */
async function endPlacement(tx: Tx, companyId: string, subject: ContainerRef, validTo: string): Promise<string> {
  const ofContainer = and(eq(containerServicePlacement.companyId, companyId), eq(containerServicePlacement.containerId, subject.id))
  const inForce = async () => {
    const [row] = await tx
      .select({
        id: containerServicePlacement.id,
        subscriptionId: containerServicePlacement.subscriptionId,
        sharedCollectionPointId: containerServicePlacement.sharedCollectionPointId,
        validFrom: containerServicePlacement.validFrom,
        validTo: containerServicePlacement.validTo,
        subscriptionValidFrom: subscription.validFrom,
        subscriptionValidTo: subscription.validTo,
      })
      .from(containerServicePlacement)
      .leftJoin(subscription, and(eq(subscription.companyId, companyId), eq(subscription.id, containerServicePlacement.subscriptionId)))
      .where(and(ofContainer, lt(containerServicePlacement.validFrom, validTo)))
      .orderBy(desc(containerServicePlacement.validFrom))
      .limit(1)
    return row
  }

  let current = await inForce()
  const locked = new Set<string>()
  // A public placement (M12 of #293) is held under its point's lock, as a subscribed one is under its subscription's.
  while (current !== undefined) {
    const id = current.subscriptionId ?? current.sharedCollectionPointId
    if (id === null || locked.has(id)) break
    await lockRow(tx, current.subscriptionId !== null ? subscription : sharedCollectionPoint, { companyId, id })
    locked.add(id)
    current = await inForce()
  }
  if (current === undefined) {
    const [any] = await tx.select({ id: containerServicePlacement.id }).from(containerServicePlacement).where(ofContainer).limit(1)
    if (any === undefined) throw new Error(`container ${subject.id} is in service at no placement`)
    throw Refused.invalid("validTo", ENDS_AFTER_IT_STARTS)
  }

  const ends = current.validTo === null || current.validTo > validTo
  // The invalid end first — inside the subscription's period; a public placement has none to stay inside — then the conflict, the order every door keeps.
  if (ends && current.subscriptionValidTo !== null && validTo > current.subscriptionValidTo) throw Refused.invalid("validTo", OUTSIDE_SUBSCRIPTION)
  const [later] = await tx
    .select({ validFrom: containerServicePlacement.validFrom })
    .from(containerServicePlacement)
    .where(and(ofContainer, gte(containerServicePlacement.validFrom, validTo)))
    .orderBy(asc(containerServicePlacement.validFrom))
    .limit(1)
  if (later !== undefined) throw Refused.conflict(placedAgainFrom(subject.label, later.validFrom))
  if (ends) {
    await tx
      .update(containerServicePlacement)
      .set({ validTo })
      .where(and(eq(containerServicePlacement.companyId, companyId), eq(containerServicePlacement.id, current.id)))
  }
  return current.id
}

/** The movement an adjustment says it corrects: one of this container's, or invalid at the input. */
async function requireMovementOf(tx: Tx, companyId: string, subject: ContainerRef, id: string | undefined): Promise<void> {
  if (id === undefined) return
  if (!(await present(tx, stockMovement, and(eq(stockMovement.companyId, companyId), eq(stockMovement.containerId, subject.id), eq(stockMovement.id, id))))) {
    throw Refused.invalid("correctsMovementId", NOT_A_MOVEMENT_OF_THIS_CONTAINER)
  }
}

/**
 * The warehouse a movement arrives at: the container's project's (invalid at
 * `warehouseId`) and one that takes stock (a conflict naming the status). The
 * gate is on the arrival only — a transfer out of a closed warehouse is a
 * movement into somewhere else, and the stock standing in one stands. A
 * target with no warehouse, an adjustment to scrap, names nothing to hold.
 */
async function arrivalWarehouse(tx: Tx, within: { companyId: string; projectId: string }, id: string | null): Promise<void> {
  if (id === null) return
  const [found] = await tx
    .select({ name: warehouse.name, status: warehouse.status })
    .from(warehouse)
    .where(and(eq(warehouse.companyId, within.companyId), eq(warehouse.projectId, within.projectId), eq(warehouse.id, id)))
    .limit(1)
  if (found === undefined) throw Refused.invalid("warehouseId", NOT_A_WAREHOUSE)
  // `status` is text with a CHECK in the database and the vocabulary's tuple here.
  requireWarehouseTakesStock({ name: found.name, status: found.status as WarehouseStatus })
}

/** The Decommission Reason a decommission names: the company's (invalid at `decommissionReasonId`) and active (a conflict), since a status gates a new reference. */
async function requireDecommissionReason(tx: Tx, companyId: string, id: string): Promise<void> {
  const [found] = await tx
    .select({ name: decommissionReason.name, status: decommissionReason.status })
    .from(decommissionReason)
    .where(and(eq(decommissionReason.companyId, companyId), eq(decommissionReason.id, id)))
    .limit(1)
  if (found === undefined) throw Refused.invalid("decommissionReasonId", NOT_A_DECOMMISSION_REASON)
  if ((found.status as DecommissionReasonStatus) !== "active") throw Refused.conflict(retiredReason(found.name))
}

/** Where the intent arrives, held to the container's project, and the Registry half where service opens or ends. */
async function arrival(tx: Tx, companyId: string, subject: ContainerRef, from: Place, intent: Intent): Promise<{ to: Place; placementId: string | null }> {
  const within = { companyId, projectId: subject.projectId }
  switch (intent.kind) {
    case "receipt":
      await arrivalWarehouse(tx, within, intent.to.warehouseId)
      return { to: intent.to, placementId: null }
    case "issue":
      return { to: SERVICE, placementId: await intent.open() }
    case "return":
      await arrivalWarehouse(tx, within, intent.to.warehouseId)
      // `departure` let a return through only in service, and service is a placement.
      return { to: intent.to, placementId: await endPlacement(tx, companyId, subject, intent.validTo) }
    case "transfer":
      await arrivalWarehouse(tx, within, intent.to.warehouseId)
      if (intent.to.kind === from.kind && intent.to.warehouseId === from.warehouseId) throw Refused.invalid("warehouseId", ALREADY_THERE)
      return { to: intent.to, placementId: null }
    case "decommission":
      if (from.kind === "service") {
        if (intent.validTo === undefined) throw Refused.invalid("validTo", GIVE_VALID_TO)
        return { to: SCRAP, placementId: await endPlacement(tx, companyId, subject, intent.validTo) }
      }
      if (intent.validTo !== undefined) throw Refused.invalid("validTo", VALID_TO_SAYS_NOTHING)
      return { to: SCRAP, placementId: null }
    case "adjustment":
      await requireMovementOf(tx, companyId, subject, intent.correctsMovementId)
      await arrivalWarehouse(tx, within, intent.to.warehouseId)
      return { to: intent.to, placementId: null }
  }
}

/** The input an intent carries its destination in, where a refused shape is answered; the intent as a whole where the command fixed it. */
const toKindPath = (kind: StockMovementKind): string => (kind === "return" || kind === "transfer" || kind === "adjustment" ? "toKind" : "")

/** The kind of place the intent arrives at, known from the intent alone: the issue's is service, the decommission's scrap, the rest name theirs. */
const destinationKind = (intent: Intent): StockPlaceKind => (intent.kind === "issue" ? "service" : intent.kind === "decommission" ? "scrap" : intent.to.kind)

/**
 * The row's two rules, held as soon as `departure` has said where the
 * movement leaves from and before any Registry statement runs: the shape
 * table over the kind, the place left and the kind of place arrived at
 * (invalid at the input the intent carried its `to` in), and the clock — the
 * instant may run ahead of the caller's by `OCCURRED_AT_SKEW_MS` and no
 * further (invalid at `occurredAt`). Answers the instant the row will carry.
 */
function hold(kind: StockMovementKind, from: Place, toKind: StockPlaceKind, says: Says): Date {
  if (!movementShape(kind, from.kind, toKind)) throw Refused.invalid(toKindPath(kind), noSuchShape(kind, from.kind, toKind))
  const occurredAt = says.occurredAt === undefined ? says.at : new Date(says.occurredAt)
  if (aheadOfClock(occurredAt, says.at)) throw Refused.invalid("occurredAt", RECORDED_AFTER_IT_HAPPENED)
  return occurredAt
}

/** Appends the row `hold` settled and `arrival` completed. `recordedAt` is the database's now. */
async function append(
  tx: Tx,
  actor: Actor,
  subject: ContainerRef,
  movement: { kind: StockMovementKind; from: Place; to: Place; placementId: string | null; occurredAt: Date; correctsMovementId?: string; decommissionReasonId?: string },
  says: Says,
): Promise<StockMovement> {
  const { kind, from, to } = movement
  const [row] = await tx
    .insert(stockMovement)
    .values({
      id: newId(),
      companyId: actor.companyId,
      projectId: subject.projectId,
      containerId: subject.id,
      kind,
      fromKind: from.kind,
      fromWarehouseId: from.warehouseId,
      toKind: to.kind,
      toWarehouseId: to.warehouseId,
      placementId: movement.placementId,
      occurredAt: movement.occurredAt,
      recordedBy: actor.userAccountId,
      reason: says.reason ?? null,
      reference: says.reference ?? null,
      correctsMovementId: movement.correctsMovementId ?? null,
      decommissionReasonId: movement.decommissionReasonId ?? null,
    })
    .returning(stockMovementColumns)
  return stockMovementOf(row)
}

/**
 * The one function the commands call: lock, read, departure, hold, arrival,
 * append (the header says why in that order). Everything the command does
 * happens here, inside the caller's transaction, so a refusal at any step
 * leaves nothing behind.
 */
export async function move(tx: Tx, actor: Actor, subject: ContainerRef, intent: Intent): Promise<StockMovement> {
  const { companyId } = actor
  const reading = await lockedReading(tx, companyId, subject)
  const from = await departure(tx, companyId, subject, reading, intent.kind)
  const occurredAt = hold(intent.kind, from, destinationKind(intent), intent)
  // A decommission's reason (O30 of #290) is the intent's input: judged after the container's own state, before the placement is touched.
  if (intent.kind === "decommission") await requireDecommissionReason(tx, companyId, intent.decommissionReasonId)
  const { to, placementId } = await arrival(tx, companyId, subject, from, intent)
  return await append(
    tx,
    actor,
    subject,
    {
      kind: intent.kind,
      from,
      to,
      placementId,
      occurredAt,
      ...(intent.kind === "adjustment" ? { correctsMovementId: intent.correctsMovementId } : {}),
      ...(intent.kind === "decommission" ? { decommissionReasonId: intent.decommissionReasonId } : {}),
    },
    intent,
  )
}

/**
 * The subscription an issue names, held to the container's project and
 * answered with its period and the state of its place: the containment check
 * needs the period and the status gate needs the place, so the lookup that
 * proves the subscription is there is the one that fetches both. The place is
 * reached through the subscription, as ADR-0003 has it; each join carries
 * `company_id`. The two statuses are text the columns' checks hold to the
 * vocabulary, read as the statuses they are.
 */
async function findServedSubscription(tx: Tx, within: { companyId: string; projectId: string }, id: string): Promise<Period & ServedPlace> {
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
  if (row === undefined) throw Refused.invalid("subscriptionId", NOT_A_SUBSCRIPTION)
  return row as Period & ServedPlace
}

/**
 * The Shared Collection Point a public placement names (M12 of #293), held to
 * the container's project and answered with its state, for the status gate
 * as a subscription's place is.
 */
async function findPublicPoint(tx: Tx, within: { companyId: string; projectId: string }, id: string): Promise<ServedPlace> {
  const [row] = await tx
    .select({ status: sharedCollectionPoint.status })
    .from(sharedCollectionPoint)
    .where(and(eq(sharedCollectionPoint.companyId, within.companyId), eq(sharedCollectionPoint.projectId, within.projectId), eq(sharedCollectionPoint.id, id)))
    .limit(1)
  if (row === undefined) throw Refused.invalid("sharedCollectionPointId", NOT_A_POINT)
  return { propertyStatus: null, sharedCollectionPointStatus: row.status as ServedPlace["sharedCollectionPointStatus"] }
}

/**
 * A placement starts inside the subscription's period: on or after its first
 * day and before its first day out, refused at `validFrom`. The end is not
 * judged here, since an issue gives none — the ledger sets it, and holds it
 * inside the period then (`endPlacement`).
 */
function requireStartsWithin(served: Period, validFrom: string): void {
  if (validFrom < served.validFrom || (served.validTo !== null && validFrom >= served.validTo)) throw Refused.invalid("validFrom", OUTSIDE_SUBSCRIPTION)
}

/** What an issue opens a placement with: serving a subscription or standing for the project at a point, the fraction, a cadence overriding the product's, and the first day. */
export type IssueValues = { subscriptionId?: string | null; sharedCollectionPointId?: string | null; wasteFractionId: string; serviceFrequencyId?: string | null; validFrom: string }

/**
 * The `issue` command (Issue #101): the placement under its subscription and
 * the movement from the warehouse the container stood in, in the caller's
 * transaction, both or neither. The office's `POST /containers/:id/placements`
 * runs it, and so does a delivery's or a swap's completion (O3b of #290).
 * What the values name is held before the ledger is consulted — values that
 * name nothing real, or start outside the subscription's period, are refused
 * whatever the container's state; the period is read again and held again
 * under the subscription's lock inside `open`, and this unlocked check is the
 * cheap one that answers first. Answers the movement, which names the
 * placement.
 */
export async function issueContainer(tx: Tx, actor: Actor, into: ContainerRef, values: IssueValues, says: { occurredAt?: string; reference?: string; at: Date }): Promise<StockMovement & { placementId: string }> {
  const { companyId } = actor
  const within = { companyId, projectId: into.projectId }
  const point = values.sharedCollectionPointId ?? null
  const subscriptionId = values.subscriptionId ?? null
  const served = subscriptionId === null ? null : await findServedSubscription(tx, within, subscriptionId)
  if (point !== null) await findPublicPoint(tx, within, point)
  if (!(await present(tx, wasteFraction, and(eq(wasteFraction.companyId, companyId), eq(wasteFraction.id, values.wasteFractionId))))) {
    throw Refused.invalid("wasteFractionId", NOT_A_FRACTION)
  }
  const frequencyId = values.serviceFrequencyId
  if (frequencyId != null && !(await present(tx, serviceFrequency, and(eq(serviceFrequency.companyId, companyId), eq(serviceFrequency.id, frequencyId), eq(serviceFrequency.projectId, into.projectId))))) {
    throw Refused.invalid("serviceFrequencyId", NOT_A_SERVICE_FREQUENCY)
  }
  if (served !== null) requireStartsWithin(served, values.validFrom)

  const movement = await move(tx, actor, into, {
    kind: "issue",
    // The Registry half, run once the container is locked and its state
    // allows: the subscription locked (after the container's, top down), its
    // period and its place's state read again underneath, the start held
    // inside the period and the place held to still serve, then the
    // placement written, open. A public placement's point is locked and read
    // again the same way; no period bounds it.
    open: async () => {
      if (subscriptionId !== null) {
        await lockRow(tx, subscription, { companyId, id: subscriptionId })
        const served = await findServedSubscription(tx, within, subscriptionId)
        requireStartsWithin(served, values.validFrom)
        // Every invalid input above, every conflict below (#79).
        refuseUnservedPlace(served, "placement")
      } else if (point !== null) {
        await lockRow(tx, sharedCollectionPoint, { companyId, id: point })
        refuseUnservedPlace(await findPublicPoint(tx, within, point), "public placement")
      }
      const [written] = await refuseOverlap({ [ALREADY_PLACED]: alreadyPlaced(into.label) }, () =>
        tx
          .insert(containerServicePlacement)
          .values({
            wasteFractionId: values.wasteFractionId,
            serviceFrequencyId: values.serviceFrequencyId,
            validFrom: values.validFrom,
            subscriptionId,
            sharedCollectionPointId: point,
            id: newId(),
            companyId,
            projectId: into.projectId,
            containerId: into.id,
          })
          .returning({ id: containerServicePlacement.id }),
      )
      return written.id
    },
    ...(says.occurredAt === undefined ? {} : { occurredAt: says.occurredAt }),
    ...(says.reference === undefined ? {} : { reference: says.reference }),
    at: says.at,
  })
  // An issue arrives at the placement `open` wrote, so the movement names it; a row that does not is a broken invariant, not a client's doing.
  if (movement.placementId === null) throw new Error(`the issue movement ${movement.id} of container ${into.id} names no placement`)
  return { ...movement, placementId: movement.placementId }
}
