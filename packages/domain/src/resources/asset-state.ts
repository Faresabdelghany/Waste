// The fold of a Stock Movement onto a Container Asset State (Issue #101,
// ADR-0003): the state is a projection over the ledger, never written, and
// this module is the one spelling of what the latest movement says about
// where the container is. The database's query (packages/db/src/query/
// asset-state.ts) and the API's commands both read from here.
//
// `assetStateOf` maps the place a movement arrived at onto the glossary's four
// states: a warehouse is `in-warehouse`, maintenance at a warehouse
// `in-maintenance`, a service placement `in-service`, scrap `retired`. A
// supplier is where a receipt comes from and nowhere a container arrives, so
// it maps onto no state; the shape rule below keeps it out of `to_kind`.
//
// `movementShape` is the table of pairs a kind allows — receipt from a
// supplier into a warehouse, issue from stock into service, return the other
// way, transfer between warehouses and workshops, decommission from anywhere
// to scrap, and adjustment, the correction door, between any two places that
// are not a service placement. The database spells the same table as
// `stock_movement_kind_shape` (packages/db/src/schema/stock.ts), and a test
// there runs every pair through both, so the API refuses a nonsense command
// with a sentence before the check does with a code. `MOVEMENT_SHAPES` is the
// table as data, for that test and for a form that offers only the pairs a
// kind allows.
import { STOCK_PLACE_KINDS, type AssetStatus, type StockMovementKind, type StockPlaceKind } from "./vocabulary"

/** What each place a movement can arrive at says about the container's state; a supplier is never arrived at. */
export const ASSET_STATUS_OF_PLACE: Readonly<Record<Exclude<StockPlaceKind, "supplier">, AssetStatus>> = {
  warehouse: "in-warehouse",
  maintenance: "in-maintenance",
  service: "in-service",
  scrap: "retired",
}

/** The state the container is in after this movement, read off where it arrived; null for a supplier, which nothing arrives at. */
export function assetStateOf(movement: { toKind: StockPlaceKind }): AssetStatus | null {
  return movement.toKind === "supplier" ? null : ASSET_STATUS_OF_PLACE[movement.toKind]
}

/** The places a container stands in while in stock: a warehouse, or maintenance at one. */
export const STOCK_PLACES = ["warehouse", "maintenance"] as const satisfies readonly StockPlaceKind[]

/** The places an adjustment may leave a container in: in stock, or scrapped (the correction door for a wrong decommission); never in service. */
export const ADJUSTMENT_TARGETS = ["warehouse", "maintenance", "scrap"] as const satisfies readonly StockPlaceKind[]

/** For each kind, where it comes from and where it goes to. */
export type MovementShape = { readonly from: readonly StockPlaceKind[]; readonly to: readonly StockPlaceKind[] }

/** The pairs each kind allows: the one table the database's `stock_movement_kind_shape` spells too. */
export const MOVEMENT_SHAPES: Readonly<Record<StockMovementKind, MovementShape>> = {
  receipt: { from: ["supplier"], to: ["warehouse"] },
  issue: { from: STOCK_PLACES, to: ["service"] },
  return: { from: ["service"], to: STOCK_PLACES },
  transfer: { from: STOCK_PLACES, to: STOCK_PLACES },
  decommission: { from: [...STOCK_PLACES, "service"], to: ["scrap"] },
  adjustment: { from: STOCK_PLACE_KINDS.filter((place) => place !== "service"), to: ADJUSTMENT_TARGETS },
}

/** Whether a movement of this kind may go from `fromKind` to `toKind`. */
export function movementShape(kind: StockMovementKind, fromKind: StockPlaceKind, toKind: StockPlaceKind): boolean {
  const shape = MOVEMENT_SHAPES[kind]
  return shape.from.includes(fromKind) && shape.to.includes(toKind)
}
