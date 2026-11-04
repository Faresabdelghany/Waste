// The tank register on the wire (M11 of #293): an installation's create and
// patch, and an inspection's create, each strict and held to its own rules.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { NEXT_INSPECTION_AFTER, TankInspectionCreate, TankInstallationCreate, TankInstallationPatch } from "../tanks"
import { ENDS_AFTER_IT_STARTS } from "../validity"
import { refusal } from "./expect"

const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const OTHER = "01a0d3a5-e5e0-7000-8000-000000000002"

const create = { propertyId: ID, containerId: OTHER, kind: "septic-tank", volumeLitres: 2_500, outlet: "soakaway", emptyingIntervalMonths: 12, validFrom: "2026-01-01" }

describe("TankInstallationCreate", () => {
  test("takes a tank at a Property by its container, what it is and holds, its outlet and its interval", () => {
    assert.deepEqual(TankInstallationCreate.parse(create), create)
    assert.deepEqual(TankInstallationCreate.parse({ ...create, lastEmptiedOn: "2025-06-01", notes: "Lid under the hedge", validTo: null }), { ...create, lastEmptiedOn: "2025-06-01", notes: "Lid under the hedge", validTo: null })
  })

  test("refuses a kind or an outlet off the lists, an interval outside 1 to 120 months, an empty tank, a period backwards and a member the server owns", () => {
    assert.deepEqual(refusal(TankInstallationCreate.safeParse({ ...create, kind: "cesspit" })).map((issue) => issue.path), ["kind"])
    assert.deepEqual(refusal(TankInstallationCreate.safeParse({ ...create, outlet: "river" })).map((issue) => issue.path), ["outlet"])
    for (const months of [0, 121, 1.5]) assert.deepEqual(refusal(TankInstallationCreate.safeParse({ ...create, emptyingIntervalMonths: months })).map((issue) => issue.path), ["emptyingIntervalMonths"], String(months))
    assert.deepEqual(refusal(TankInstallationCreate.safeParse({ ...create, volumeLitres: 0 })).map((issue) => issue.path), ["volumeLitres"])
    assert.deepEqual(refusal(TankInstallationCreate.safeParse({ ...create, validTo: "2026-01-01" })), [{ path: "validTo", message: ENDS_AFTER_IT_STARTS }])
    assert.match(refusal(TankInstallationCreate.safeParse({ ...create, dueOn: "2027-01-01" }))[0].message, /dueOn/, "the due date is a reading, never written")
  })
})

describe("TankInstallationPatch", () => {
  test("changes something, never the Property, the Container or the first day", () => {
    assert.deepEqual(TankInstallationPatch.parse({ emptyingIntervalMonths: 24 }), { emptyingIntervalMonths: 24 })
    assert.equal(TankInstallationPatch.safeParse({}).success, false)
    for (const member of ["propertyId", "containerId", "validFrom"]) assert.match(refusal(TankInstallationPatch.safeParse({ [member]: ID }))[0].message, new RegExp(member), member)
  })
})

describe("TankInspectionCreate", () => {
  test("takes the day, the outcome and what was found; the next inspection comes after it", () => {
    assert.deepEqual(TankInspectionCreate.parse({ inspectedOn: "2026-10-01", outcome: "remarks", findings: "Baffle cracked", nextInspectionOn: "2027-10-01" }), { inspectedOn: "2026-10-01", outcome: "remarks", findings: "Baffle cracked", nextInspectionOn: "2027-10-01" })
    assert.deepEqual(refusal(TankInspectionCreate.safeParse({ inspectedOn: "2026-10-01", outcome: "approved", nextInspectionOn: "2026-10-01" })), [{ path: "nextInspectionOn", message: NEXT_INSPECTION_AFTER }])
    assert.deepEqual(refusal(TankInspectionCreate.safeParse({ inspectedOn: "2026-10-01", outcome: "fine" })).map((issue) => issue.path), ["outcome"])
    assert.match(refusal(TankInspectionCreate.safeParse({ inspectedOn: "2026-10-01", outcome: "approved", recordedBy: ID }))[0].message, /recordedBy/, "the caller is the principal, not the body's word")
  })
})
