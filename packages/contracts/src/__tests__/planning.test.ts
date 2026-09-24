import assert from "node:assert/strict"
import { describe, test } from "node:test"

import {
  HOLIDAY_POLICIES,
  PLANNING_AREA_PURPOSES,
  RECURRENCE_FREQUENCIES,
  ROUTE_SCHEME_STATUSES,
  SCHEME_EDIT_POLICIES,
  SERVICE_DAYS,
  SERVICE_TYPES,
  STOP_MATCH_VEHICLE_TYPES,
  STOP_SOURCES,
  WEEK_ROTATIONS,
} from "@waste/domain/planning/vocabulary"

import {
  EACH_DAY_ONCE,
  eachOnce,
  HolidayPolicy,
  PlanningAreaPurpose,
  RecurrenceFrequency,
  RouteSchemeStatus,
  SchemeEditPolicy,
  ServiceDay,
  ServiceDays,
  ServiceType,
  StopMatchVehicleType,
  StopSource,
  WeekRotation,
} from "../planning"
import { refusal } from "./expect"

describe("the planning enums", () => {
  test("are the vocabulary the database checks against, value for value and in the same order", () => {
    assert.deepEqual(ServiceDay.options, [...SERVICE_DAYS])
    assert.deepEqual(RecurrenceFrequency.options, [...RECURRENCE_FREQUENCIES])
    assert.deepEqual(WeekRotation.options, [...WEEK_ROTATIONS])
    assert.deepEqual(HolidayPolicy.options, [...HOLIDAY_POLICIES])
    assert.deepEqual(SchemeEditPolicy.options, [...SCHEME_EDIT_POLICIES])
    assert.deepEqual(ServiceType.options, [...SERVICE_TYPES])
    assert.deepEqual(StopSource.options, [...STOP_SOURCES])
    assert.deepEqual(StopMatchVehicleType.options, [...STOP_MATCH_VEHICLE_TYPES])
    assert.deepEqual(RouteSchemeStatus.options, [...ROUTE_SCHEME_STATUSES])
    assert.deepEqual(PlanningAreaPurpose.options, [...PLANNING_AREA_PURPOSES])
  })

  test("refuse the prototype's display strings and the readings that are never stored", () => {
    assert.equal(ServiceType.safeParse("Container collection").success, false, "the web's display tuple is not the wire's")
    assert.equal(StopMatchVehicleType.safeParse("Rear loader").success, false)
    assert.equal(ServiceDay.safeParse("Monday").success, false)
    for (const reading of ["scheduled", "effective", "expired"]) assert.equal(RouteSchemeStatus.safeParse(reading).success, false, reading)
  })
})

describe("eachOnce", () => {
  test("is the one distinct-entries rule of Planning's modules: by the entry itself, or by a key", () => {
    assert.equal(eachOnce(["monday", "tuesday"]), true)
    assert.equal(eachOnce(["monday", "monday"]), false)
    assert.equal(eachOnce([]), true)
    assert.equal(eachOnce([{ day: "2026-06-05" }, { day: "2026-06-05" }], (holiday) => holiday.day), false)
    assert.equal(eachOnce([{ day: "2026-06-05" }, { day: "2026-12-24" }], (holiday) => holiday.day), true)
  })
})

describe("ServiceDays", () => {
  test("is a set of weekdays, each named at most once, possibly none", () => {
    assert.deepEqual(ServiceDays.parse(["monday", "thursday"]), ["monday", "thursday"])
    assert.deepEqual(ServiceDays.parse([]), [])
    assert.deepEqual(ServiceDays.parse([...SERVICE_DAYS]), [...SERVICE_DAYS])
  })

  test("refuses a day twice, at the set, with its sentence", () => {
    assert.deepEqual(refusal(ServiceDays.safeParse(["monday", "monday"])), [{ path: "", message: EACH_DAY_ONCE }])
    assert.deepEqual(refusal(ServiceDays.safeParse(["funday"])).map((issue) => issue.path), ["0"])
  })
})
