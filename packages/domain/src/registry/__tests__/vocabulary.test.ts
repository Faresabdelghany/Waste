// The Registry vocabulary is read by the database check (`oneOf`) and by the
// contracts enum (`z.enum`), so there is no second spelling to hold in
// lockstep and nothing here compares two lists. What is held is the shape every
// list has to keep: a value is a kebab-case token, because it is written into a
// migration as a SQL literal and onto the wire as a zod enum member, and a list
// with a duplicate or a gap would put one of the two somewhere it does not
// belong. The module's lists are found by their shape rather than by name, so a
// list exported and left out of `REGISTRY_VOCABULARIES` — which is what lets
// the API, a form or another test walk them all — fails here.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import * as vocabulary from "../vocabulary"

/** A value of any list: lowercase words joined by single hyphens, nothing else. */
const TOKEN = /^[a-z]+(-[a-z]+)*$/

/** Every list the module exports, by shape: the tuples, and not the object that names them. */
const exported = Object.entries<unknown>(vocabulary).filter((entry): entry is [string, readonly string[]] => Array.isArray(entry[1]))
const named: Record<string, readonly string[]> = vocabulary.REGISTRY_VOCABULARIES

describe("the Registry vocabulary", () => {
  test("every list has values, each a kebab-case token, and names none of them twice", () => {
    for (const [name, values] of exported) {
      assert.ok(values.length > 0, `${name} is empty`)
      for (const value of values) assert.match(value, TOKEN, `${name} has "${value}"`)
      assert.equal(new Set(values).size, values.length, `${name} spells a value twice`)
    }
  })

  test("REGISTRY_VOCABULARIES names exactly the twenty lists the module exports, each the list itself", () => {
    assert.deepEqual(
      Object.keys(named).sort(),
      exported.map(([name]) => name).sort(),
    )
    for (const [name, values] of exported) assert.equal(named[name], values, `${name} is not the list the module exports`)
    assert.equal(exported.length, 20)
  })
})
