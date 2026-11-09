// Every whole number a body writes fits the `integer` column it lands in:
// zod's `int` stops at JavaScript's safe integers, far past Postgres's
// `integer`, and a number between the two would reach the database as 22003
// and come back a 500. The shared shapes are held at the bound here; then
// every write body of every module — a strict object, which is what a body
// is (resource.ts) — is walked, and each whole number in it must say so.
import assert from "node:assert/strict"
import path from "node:path"
import { describe, test } from "node:test"

import { INT4_MAX, INT4_MIN } from "@waste/domain/requests"
import { importShippingModules } from "@waste/tooling/program"

import { Int4, NonNegativeInt, NonNegativeMinor, NonNegativeTotal, PositiveInt } from "../resource"
import { ServiceProviderPriceIndex } from "../service-provider-prices"

describe("the shared whole numbers", () => {
  test("a positive and a non-negative one stop at the integer's bound, and a refusal names the bound", () => {
    for (const schema of [PositiveInt, NonNegativeInt, NonNegativeMinor]) {
      assert.equal(schema.safeParse(INT4_MAX).success, true)
      const refused = schema.safeParse(INT4_MAX + 1)
      assert.equal(refused.success, false)
      assert.match(refused.error?.issues[0]?.message ?? "", /2147483647/)
    }
  })

  test("a signed one holds both of the integer's bounds, and a report's sum, never written, holds neither", () => {
    assert.equal(Int4.safeParse(INT4_MIN).success, true)
    assert.equal(Int4.safeParse(INT4_MIN - 1).success, false)
    assert.equal(Int4.safeParse(INT4_MAX + 1).success, false)
    assert.equal(NonNegativeTotal.safeParse(INT4_MAX + 1).success, true)
  })

  test("an index's basis points are an integer of either sign", () => {
    const body = (basisPoints: number) => ({ label: "CPI", basisPoints, base: "bid", appliedFrom: "2026-07-01" })
    assert.equal(ServiceProviderPriceIndex.safeParse(body(-500)).success, true)
    assert.deepEqual(ServiceProviderPriceIndex.safeParse(body(INT4_MAX + 1)).error?.issues.map((issue) => issue.path.join(".")), ["basisPoints"])
  })
})

// A zod 4 schema by the little of it the walk reads: its definition's kind
// and the schemas it holds, and a number's bounds.
type Node = { def: Def; isInt?: boolean | null; minValue?: number | null; maxValue?: number | null }
type Def = {
  type: string
  shape?: Record<string, Node>
  catchall?: Node
  innerType?: Node
  in?: Node
  out?: Node
  element?: Node
  items?: Node[]
  options?: Node[]
  valueType?: Node
  left?: Node
  right?: Node
  getter?: () => Node
}

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && typeof (value as { def?: { type?: unknown } }).def?.type === "string"

/** Whether a schema, under its wrappers, is a strict object: a write body. */
function isBody(node: Node, depth = 0): boolean {
  if (depth > 16) return false
  const { def } = node
  if (def.type === "object") return def.catchall?.def.type === "never"
  // A union of bodies is a body: one of several shapes a request may take.
  if (def.type === "union") return (def.options ?? []).some((option) => isBody(option, depth + 1))
  const inner = def.innerType ?? def.in
  return inner !== undefined && isBody(inner, depth + 1)
}

function wholeNumbers(node: Node, path: string, seen = new Set<Node>()): { path: string; node: Node }[] {
  if (seen.has(node)) return []
  seen.add(node)
  const { def } = node
  if (def.type === "number") return node.isInt ? [{ path, node }] : []
  const children: [string, Node | undefined][] = [
    ...Object.entries(def.shape ?? {}).map(([key, child]) => [`${path}.${key}`, child] as [string, Node]),
    [path, def.innerType],
    [path, def.in],
    // A pipe's out side is what the value becomes, `.transform(Number).pipe(z.int())`'s integer included.
    [path, def.out],
    [`${path}[]`, def.element],
    ...(def.items ?? []).map((child, index) => [`${path}.${index}`, child] as [string, Node]),
    ...(def.options ?? []).map((child) => [path, child] as [string, Node]),
    [`${path}{}`, def.valueType],
    [path, def.left],
    [path, def.right],
    [path, def.getter?.()],
  ]
  return children.flatMap(([childPath, child]) => (child === undefined ? [] : wholeNumbers(child, childPath, seen)))
}

describe("every write body", () => {
  test("holds each whole number it takes to the integer's bounds, so none reaches the database as 22003", async () => {
    const modules = await importShippingModules(path.resolve(import.meta.dirname, "../.."))
    const unbounded: string[] = []
    let bodies = 0
    for (const [name, exported] of Object.entries(modules)) {
      for (const [exportName, value] of Object.entries(exported)) {
        if (!isNode(value) || !isBody(value)) continue
        bodies += 1
        for (const { path, node } of wholeNumbers(value, `${name}.${exportName}`)) {
          if ((node.maxValue ?? Infinity) > INT4_MAX || (node.minValue ?? -Infinity) < INT4_MIN) unbounded.push(path)
        }
      }
    }
    assert.ok(bodies > 50, `walked ${bodies} bodies`)
    assert.deepEqual(unbounded, [])
  })
})
