// Resources' closed lists at the API boundary (Issue #101): each of
// @waste/domain/resources/vocabulary's tuples turned into the `z.enum` the
// routes validate against, so an unknown token never reaches a `CHECK` that
// would refuse it as a 500 naming nothing. Shared here because five modules
// read them — `vehicle-types.ts` none of them yet, `places.ts` the statuses
// and ownerships of the three places, `fleet.ts` the vehicle's and the
// driver's, `stock.ts` the ledger's kinds and the asset status, and
// `allocations.ts` the allocation's — and `containers.ts` reads the asset
// status onto the Registry's Container.
import {
  ALLOCATION_ACTIONS,
  ALLOCATION_STATUSES,
  ASSET_STATUSES,
  DEPOT_OWNERSHIPS,
  DEPOT_STATUSES,
  DRIVER_STATUSES,
  EMPLOYMENT_TYPES,
  FUEL_TYPES,
  LICENCE_CLASSES,
  STOCK_MOVEMENT_KINDS,
  STOCK_PLACE_KINDS,
  UNLOADING_STATION_OWNERSHIPS,
  UNLOADING_STATION_STATUSES,
  VEHICLE_KINDS,
  VEHICLE_OWNERSHIPS,
  VEHICLE_STATUSES,
  WAREHOUSE_STATUSES,
} from "@waste/domain/resources/vocabulary"
import * as z from "zod"

/** A powered vehicle or a trailer. */
export const VehicleKind = z.enum(VEHICLE_KINDS)
export type VehicleKind = z.infer<typeof VehicleKind>

/** Whose vehicle it is. */
export const VehicleOwnership = z.enum(VEHICLE_OWNERSHIPS)
export type VehicleOwnership = z.infer<typeof VehicleOwnership>

/** The vehicle's lifecycle; "on route" and "position stale" are telemetry, never sent. */
export const VehicleStatus = z.enum(VEHICLE_STATUSES)
export type VehicleStatus = z.infer<typeof VehicleStatus>

/** What the vehicle runs on. */
export const FuelType = z.enum(FUEL_TYPES)
export type FuelType = z.infer<typeof FuelType>

/** A licence class a driver holds or a vehicle requires: `b`, `c`, `ce`, lowest first. */
export const LicenceClass = z.enum(LICENCE_CLASSES)
export type LicenceClass = z.infer<typeof LicenceClass>

/** How the driver is employed. */
export const EmploymentType = z.enum(EMPLOYMENT_TYPES)
export type EmploymentType = z.infer<typeof EmploymentType>

/** The driver's lifecycle. */
export const DriverStatus = z.enum(DRIVER_STATUSES)
export type DriverStatus = z.infer<typeof DriverStatus>

/** Whether the warehouse takes and issues stock. */
export const WarehouseStatus = z.enum(WAREHOUSE_STATUSES)
export type WarehouseStatus = z.infer<typeof WarehouseStatus>

/** Whether the depot is in use. */
export const DepotStatus = z.enum(DEPOT_STATUSES)
export type DepotStatus = z.infer<typeof DepotStatus>

/** Whether the unloading station is in use: the same four as a depot's. */
export const UnloadingStationStatus = z.enum(UNLOADING_STATION_STATUSES)
export type UnloadingStationStatus = z.infer<typeof UnloadingStationStatus>

/** Whose depot it is. */
export const DepotOwnership = z.enum(DEPOT_OWNERSHIPS)
export type DepotOwnership = z.infer<typeof DepotOwnership>

/** Whose unloading station it is; the plant the company delivers to is `external`. */
export const UnloadingStationOwnership = z.enum(UNLOADING_STATION_OWNERSHIPS)
export type UnloadingStationOwnership = z.infer<typeof UnloadingStationOwnership>

/** The glossary's six kinds of Stock Movement. */
export const StockMovementKind = z.enum(STOCK_MOVEMENT_KINDS)
export type StockMovementKind = z.infer<typeof StockMovementKind>

/** Where a movement comes from and goes to. */
export const StockPlaceKind = z.enum(STOCK_PLACE_KINDS)
export type StockPlaceKind = z.infer<typeof StockPlaceKind>

/** The glossary's four states of a Container Asset State; a container with no movement has none, which is null on the wire. */
export const AssetStatus = z.enum(ASSET_STATUSES)
export type AssetStatus = z.infer<typeof AssetStatus>

/** Where a vehicle allocation stands. */
export const AllocationStatus = z.enum(ALLOCATION_STATUSES)
export type AllocationStatus = z.infer<typeof AllocationStatus>

/** What was done to an allocation, each appending one event. */
export const AllocationAction = z.enum(ALLOCATION_ACTIONS)
export type AllocationAction = z.infer<typeof AllocationAction>
