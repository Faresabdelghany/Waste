// A Property's tanks on the Pilot (M11 of #293): what the office reads of a
// tank, the day its next emptying is due as a sentence, who may read and write
// the register, and the bodies its two forms send.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { TANK_INSPECTION_OUTCOMES, TANK_KINDS, TANK_OUTLETS } from "@waste/domain/registry/vocabulary"

import {
  containersAtProperty,
  dueSentence,
  inspectionBodyOf,
  lastEmptyingSentence,
  litresOf,
  TANK_INSPECTION_OUTCOME_LABELS,
  TANK_KIND_LABELS,
  TANK_OUTLET_LABELS,
  tankBodyOf,
  tankSummary,
  tanksEditable,
  tanksReadable,
} from "../tanks"

const tank = { kind: "septic-tank" as const, volumeLitres: 3000, outlet: "soakaway" as const }

describe("a tank in words", () => {
  test("labels every kind, outlet and outcome the domain lists, and says a tank in one line", () => {
    assert.deepEqual(Object.keys(TANK_KIND_LABELS).sort(), [...TANK_KINDS].sort())
    assert.deepEqual(Object.keys(TANK_OUTLET_LABELS).sort(), [...TANK_OUTLETS].sort())
    assert.deepEqual(Object.keys(TANK_INSPECTION_OUTCOME_LABELS).sort(), [...TANK_INSPECTION_OUTCOMES].sort())
    assert.equal(tankSummary(tank), "Septic tank · 3,000 L · outlet to a soakaway")
    assert.equal(tankSummary({ kind: "holding-tank", volumeLitres: 6000, outlet: "none" }), "Holding tank · 6,000 L · no outlet")
  })

  test("says when the next emptying is due against the project's today: due now, overdue, today, or ahead", () => {
    assert.equal(dueSentence({ dueOn: null }, "2026-11-20"), "Due now: never emptied")
    assert.equal(dueSentence({ dueOn: "2026-10-05" }, "2026-11-20"), "Overdue since 2026-10-05")
    assert.equal(dueSentence({ dueOn: "2026-11-20" }, "2026-11-20"), "Due today")
    assert.equal(dueSentence({ dueOn: "2027-10-05" }, "2026-11-20"), "Next emptying due 2027-10-05")
  })

  test("names the last emptying: the stop's day and litres, the register's day before the platform, or none", () => {
    assert.equal(lastEmptyingSentence({ lastEmptying: { on: "2026-10-05", pickupId: "p", volumeLitres: 2800 }, lastEmptiedOn: "2025-12-01" }), "Last emptied 2026-10-05 · 2,800 L")
    assert.equal(lastEmptyingSentence({ lastEmptying: { on: "2026-10-05", pickupId: "p", volumeLitres: null }, lastEmptiedOn: null }), "Last emptied 2026-10-05")
    assert.equal(lastEmptyingSentence({ lastEmptying: null, lastEmptiedOn: "2025-12-01" }), "Last emptied 2025-12-01, before the platform")
    assert.equal(lastEmptyingSentence({ lastEmptying: null, lastEmptiedOn: null }), "Never emptied")
  })
})

describe("who reads and writes the register", () => {
  test("view on the properties reads it, edit writes it", () => {
    assert.equal(tanksReadable([{ moduleKey: "customers.properties", actions: ["view"] }]), true)
    assert.equal(tanksEditable([{ moduleKey: "customers.properties", actions: ["view"] }]), false)
    assert.equal(tanksEditable([{ moduleKey: "customers.properties", actions: ["view", "edit"] }]), true)
    assert.equal(tanksReadable(undefined), false)
  })
})

