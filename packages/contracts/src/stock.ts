// The container ledger on the wire (Issue #101, ADR-0003): the Stock
// Movement, the Container Asset State it folds onto, and the five commands
// that append to it. A ledger row spreads `recorded` (its id and the instant
// it was appended) and not `stamped`: it is never updated, so it has no
// `updatedAt` to carry.
//
// A movement says one container went from one place to another — a
// supplier, a warehouse, maintenance at a warehouse, a service placement,
// scrap — when (`occurredAt`, on the person's word), why and on whose word.
// The Asset State is a reading of the latest movement in recording order and
// never a table: `AssetState` is what a Container carries as `assetState`,
// null for a container with no movement yet (`containers.ts`).
//
// The commands are bodies of `POST /containers/:id/<command>`, each a strict
// object saying only what the caller may: never the container (the path's),
// the project (the container's), the kind (the route's) or where the
// container comes from (the ledger's, read under the container's row lock).
// `issue` has no body here: it is `POST /containers/:id/placements`, the
// Registry's route and the one door into service. `return` and `transfer`
// arrive in stock, at a warehouse or in maintenance at one (`STOCK_PLACES`);
// `adjust`, the correction door, may leave a container in stock or scrapped
// (`ADJUSTMENT_TARGETS`) and names a warehouse exactly when it is not scrap;
// neither may put a container into service. Both lists are the vocabulary's,
// which the domain's `MOVEMENT_SHAPES` is built from too, so what a command
// may ask for and what the ledger allows cannot drift.
import { ADJUSTMENT_TARGETS, STOCK_PLACES } from "@waste/domain/resources/vocabulary"
import * as z from "zod"

import { IsoDate, IsoDateTime } from "./dates"
import { Id } from "./ids"
import { ProjectScopedListQuery } from "./queries"
import { recorded } from "./resource"
import { AssetStatus, StockMovementKind, StockPlaceKind } from "./resources"
import { Label, Paragraph } from "./text"

/** A place in stock: a warehouse, or maintenance at one. */
export const StockPlace = z.enum(STOCK_PLACES)
export type StockPlace = z.infer<typeof StockPlace>

/** Where an adjustment may leave a container: in stock, or scrapped; never in service. */
export const AdjustmentTarget = z.enum(ADJUSTMENT_TARGETS)
export type AdjustmentTarget = z.infer<typeof AdjustmentTarget>

/** The reading a Container carries: where its latest movement left it, and which movement that was. */
export const AssetState = z.object({
  status: AssetStatus,
  /** The warehouse it stands in, in stock or in maintenance; null in service or retired. */
  warehouseId: Id.nullable(),
  /** The placement it serves at; null unless in service. */
  placementId: Id.nullable(),
  /** When the latest movement happened, on the person's word. */
  since: IsoDateTime,
  /** The latest movement, in recording order. */
  movementId: Id,
})
export type AssetState = z.infer<typeof AssetState>

export const StockMovement = z.object({
  ...recorded,
  projectId: Id,
  containerId: Id,
  kind: StockMovementKind,
  fromKind: StockPlaceKind,
  fromWarehouseId: Id.nullable(),
  toKind: StockPlaceKind,
  toWarehouseId: Id.nullable(),
  /** The placement an issue opened or a return or decommission closed. */
  placementId: Id.nullable(),
  /** When it happened, on the person's word; evidence, never the order the ledger is folded in. */
  occurredAt: IsoDateTime,
  /** The account that recorded it. */
  recordedBy: Id,
  reason: Paragraph.nullable(),
  /** A delivery note, a ticket. */
  reference: Label.nullable(),
  /** The movement an adjustment corrects, if it corrects one. */
  correctsMovementId: Id.nullable(),
})
export type StockMovement = z.infer<typeof StockMovement>

/** What every command may say about when it happened: absent is the request's clock, and later than that is refused by the route. */
const occurred = {
  occurredAt: IsoDateTime.optional(),
}

/** `POST /containers/:id/receive`: a container with no record arrives from a supplier into a warehouse. */
export const Receive = z.strictObject({
  warehouseId: Id,
  ...occurred,
  reference: Label.optional(),
})
export type Receive = z.infer<typeof Receive>

/** `POST /containers/:id/return`: out of service into stock, ending the placement on `validTo`. */
export const Return = z.strictObject({
  warehouseId: Id,
  toKind: StockPlace.default("warehouse").describe("Defaults to warehouse when absent: back into stock; maintenance is the workshop at the warehouse."),
  /** The first day the placement no longer serves. */
  validTo: IsoDate,
  ...occurred,
  reason: Paragraph.optional(),
  reference: Label.optional(),
})
export type Return = z.infer<typeof Return>

/** `POST /containers/:id/transfer`: from one place in stock to another, recorded on arrival. */
export const Transfer = z.strictObject({
  warehouseId: Id,
  toKind: StockPlace.default("warehouse").describe("Defaults to warehouse when absent; maintenance is the workshop at the warehouse."),
  ...occurred,
  reason: Paragraph.optional(),
  reference: Label.optional(),
})
export type Transfer = z.infer<typeof Transfer>

/** `POST /containers/:id/decommission`: to scrap, from stock or from service — and then `validTo` ends the placement, which the route requires. */
export const Decommission = z.strictObject({
  /** Required when the container is in service, refused when it is not: the route knows which. */
  validTo: IsoDate.optional(),
  ...occurred,
  reason: Paragraph,
  reference: Label.optional(),
})
export type Decommission = z.infer<typeof Decommission>

/** What an adjustment naming a warehouse for scrap, or none for a place in stock, is told. */
export const WAREHOUSE_WITH_A_STOCK_PLACE = "Name the warehouse with warehouse or maintenance and not with scrap"
const warehouseWithAStockPlace = { message: WAREHOUSE_WITH_A_STOCK_PLACE, path: ["warehouseId"] }

/** `POST /containers/:id/adjust`: the correction door, never into or out of service. */
export const Adjust = z
  .strictObject({
    toKind: AdjustmentTarget,
    /** The warehouse arrived at, exactly when the target is not scrap. */
    warehouseId: Id.optional(),
    reason: Paragraph,
    /** The movement this one corrects, one of this container's. */
    correctsMovementId: Id.optional(),
    ...occurred,
  })
  .refine((body) => (body.toKind !== "scrap") === (body.warehouseId !== undefined), warehouseWithAStockPlace)
export type Adjust = z.infer<typeof Adjust>

/** What a window whose end comes before its start is told. */
export const OCCURRED_WINDOW_ORDERED = "to is the end of the window, so it comes on or after from"

/** A page of movements across containers: one project's, one container's, through one warehouse on either side, of one kind, over a window of `occurredAt`. */
export const StockMovementListQuery = ProjectScopedListQuery.extend({
  containerId: Id.optional(),
  /** Movements that left from or arrived at this warehouse. */
  warehouseId: Id.optional(),
  kind: StockMovementKind.optional(),
  /** The first instant of the window over `occurredAt`, inclusive. */
  from: IsoDateTime.optional(),
  /** The last instant, inclusive. */
  to: IsoDateTime.optional(),
}).refine((query) => query.from === undefined || query.to === undefined || Date.parse(query.to) >= Date.parse(query.from), { message: OCCURRED_WINDOW_ORDERED, path: ["to"] })
export type StockMovementListQuery = z.infer<typeof StockMovementListQuery>
