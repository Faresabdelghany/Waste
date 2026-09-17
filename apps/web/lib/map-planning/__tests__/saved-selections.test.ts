import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { emptyBusinessFilters } from "@waste/domain/business-filters"
import {
  addSavedSelection,
  parseSavedSelections,
  removeSavedSelection,
  renameSavedSelection,
  serializeSavedSelections,
  type SavedSelection,
} from "../saved-selections"

const square = [
  { lng: 12.5, lat: 55.6 },
  { lng: 12.6, lat: 55.6 },
  { lng: 12.6, lat: 55.7 },
  { lng: 12.5, lat: 55.7 },
]

const saved: SavedSelection = {
  id: "sel-1",
  name: "Vesterbro west",
  shape: { kind: "rectangle", polygon: square },
  filters: { ...emptyBusinessFilters, wasteFractions: ["Organic"] },
  window: "next-7",
  createdAt: "2026-09-16T12:00:00.000Z",
}

describe("parseSavedSelections", () => {
  test("nothing stored, or garbage, is an empty list", () => {
    assert.deepEqual(parseSavedSelections(null), [])
    assert.deepEqual(parseSavedSelections("not json"), [])
    assert.deepEqual(parseSavedSelections(JSON.stringify({ selections: "nope" })), [])
  })

  test("a serialized list round-trips", () => {
    assert.deepEqual(parseSavedSelections(serializeSavedSelections([saved])), [saved])
  })

  test("a malformed entry is dropped; an unknown window or shape kind falls back", () => {
    const raw = JSON.stringify({
      selections: [
        { ...saved, id: "no-name", name: "  " },
        { ...saved, id: "two-points", shape: { kind: "polygon", polygon: square.slice(0, 2) } },
        { ...saved, id: "odd", window: "next-99", shape: { kind: "circle", polygon: square }, filters: undefined },
        "string",
      ],
    })
    const parsed = parseSavedSelections(raw)
    assert.deepEqual(parsed.map((entry) => entry.id), ["odd"])
    assert.equal(parsed[0].window, "any")
    assert.equal(parsed[0].shape.kind, "polygon")
    assert.deepEqual(parsed[0].filters, emptyBusinessFilters)
  })
})

describe("saved selection list edits", () => {
  test("adding trims the name, stamps id and time, and appends; a blank name adds nothing", () => {
    const next = addSavedSelection([saved], { name: "  Amager south ", shape: saved.shape, filters: emptyBusinessFilters, window: "any" }, { id: "sel-2", now: "2026-09-16T13:00:00.000Z" })
    assert.equal(next.length, 2)
    assert.deepEqual(next[1], { id: "sel-2", name: "Amager south", shape: saved.shape, filters: emptyBusinessFilters, window: "any", createdAt: "2026-09-16T13:00:00.000Z" })
    assert.deepEqual(addSavedSelection([saved], { name: "   ", shape: saved.shape, filters: emptyBusinessFilters, window: "any" }, { id: "x", now: "" }), [saved])
  })

  test("renaming trims and keeps the rest; a blank name changes nothing; removing drops by id", () => {
    assert.equal(renameSavedSelection([saved], "sel-1", " Vesterbro ")[0].name, "Vesterbro")
    assert.deepEqual(renameSavedSelection([saved], "sel-1", "  "), [saved])
    assert.deepEqual(removeSavedSelection([saved], "sel-1"), [])
    assert.deepEqual(removeSavedSelection([saved], "other"), [saved])
  })
})
