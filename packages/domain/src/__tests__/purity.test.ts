// ADR-0002 made mechanical: everything under packages/domain/src must be
// pure, deterministic logic that bundles into the browser and runs on the
// server alike. This test fails the build on imports of React, Next,
// MapLibre, the web app (`@/`, `@waste/web`), the fixture registry
// (`business-modules`), Node built-ins outside `__tests__/`, relative imports
// that leave the package, and on browser globals in source text.
//
// The allowances below are the whole exception list. Add to them only with a
// reason a reviewer can check.
import assert from "node:assert/strict"
import { describe, test } from "node:test"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  findPurityViolations,
  readSources,
  type PurityAllowance,
  type SourceFile,
} from "./purity-scan"

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

const ALLOWANCES: PurityAllowance[] = [
  {
    file: "__tests__/purity.test.ts",
    reason: "holds the banned specimens the scanner is tested against",
  },
  {
    file: "__tests__/purity-scan.ts",
    reason: "defines the banned patterns as text",
  },
]

function scan(file: string, source: string, allowances: PurityAllowance[] = []) {
  const files: SourceFile[] = [{ file, source }]
  return findPurityViolations(files, allowances)
}

describe("findPurityViolations: imports", () => {
  const forbidden: Array<[label: string, statement: string]> = [
    ["react", 'import { useMemo } from "react"'],
    ["react-dom", 'import { createPortal } from "react-dom"'],
    ["next", 'import { redirect } from "next/navigation"'],
    ["maplibre-gl", 'import maplibregl from "maplibre-gl"'],
    ["the @/ alias", 'import { x } from "@/lib/data/business-modules"'],
    ["the web app package", 'import { x } from "@waste/web/lib/anything"'],
    ["the fixture registry by relative path", 'import type { BusinessRecord } from "../data/business-modules"'],
  ]
  for (const [label, statement] of forbidden) {
    test(`flags an import of ${label}`, () => {
      const violations = scan("route-schemes/x.ts", `${statement}\nexport const y = 1\n`)
      assert.equal(violations.length, 1, JSON.stringify(violations))
      assert.equal(violations[0].rule, "forbidden-import")
      assert.equal(violations[0].line, 1)
    })
  }

  test("flags a dynamic import and a require of a forbidden module", () => {
    const source = [
      "export async function load() {",
      '  const nav = await import("next/navigation")',
      '  const dom = require("react-dom")',
      "  return [nav, dom]",
      "}",
    ].join("\n")
    const violations = scan("x.ts", source)
    assert.deepEqual(
      violations.map((v) => [v.rule, v.line]),
      [
        ["forbidden-import", 2],
        ["forbidden-import", 3],
      ],
    )
  })

  test("flags a side-effect import of a forbidden module", () => {
    const violations = scan("x.ts", 'import "maplibre-gl/dist/maplibre-gl.css"\n')
    assert.equal(violations.length, 1)
    assert.equal(violations[0].rule, "forbidden-import")
  })

  test("flags a relative import that leaves the package", () => {
    const violations = scan("route-schemes/x.ts", 'import { y } from "../../../apps/web/lib/y"\n')
    assert.equal(violations.length, 1, JSON.stringify(violations))
    assert.equal(violations[0].rule, "escapes-package")
  })

  test("accepts a relative import that stays inside the package", () => {
    const source = [
      'import { isSoftDeleted } from "../record-visibility"',
      'import { addDays } from "./recurrence"',
      "export const z = [isSoftDeleted, addDays]",
    ].join("\n")
    assert.deepEqual(scan("route-schemes/x.ts", source), [])
  })

  test("flags a Node built-in outside __tests__", () => {
    const violations = scan("hash.ts", 'import { createHash } from "node:crypto"\n')
    assert.equal(violations.length, 1, JSON.stringify(violations))
    assert.equal(violations[0].rule, "node-import")
  })

  test("accepts node:test and node:assert inside __tests__", () => {
    const source = [
      'import assert from "node:assert/strict"',
      'import { test } from "node:test"',
      'import { addDays } from "../recurrence"',
      "test(\"x\", () => assert.ok(addDays))",
    ].join("\n")
    assert.deepEqual(scan("route-schemes/__tests__/x.test.ts", source), [])
  })
})

describe("findPurityViolations: browser globals", () => {
  const forbidden: Array<[label: string, statement: string]> = [
    ["window.", "const w = window.innerWidth"],
    ["document.", "const el = document.getElementById(\"x\")"],
    ["navigator.", "const lang = navigator.language"],
    ["localStorage", "const raw = localStorage.getItem(\"k\")"],
    ["sessionStorage", "sessionStorage.clear()"],
    ["fetch(", "const res = await fetch(url)"],
  ]
  for (const [label, statement] of forbidden) {
    test(`flags ${label}`, () => {
      const violations = scan("x.ts", `export const a = 1\n${statement}\n`)
      assert.equal(violations.length, 1, JSON.stringify(violations))
      assert.equal(violations[0].rule, "browser-global")
      assert.equal(violations[0].line, 2)
    })
  }

  test("does not flag prose that ends a sentence with the word window", () => {
    const source = "// Schemes outside the run window. Auto-runs skip them.\nexport const a = 1\n"
    assert.deepEqual(scan("x.ts", source), [])
  })

  test("does not flag an identifier that merely contains a banned word", () => {
    const source = "const occurrenceWindow = { from: 1 }\nexport const b = occurrenceWindow.from\n"
    assert.deepEqual(scan("x.ts", source), [])
  })
})

describe("findPurityViolations: allowances", () => {
  test("an allowance for a rule suppresses only that rule in that file", () => {
    const source = 'import { x } from "react"\nconst w = window.innerWidth\n'
    const allowances: PurityAllowance[] = [{ file: "x.ts", rule: "browser-global", reason: "specimen" }]
    const violations = scan("x.ts", source, allowances)
    assert.deepEqual(violations.map((v) => v.rule), ["forbidden-import"])
  })

  test("an allowance without a rule suppresses every rule in that file only", () => {
    const source = 'import { x } from "react"\nconst w = window.innerWidth\n'
    const allowances: PurityAllowance[] = [{ file: "x.ts", reason: "specimen" }]
    assert.deepEqual(scan("x.ts", source, allowances), [])
    assert.equal(scan("y.ts", source, allowances).length, 2)
  })
})

describe("packages/domain/src", () => {
  test("contains only .ts sources the scanner can read", () => {
    const files = readSources(SRC_DIR)
    assert.ok(files.length > 20, `expected the moved modules, found ${files.length} files`)
    assert.ok(files.every((f) => f.file.endsWith(".ts")))
    assert.ok(files.some((f) => f.file === "__tests__/purity.test.ts"))
  })

  test("imports nothing from the web app, React, Next, MapLibre, Node, or the browser", () => {
    const violations = findPurityViolations(readSources(SRC_DIR), ALLOWANCES)
    const report = violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.detail}`).join("\n")
    assert.deepEqual(violations, [], `\n${report}\n`)
  })
})
