// Settings › Pre-trip checklists (O13 of #290): the rows become the body the
// API takes, a row it would refuse is refused here first in its sentence,
// and a row moves one place at a time.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CHECKLIST_MAX, EACH_ITEM_ONCE, VehicleTypeChecklistSet } from "@waste/contracts/pre-trip"

import { checklistBodyOf, checklistChanged, checklistRowsOf, LABEL_SENTENCE, movedRow, ONCE_SENTENCE, TOO_MANY_SENTENCE } from "../pre-trip-checklists"

const row = (key: string, label: string, critical = true) => ({ key, label, critical })

describe("checklistBodyOf", () => {
  test("is the rows in order, labels trimmed, each with its weight, and the contract takes it", () => {
    const body = checklistBodyOf([row("a", " Brakes "), row("b", "Lights", false)])
    assert.deepEqual(body, {
      items: [
        { label: "Brakes", critical: true },
        { label: "Lights", critical: false },
      ],
    })
    assert.equal(VehicleTypeChecklistSet.safeParse(body).success, true)
  })

  test("refuses a blank item, an item twice whatever its case, and a list past the cap, at the row", () => {
    assert.deepEqual(checklistBodyOf([row("a", "Brakes"), row("b", "  ")]), { index: 1, message: LABEL_SENTENCE })
    assert.deepEqual(checklistBodyOf([row("a", "Brakes"), row("b", "brakes")]), { index: 1, message: ONCE_SENTENCE })
    const many = Array.from({ length: CHECKLIST_MAX + 1 }, (_, index) => row(String(index), `Item ${index}`))
    assert.deepEqual(checklistBodyOf(many), { index: CHECKLIST_MAX, message: TOO_MANY_SENTENCE })
  })

  test("says what the contract says of an item twice", () => {
    assert.equal(ONCE_SENTENCE, EACH_ITEM_ONCE)
  })
})

describe("movedRow and checklistChanged", () => {
  test("a row moves one place, and not past either end", () => {
    const rows = [row("a", "A"), row("b", "B"), row("c", "C")]
    assert.deepEqual(
      movedRow(rows, 2, -1).map((moved) => moved.key),
      ["a", "c", "b"],
    )
    assert.deepEqual(
      movedRow(rows, 0, -1).map((moved) => moved.key),
      ["a", "b", "c"],
    )
  })

  test("a change is a label, a weight, an order or a count other than the API holds", () => {
    const saved = [
      { id: "a", label: "Brakes", critical: true },
      { id: "b", label: "Lights", critical: false },
    ]
    assert.equal(checklistChanged(checklistRowsOf(saved), saved), false)
    assert.equal(checklistChanged([row("a", "Brakes"), row("b", "Lights")], saved), true)
    assert.equal(checklistChanged([row("b", "Lights", false), row("a", "Brakes")], saved), true)
    assert.equal(checklistChanged(checklistRowsOf(saved).slice(1), saved), true)
  })
})
