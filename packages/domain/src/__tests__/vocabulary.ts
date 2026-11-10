// What every vocabulary module of this package is held to, spelled once: the
// Registry's (registry/vocabulary.ts) and Planning's (planning/vocabulary.ts)
// each had a copy of these two tests, and the copies had drifted on whether a
// token may carry a digit (`every-2-weeks` is a legitimate token). A list is
// read by the database check (`oneOf`, `subsetOf`) and by the contracts enum
// (`z.enum`), so there is no second spelling to hold in lockstep and nothing
// here compares two lists. What is held is the shape every list has to keep:
// a value is a kebab-case token, because it is written into a migration as a
// SQL literal and onto the wire as a zod enum member, and a list with a
// duplicate or a gap would put one of the two somewhere it does not belong.
// The module's lists are found by their shape rather than by name, so a list
// exported and left out of the naming object — which is what lets the API, a
// form or another test walk them all — fails here; an array the module exports
// that is a value of a vocabulary and not a vocabulary (`DEFAULT_WEEKEND`) is
// named in `beside` with the list it is drawn from, and held to being some of
// that list's values, so a list leaves the walk only by a test naming where
// it comes from.
//
// Not a suite of its own: the runner takes `src/**/*.test.ts`, so this file is
// only ever imported.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

/** A value of any list: lowercase words of letters and digits joined by single hyphens, nothing else. */
export const TOKEN = /^[a-z0-9]+(-[a-z0-9]+)*$/

/**
 * Registers the two tests for one vocabulary module: `module` read as a
 * namespace, `named` its naming object, `beside` the arrays it exports that
 * are not lists, each with the name of the list it is drawn from.
 */
export function defineVocabularyTests(context: string, module: Record<string, unknown>, named: Record<string, readonly string[]>, beside: Readonly<Record<string, string>> = {}): void {
  const exported = Object.entries(module).filter((entry): entry is [string, readonly string[]] => Array.isArray(entry[1]) && !(entry[0] in beside))

  describe(`the ${context} vocabulary`, () => {
    test("every list has values, each a kebab-case token, and names none of them twice", () => {
      for (const [name, values] of exported) {
        assert.ok(values.length > 0, `${name} is empty`)
        for (const value of values) assert.match(value, TOKEN, `${name} has "${value}"`)
        assert.equal(new Set(values).size, values.length, `${name} spells a value twice`)
      }
    })

    test("the naming object names exactly the lists the module exports, each the list itself, and what is beside them is drawn from the list it names", () => {
      assert.deepEqual(
        Object.keys(named).sort(),
        exported.map(([name]) => name).sort(),
      )
      for (const [name, values] of exported) assert.equal(named[name], values, `${name} is not the list the module exports`)
      for (const [name, from] of Object.entries(beside)) {
        const values = module[name]
        assert.ok(Array.isArray(values), `${name} is named beside the lists but the module exports no such array`)
        assert.ok(values.length > 0, `${name} is empty`)
        assert.ok(from in named, `${name} is drawn from ${from}, which the naming object does not name`)
        const outside = (values as string[]).filter((value) => !named[from].includes(value))
        assert.deepEqual(outside, [], `${name} is named beside the lists as drawn from ${from}, but has values of its own: name it in the vocabulary`)
      }
    })
  })
}
