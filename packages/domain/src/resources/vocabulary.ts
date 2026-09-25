// Resources' closed lists (Issue #101): what a vehicle, a driver, a place, a
// movement and an allocation may be. Like the Registry's and Planning's
// (registry/vocabulary.ts, planning/vocabulary.ts), the database reads each
// list into its `CHECK` (`oneOf` in packages/db/src/schema/checks.ts) and the
// contracts read the same list into a `z.enum`, so the check at the API
// boundary and the check in the column cannot drift.
//
// Two lists are the glossary's verbatim: `STOCK_MOVEMENT_KINDS`, the six kinds
// of Stock Movement, and `ASSET_STATUSES`, the four states a Container Asset
// State folds onto — a container with no movement yet has no state, which is
// `null` on the wire and not a fifth value here. `STOCK_PLACE_KINDS` is where
// a movement comes from and goes to; a supplier and scrap have no row of their
// own, and maintenance is a place kind at a warehouse, not a table (#101 §6).
// `LICENCE_CLASSES` is lowest first, as route-schemes/fleet-profiles.ts orders
// its display tuple, and lowercase because every value here is a kebab token;
// resources/licence.ts spells the implication between them. The statuses of a
// depot and of an unloading station are the same four, so
// `UNLOADING_STATION_STATUSES` is `DEPOT_STATUSES` under a second name — one
// tuple, two readers — which is why the walking test counts seventeen names
// over sixteen lists.
//
// A value is a kebab-case token: it goes into a migration as a SQL literal
// and onto the wire as an enum member, and those are the same string. A list
// is a `readonly` tuple with a type read off it; `RESOURCES_VOCABULARIES`
// names them all for the test that walks them.

/** A vehicle drives itself or is towed: the prototype's `resourceKind`. */
export const VEHICLE_KINDS = ["powered-vehicle", "trailer"] as const
/** Whose vehicle it is. */
export const VEHICLE_OWNERSHIPS = ["company", "service-provider", "leased"] as const
/** The vehicle's lifecycle; "on route" and "position stale" are telemetry, never stored. */
export const VEHICLE_STATUSES = ["active", "unavailable", "maintenance", "retired"] as const
/** What the vehicle runs on. */
export const FUEL_TYPES = ["diesel", "hvo", "biogas", "electric", "hybrid", "other"] as const
/** The licence classes a driver may hold and a vehicle may require, lowest first: `ce` covers `c` covers `b`. */
export const LICENCE_CLASSES = ["b", "c", "ce"] as const
/** How the driver is employed. */
export const EMPLOYMENT_TYPES = ["employee", "service-provider", "temporary"] as const
/** The driver's lifecycle; "invited" is the account's and "absent" a dated window, which arrives later. */
export const DRIVER_STATUSES = ["active", "inactive", "suspended"] as const
/** Whether the warehouse takes and issues stock. */
export const WAREHOUSE_STATUSES = ["draft", "active", "restricted", "closed"] as const
/** Whether the depot is in use; `seasonal` is a depot that opens for part of the year. */
export const DEPOT_STATUSES = ["draft", "active", "seasonal", "closed"] as const
/** The same four as a depot's: one tuple, two readers. */
export const UNLOADING_STATION_STATUSES = DEPOT_STATUSES
/** Whose depot it is. */
export const DEPOT_OWNERSHIPS = ["company", "service-provider"] as const
/** Whose unloading station it is; an incineration plant the company delivers to is `external`. */
export const UNLOADING_STATION_OWNERSHIPS = ["company", "service-provider", "external"] as const
/** The glossary's six kinds of Stock Movement, verbatim. */
export const STOCK_MOVEMENT_KINDS = ["receipt", "issue", "return", "transfer", "adjustment", "decommission"] as const
/** Where a movement comes from and goes to; a supplier and scrap have no row, maintenance is at a warehouse, service is a placement. */
export const STOCK_PLACE_KINDS = ["supplier", "warehouse", "maintenance", "service", "scrap"] as const
/** The glossary's four states of a Container Asset State; a container with no movement has none. */
export const ASSET_STATUSES = ["in-warehouse", "in-service", "in-maintenance", "retired"] as const
/** Where a vehicle allocation stands; the prototype's Draft and Allocated are both `planned`. */
export const ALLOCATION_STATUSES = ["planned", "confirmed", "released"] as const
/** What was done to an allocation, each appending one event: the prototype's `allocationAction`, verbatim. */
export const ALLOCATION_ACTIONS = ["allocate", "change", "confirm", "release"] as const

/**
 * The places a container stands in while in stock — a warehouse, or
 * maintenance at one — and the places an adjustment may leave it in: in
 * stock, or scrapped, the correction door for a wrong decommission, never in
 * service. Not vocabularies but values of one, like Planning's
 * `DEFAULT_WEEKEND`: the shape table (resources/asset-state.ts) and the
 * command bodies (@waste/contracts/stock) are both built from them, so the
 * pairs a command may ask for and the pairs the ledger allows cannot drift.
 */
export const STOCK_PLACES = ["warehouse", "maintenance"] as const satisfies readonly (typeof STOCK_PLACE_KINDS)[number][]
export const ADJUSTMENT_TARGETS = ["warehouse", "maintenance", "scrap"] as const satisfies readonly (typeof STOCK_PLACE_KINDS)[number][]

export type VehicleKind = (typeof VEHICLE_KINDS)[number]
export type VehicleOwnership = (typeof VEHICLE_OWNERSHIPS)[number]
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number]
export type FuelType = (typeof FUEL_TYPES)[number]
export type LicenceClass = (typeof LICENCE_CLASSES)[number]
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number]
export type DriverStatus = (typeof DRIVER_STATUSES)[number]
export type WarehouseStatus = (typeof WAREHOUSE_STATUSES)[number]
export type DepotStatus = (typeof DEPOT_STATUSES)[number]
export type UnloadingStationStatus = (typeof UNLOADING_STATION_STATUSES)[number]
export type DepotOwnership = (typeof DEPOT_OWNERSHIPS)[number]
export type UnloadingStationOwnership = (typeof UNLOADING_STATION_OWNERSHIPS)[number]
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number]
export type StockPlaceKind = (typeof STOCK_PLACE_KINDS)[number]
export type AssetStatus = (typeof ASSET_STATUSES)[number]
export type AllocationStatus = (typeof ALLOCATION_STATUSES)[number]
export type AllocationAction = (typeof ALLOCATION_ACTIONS)[number]

/** Every list of this module by its name, for a test that walks them and for a reader looking for the whole vocabulary at once. */
export const RESOURCES_VOCABULARIES = {
  VEHICLE_KINDS,
  VEHICLE_OWNERSHIPS,
  VEHICLE_STATUSES,
  FUEL_TYPES,
  LICENCE_CLASSES,
  EMPLOYMENT_TYPES,
  DRIVER_STATUSES,
  WAREHOUSE_STATUSES,
  DEPOT_STATUSES,
  UNLOADING_STATION_STATUSES,
  DEPOT_OWNERSHIPS,
  UNLOADING_STATION_OWNERSHIPS,
  STOCK_MOVEMENT_KINDS,
  STOCK_PLACE_KINDS,
  ASSET_STATUSES,
  ALLOCATION_STATUSES,
  ALLOCATION_ACTIONS,
} as const satisfies Record<string, readonly [string, ...string[]]>
