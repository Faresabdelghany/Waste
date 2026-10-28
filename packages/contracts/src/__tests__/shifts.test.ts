import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BREAK_FITS, BREAK_WINDOW_NEEDS_MINUTES, BREAK_WITHIN_SHIFT, SHIFT_ENDS_AFTER_IT_STARTS, WINDOW_CLOSES_AFTER_IT_OPENS } from "@waste/domain/execution/shift"

import { AgreementPatch } from "../agreements"
import { PropertyPatch } from "../customers"
import { DriverPatch } from "../fleet"
import { DriverShift, TimeWindow } from "../shifts"

const refusal = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.success ? [] : (result.error?.issues ?? []).map((issue) => ({ path: issue.path.join("."), message: issue.message }))

const shift = { from: "07:00", to: "15:00", breakMinutes: 30, breakWindow: { from: "11:00", to: "12:30" } }

describe("TimeWindow (O14 of #290)", () => {
  test("is two times of one day, the second after the first, and nothing else", () => {
    assert.deepEqual(TimeWindow.parse({ from: "07:00", to: "10:00" }), { from: "07:00", to: "10:00" })
    assert.deepEqual(refusal(TimeWindow.safeParse({ from: "22:00", to: "06:00" })), [{ path: "to", message: WINDOW_CLOSES_AFTER_IT_OPENS }])
    assert.equal(TimeWindow.safeParse({ from: "07:00:00", to: "10:00" }).success, false, "no seconds")
    assert.equal(TimeWindow.safeParse({ from: "07:00", to: "10:00", days: [] }).success, false, "strict")
  })

  test("is a property's and an agreement's service window, written whole or cleared with null", () => {
    assert.deepEqual(PropertyPatch.parse({ serviceWindow: null }), { serviceWindow: null })
    assert.deepEqual(AgreementPatch.parse({ serviceWindow: { from: "08:00", to: "14:00" } }), { serviceWindow: { from: "08:00", to: "14:00" } })
    assert.deepEqual(refusal(PropertyPatch.safeParse({ serviceWindow: { from: "14:00", to: "08:00" } })), [{ path: "serviceWindow.to", message: WINDOW_CLOSES_AFTER_IT_OPENS }])
  })
})

describe("DriverShift", () => {
  test("is a shift with its one break, or without one", () => {
    assert.deepEqual(DriverShift.parse(shift), shift)
    assert.equal(DriverShift.safeParse({ ...shift, breakMinutes: null, breakWindow: null }).success, true)
    assert.deepEqual(DriverPatch.parse({ shift: null }), { shift: null })
  })

  test("holds the domain's rules at the member that is wrong, each told once", () => {
    assert.deepEqual(refusal(DriverShift.safeParse({ ...shift, to: "06:00" })), [{ path: "to", message: SHIFT_ENDS_AFTER_IT_STARTS }])
    assert.deepEqual(refusal(DriverShift.safeParse({ ...shift, breakMinutes: null })), [{ path: "breakMinutes", message: BREAK_WINDOW_NEEDS_MINUTES }])
    assert.deepEqual(refusal(DriverShift.safeParse({ ...shift, breakWindow: { from: "12:30", to: "11:00" } })), [{ path: "breakWindow", message: WINDOW_CLOSES_AFTER_IT_OPENS }])
    assert.deepEqual(refusal(DriverShift.safeParse({ ...shift, breakWindow: { from: "14:00", to: "16:00" } })), [{ path: "breakWindow", message: BREAK_WITHIN_SHIFT }])
    assert.deepEqual(refusal(DriverShift.safeParse({ ...shift, breakMinutes: 120 })), [{ path: "breakMinutes", message: BREAK_FITS }])
    assert.deepEqual(refusal(DriverPatch.safeParse({ shift: { ...shift, to: "06:00" } })), [{ path: "shift.to", message: SHIFT_ENDS_AFTER_IT_STARTS }])
  })

  test("bounds the break's minutes", () => {
    assert.equal(DriverShift.safeParse({ ...shift, breakMinutes: 0 }).success, false)
    assert.equal(DriverShift.safeParse({ ...shift, breakWindow: null, breakMinutes: 241 }).success, false)
    assert.equal(DriverShift.safeParse({ ...shift, breakMinutes: 30.5 }).success, false)
  })
})
