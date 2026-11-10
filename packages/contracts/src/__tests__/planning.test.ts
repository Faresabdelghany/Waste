import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { eachOnce } from "@waste/domain/requests"

import { EACH_DAY_ONCE, SERVICE_DAYS } from "@waste/domain/planning/vocabulary"

import { RouteSchemeStatus, ServiceDay, ServiceDays, ServiceType } from "../planning"
import { refusal } from "./expect"

describe("the planning enums", () => {
  test("refuse the prototype's display strings and the readings that are never stored", () => {
    assert.equal(ServiceType.safeParse("Container collection").success, false, "the web's display tuple is not the wire's")
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