describe("the bodies the forms send", () => {
  const typed = { containerId: "c-1", kind: "septic-tank", volumeLitres: "3000", outlet: "soakaway", emptyingIntervalMonths: "12", lastEmptiedOn: "", validFrom: "2026-11-20", notes: "" }

  test("a tank: the litres and the months whole numbers, the last emptying and the notes only where given", () => {
    assert.deepEqual(tankBodyOf(typed, "prop-1"), { propertyId: "prop-1", containerId: "c-1", kind: "septic-tank", volumeLitres: 3000, outlet: "soakaway", emptyingIntervalMonths: 12, validFrom: "2026-11-20" })
    assert.deepEqual(tankBodyOf({ ...typed, lastEmptiedOn: "2025-12-01", notes: " Lid behind the shed " }, "prop-1"), {
      propertyId: "prop-1",
      containerId: "c-1",
      kind: "septic-tank",
      volumeLitres: 3000,
      outlet: "soakaway",
      emptyingIntervalMonths: 12,
      validFrom: "2026-11-20",
      lastEmptiedOn: "2025-12-01",
      notes: "Lid behind the shed",
    })
  })

  test("a tank refused at the field before the API: no container, no litres, months outside 1 to 120, a last emptying after the first day", () => {
    assert.deepEqual(tankBodyOf({ ...typed, containerId: "" }, "prop-1"), { path: "containerId", message: "Pick the container that stands for the tank" })
    assert.deepEqual(tankBodyOf({ ...typed, volumeLitres: "0" }, "prop-1"), { path: "volumeLitres", message: "What the tank holds, in whole litres" })
    for (const months of ["0", "121", "1.5", ""]) assert.deepEqual(tankBodyOf({ ...typed, emptyingIntervalMonths: months }, "prop-1"), { path: "emptyingIntervalMonths", message: "Between 1 and 120 whole months" }, months)
    assert.deepEqual(tankBodyOf({ ...typed, lastEmptiedOn: "2026-12-01" }, "prop-1"), { path: "lastEmptiedOn", message: "A last emptying before the platform comes before the tank's first day" })
  })

  test("an inspection: the day, the outcome, the findings and the next one where given; the next after the day", () => {
    assert.deepEqual(inspectionBodyOf({ inspectedOn: "2026-11-20", outcome: "remarks", findings: " Baffle cracked ", nextInspectionOn: "2027-11-20" }), { inspectedOn: "2026-11-20", outcome: "remarks", findings: "Baffle cracked", nextInspectionOn: "2027-11-20" })
    assert.deepEqual(inspectionBodyOf({ inspectedOn: "2026-11-20", outcome: "approved", findings: "", nextInspectionOn: "" }), { inspectedOn: "2026-11-20", outcome: "approved" })
    assert.deepEqual(inspectionBodyOf({ inspectedOn: "2026-11-20", outcome: "approved", findings: "", nextInspectionOn: "2026-11-20" }), { path: "nextInspectionOn", message: "The next inspection comes after this one" })
    assert.deepEqual(inspectionBodyOf({ inspectedOn: "", outcome: "approved", findings: "", nextInspectionOn: "" }), { path: "inspectedOn", message: "Pick the day the tank was inspected" })
  })

  test("the driver's litres: a whole positive number, or nothing", () => {
    assert.equal(litresOf("2800"), 2800)
    assert.equal(litresOf(" 2800 "), 2800)
    for (const value of ["", "0", "-1", "2.5", "abc", "1000000"]) assert.equal(litresOf(value), undefined, value)
  })
})

describe("the containers a tank may name", () => {
  test("those that serve the Property today, located or not yet, by label; another property's not", () => {
    const bin = (name: string, facts: Record<string, string>) => ({ id: name, name, status: "Available", facts }) as unknown as Parameters<typeof containersAtProperty>[0][number]
    const containers = [bin("TANK-2", { Property: "Skovvej 3" }), bin("TANK-1", { "Serves at": "Skovvej 3, not located yet" }), bin("BIN-9", { Property: "Skovvej 30" }), bin("BIN-8", {})]
    assert.deepEqual(containersAtProperty(containers, { name: "Skovvej 3" }).map((container) => container.name), ["TANK-1", "TANK-2"])
  })
})
