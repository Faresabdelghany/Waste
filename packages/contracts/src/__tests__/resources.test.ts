import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { AllocationStatus, AssetStatus, DriverStatus, LicenceClass, VehicleKind, VehicleStatus } from "../resources"

describe("the Resources enums", () => {
  test("refuse the prototype's display strings and the readings that are never stored", () => {
    assert.equal(LicenceClass.safeParse("CE").success, false, "the web's uppercase tuple is not the wire's")
    assert.equal(VehicleKind.safeParse("Trailer").success, false)
    assert.equal(VehicleStatus.safeParse("on-route").success, false, "telemetry, never stored")
    assert.equal(AssetStatus.safeParse("in-transit").success, false, "a transfer arrives at once")
    assert.equal(AllocationStatus.safeParse("draft").success, false, "the prototype's Draft and Allocated are both planned")
    assert.equal(DriverStatus.safeParse("absent").success, false, "a dated window, later")
  })
})
