import assert from "node:assert/strict"
import { describe, test } from "node:test"

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

import {
  AllocationAction,
  AllocationStatus,
  AssetStatus,
  DepotOwnership,
  DepotStatus,
  DriverStatus,
  EmploymentType,
  FuelType,
  LicenceClass,
  StockMovementKind,
  StockPlaceKind,
  UnloadingStationOwnership,
  UnloadingStationStatus,
  VehicleKind,
  VehicleOwnership,
  VehicleStatus,
  WarehouseStatus,
} from "../resources"

describe("the Resources enums", () => {
  test("are the vocabulary the database checks against, value for value and in the same order", () => {
    assert.deepEqual(VehicleKind.options, [...VEHICLE_KINDS])
    assert.deepEqual(VehicleOwnership.options, [...VEHICLE_OWNERSHIPS])
    assert.deepEqual(VehicleStatus.options, [...VEHICLE_STATUSES])
    assert.deepEqual(FuelType.options, [...FUEL_TYPES])
    assert.deepEqual(LicenceClass.options, [...LICENCE_CLASSES])
    assert.deepEqual(EmploymentType.options, [...EMPLOYMENT_TYPES])
    assert.deepEqual(DriverStatus.options, [...DRIVER_STATUSES])
    assert.deepEqual(WarehouseStatus.options, [...WAREHOUSE_STATUSES])
    assert.deepEqual(DepotStatus.options, [...DEPOT_STATUSES])
    assert.deepEqual(UnloadingStationStatus.options, [...UNLOADING_STATION_STATUSES])
    assert.deepEqual(DepotOwnership.options, [...DEPOT_OWNERSHIPS])
    assert.deepEqual(UnloadingStationOwnership.options, [...UNLOADING_STATION_OWNERSHIPS])
    assert.deepEqual(StockMovementKind.options, [...STOCK_MOVEMENT_KINDS])
    assert.deepEqual(StockPlaceKind.options, [...STOCK_PLACE_KINDS])
    assert.deepEqual(AssetStatus.options, [...ASSET_STATUSES])
    assert.deepEqual(AllocationStatus.options, [...ALLOCATION_STATUSES])
    assert.deepEqual(AllocationAction.options, [...ALLOCATION_ACTIONS])
  })

  test("refuse the prototype's display strings and the readings that are never stored", () => {
    assert.equal(LicenceClass.safeParse("CE").success, false, "the web's uppercase tuple is not the wire's")
    assert.equal(VehicleKind.safeParse("Trailer").success, false)
    assert.equal(VehicleStatus.safeParse("on-route").success, false, "telemetry, never stored")
    assert.equal(AssetStatus.safeParse("in-transit").success, false, "a transfer arrives at once")
    assert.equal(AllocationStatus.safeParse("draft").success, false, "the prototype's Draft and Allocated are both planned")
    assert.equal(DriverStatus.safeParse("absent").success, false, "a dated window, later")
  })
})
