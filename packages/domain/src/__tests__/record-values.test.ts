import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { EMPTY_FACT, cleanFact, typedString, uniform } from "../record-values"

describe("cleanFact", () => {
  test("trims a display fact and treats the em-dash placeholder as absent", () => {
    assert.equal(EMPTY_FACT, "—")
    assert.equal(cleanFact("  Ryesgade 45 "), "Ryesgade 45")
    assert.equal(cleanFact("—"), undefined)
    assert.equal(cleanFact(" — "), undefined)
    assert.equal(cleanFact(""), undefined)
    assert.equal(cleanFact("   "), undefined)
    assert.equal(cleanFact(undefined), undefined)
  })

  test("a typed boolean is not a fact", () => {
    assert.equal(cleanFact(true), undefined)
    assert.equal(cleanFact(false), undefined)
  })
})

describe("typedString", () => {
  test("reads a trimmed string value; blanks, booleans and missing keys are undefined", () => {
    const values = { projectId: " project-copenhagen ", blank: "   ", flag: true }
    assert.equal(typedString(values, "projectId"), "project-copenhagen")
    assert.equal(typedString(values, "blank"), undefined)
    assert.equal(typedString(values, "flag"), undefined)
    assert.equal(typedString(values, "missing"), undefined)
  })

  test("a record without typed values reads as nothing", () => {
    assert.equal(typedString(undefined, "projectId"), undefined)
  })
})

describe("uniform", () => {
  test("the one value every entry agrees on", () => {
    assert.equal(uniform(["a", "a", "a"]), "a")
    assert.equal(uniform([7]), 7)
  })

  test("disagreement, a missing entry, or nothing at all is undefined", () => {
    assert.equal(uniform(["a", "b"]), undefined)
    assert.equal(uniform(["a", undefined, "a"]), undefined)
    assert.equal(uniform([]), undefined)
  })

  test("an empty string is a value like any other — callers clean first", () => {
    assert.equal(uniform(["", ""]), "")
    assert.equal(uniform(["", "a"]), undefined)
  })
})
