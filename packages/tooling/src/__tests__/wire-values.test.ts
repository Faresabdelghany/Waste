// Specimens for the scan of values a wire module spells itself. The gate is
// exercised by its consumer, packages/contracts, against its real tree.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { findOwnValues } from "../wire-values"

const scan = (source: string) => findOwnValues([{ file: "x.ts", source }]).map((v) => [v.kind, v.line])

describe("findOwnValues", () => {
  test("finds a closed list: an array of strings, or strings handed to enum, exclude or extract", () => {
    assert.deepEqual(scan('export const S = z.enum(["active", "onboarding"])'), [["closed-list", 1]])
    assert.deepEqual(scan('export const R = Reason.exclude(["visit-voided"])'), [["closed-list", 1]])
    assert.deepEqual(scan('export const F = ["jpg", "png"] as const'), [["closed-list", 1]])
    assert.deepEqual(scan('export const W = z.enum([...OUTCOMES, "replayed"])'), [["closed-list", 1]])
  })

  test("finds a pattern: a regular expression literal, or a RegExp over a literal", () => {
    assert.deepEqual(scan("export const C = z.string().regex(/^[A-Z]{2}$/)"), [["pattern", 1]])
    assert.deepEqual(scan('export const C = new RegExp("^[A-Z]{2}$")'), [["pattern", 1]])
    assert.deepEqual(scan("export const C = new RegExp(`^${UUID}$`)"), [["pattern", 1]])
    assert.deepEqual(scan("export const C = z.string().regex(new RegExp(COUNTRY_PATTERN))"), [])
  })

  test("finds a bound: a number other than nothing or one", () => {
    assert.deepEqual(scan("export const L = z.string().min(1).max(200)"), [["bound", 1]])
    assert.deepEqual(scan("export const L = z.number().min(-90)"), [["bound", 1]])
    assert.deepEqual(scan("export const L = z.int().min(0).max(LABEL_MAX)"), [])
  })

  test("finds a sentence, in a refusal or a template, but not where a schema is documented", () => {
    assert.deepEqual(scan('export const A = { message: "Give at least one field to change" }'), [["sentence", 1]])
    assert.deepEqual(scan("export const T = (n: number) => `Ask for ${n} days at most`"), [["sentence", 1]])
    assert.deepEqual(scan('export const D = z.boolean().describe("Defaults to false when absent.")'), [])
    assert.deepEqual(scan('export const M = z.string().meta({ description: "A plate, as it is written." })'), [])
  })

  test("leaves the shape of a body alone: a field's name, a union's tag, a token, a type", () => {
    const source = [
      'export const P = { message: SENTENCE, path: ["sharedCollectionPointId"] }',
      'export const N = { message: SENTENCE, path: ["links", "pickupId"] }',
      'export const B = resourceBodies({ projectId: Id, code: Label, name: Label }, { keys: ["projectId", "code"] })',
      'export const U = z.object({ outcome: z.literal("refused"), status: z.union([z.literal(404), z.literal(409)]) })',
      'export const C = ctx.addIssue({ code: "custom", message: SENTENCE })',
      'export type K = "a b" | 404',
      'import { X } from "@waste/domain/text"',
      'export const Q = { "with space": 1 }',
    ].join("\n")
    assert.deepEqual(scan(source), [])
  })
})
