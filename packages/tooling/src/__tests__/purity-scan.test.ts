// Specimens for the scanner and the manifest check. The gate itself
// (definePurityTests) is exercised by its consumers: packages/domain and
// packages/contracts each run it against their real tree.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { manifestProblems, type PackageManifest } from "../purity"
import { findPurityViolations, packageNameOf, type PurityAllowance, type PurityScanOptions } from "../purity-scan"

const TEST_PACKAGES: PurityScanOptions = { allowedTestPackages: ["typescript"] }

function scan(file: string, source: string, options: PurityScanOptions = TEST_PACKAGES) {
  return findPurityViolations([{ file, source }], options)
}

describe("findPurityViolations: bare imports", () => {
  const bare: Array<[label: string, statement: string]> = [
    ["react", 'import { useMemo } from "react"'],
    ["next", 'import { redirect } from "next/navigation"'],
    ["maplibre-gl", 'import maplibregl from "maplibre-gl"'],
    ["the @/ alias into apps/web", 'import { x } from "@/lib/data/business-modules"'],
    ["the web app package", 'import { x } from "@waste/web/lib/anything"'],
    ["any other package", 'import { z } from "zod"'],
    ["a Node built-in", 'import { createHash } from "node:crypto"'],
    ["a Node built-in without the prefix", 'import { readFileSync } from "fs"'],
    ["a type-only import", 'import type { FC } from "react"'],
    ["a re-export", 'export { useMemo } from "react"'],
  ]
  for (const [label, statement] of bare) {
    test(`flags ${label} in shipping code`, () => {
      const violations = scan("route-schemes/x.ts", `${statement}\nexport const y = 1\n`)
      assert.equal(violations.length, 1, JSON.stringify(violations))
      assert.equal(violations[0].rule, "bare-import")
      assert.equal(violations[0].line, 1)
    })
  }

  test("flags a side-effect import", () => {
    const violations = scan("x.ts", 'import "maplibre-gl/dist/maplibre-gl.css"\n')
    assert.deepEqual(violations.map((v) => [v.rule, v.line]), [["bare-import", 1]])
  })

  test("flags a dynamic import and a require with literal specifiers", () => {
    const source = [
      "export async function load() {",
      '  const nav = await import("next/navigation")',
      '  const dom = require("react-dom")',
      "  return [nav, dom]",
      "}",
    ].join("\n")
    assert.deepEqual(
      scan("x.ts", source).map((v) => [v.rule, v.line]),
      [
        ["bare-import", 2],
        ["bare-import", 3],
      ],
    )
  })

  test("reports the line of the specifier in a wrapped import", () => {
    const source = ["import {", "  useMemo,", "} from", '  "react"', "export const y = useMemo"].join("\n")
    assert.deepEqual(scan("x.ts", source).map((v) => [v.rule, v.line]), [["bare-import", 4]])
  })

  test("ignores import-shaped text in comments and strings", () => {
    const source = [
      '// copied from "react" in spirit; see import("next/x") for the idea',
      '/* import { a } from "maplibre-gl" */',
      'export const label = `from "@/lib"`',
      'export const other = "require(\\"fs\\")"',
    ].join("\n")
    assert.deepEqual(scan("x.ts", source), [])
  })

  test("accepts Node built-ins and the listed test packages inside __tests__", () => {
    const source = [
      'import assert from "node:assert/strict"',
      'import { test } from "node:test"',
      'import { isBuiltin } from "module"',
      'import ts from "typescript"',
      'import { addDays } from "../recurrence"',
      'test("x", () => assert.ok([addDays, ts, isBuiltin]))',
    ].join("\n")
    assert.deepEqual(scan("route-schemes/__tests__/x.test.ts", source), [])
  })

  test("flags any other package inside __tests__", () => {
    const violations = scan("route-schemes/__tests__/x.test.ts", 'import { z } from "zod"\n')
    assert.deepEqual(violations.map((v) => v.rule), ["bare-import"])
  })

  test("with no test packages listed, tests may add Node built-ins only", () => {
    const source = 'import { test } from "node:test"\nimport ts from "typescript"\ntest("x", () => ts)\n'
    const violations = scan("__tests__/x.test.ts", source, {})
    assert.deepEqual(violations.map((v) => [v.rule, v.line]), [["bare-import", 2]])
    assert.match(violations[0].detail, /Node built-ins$/)
  })
})

describe("findPurityViolations: allowed packages", () => {
  const options: PurityScanOptions = { allowedPackages: ["zod"], allowedTestPackages: ["@waste/tooling"] }

  test("an allowed package may be imported by shipping code, by root and by subpath", () => {
    const source = 'import { z } from "zod"\nimport * as v4 from "zod/v4"\nexport const s = [z, v4]\n'
    assert.deepEqual(scan("geojson.ts", source, options), [])
  })

  test("an allowed package may be imported by tests too, and so may the test packages", () => {
    const source = [
      'import { z } from "zod"',
      'import { definePurityTests } from "@waste/tooling/purity"',
      "export const s = [z, definePurityTests]",
    ].join("\n")
    assert.deepEqual(scan("__tests__/x.test.ts", source, options), [])
  })

  test("a test package is not thereby allowed in shipping code", () => {
    const violations = scan("ids.ts", 'import { definePurityTests } from "@waste/tooling/purity"\n', options)
    assert.deepEqual(violations.map((v) => v.rule), ["bare-import"])
    assert.match(violations[0].detail, /may import only zod/)
  })

  test("every other package is still flagged", () => {
    const violations = scan("ids.ts", 'import { useMemo } from "react"\n', options)
    assert.deepEqual(violations.map((v) => v.rule), ["bare-import"])
  })
})

describe("findPurityViolations: relative imports", () => {
  test("flags a relative import that leaves the package", () => {
    const violations = scan("route-schemes/x.ts", 'import { y } from "../../../apps/web/lib/y"\n')
    assert.deepEqual(violations.map((v) => v.rule), ["escapes-package"])
  })

  test("flags a relative import that leaves the package from the top level", () => {
    const violations = scan("x.ts", 'import type { R } from "../../apps/web/lib/data/business-modules"\n')
    assert.deepEqual(violations.map((v) => v.rule), ["escapes-package"])
  })

  test("accepts relative imports that stay inside the package", () => {
    const source = [
      'import { isSoftDeleted } from "../record-visibility"',
      'import { addDays } from "./recurrence"',
      'export type { X } from "./types"',
      "export const z = [isSoftDeleted, addDays]",
    ].join("\n")
    assert.deepEqual(scan("route-schemes/x.ts", source), [])
  })
})

describe("findPurityViolations: computed specifiers", () => {
  test("flags a dynamic import whose specifier is not a string literal", () => {
    const source = ["export async function load(name: string) {", "  return import(`./${name}`)", "}"].join("\n")
    assert.deepEqual(scan("x.ts", source).map((v) => [v.rule, v.line]), [["computed-import", 2]])
  })

  test("flags a require whose specifier is not a string literal", () => {
    const source = ["export function load(name: string) {", "  return require(name)", "}"].join("\n")
    assert.deepEqual(scan("x.ts", source).map((v) => [v.rule, v.line]), [["computed-import", 2]])
  })

  test("accepts a template literal without substitutions as a plain specifier", () => {
    const source = "export const p = import(`./recurrence`)\n"
    assert.deepEqual(scan("x.ts", source), [])
  })
})

describe("findPurityViolations: allowances", () => {
  const source = 'import { x } from "react"\nimport { y } from "../../apps/web/y"\n'

  test("an allowance for a rule suppresses only that rule in that file", () => {
    const allowances: PurityAllowance[] = [{ file: "x.ts", rule: "escapes-package", reason: "specimen" }]
    assert.deepEqual(scan("x.ts", source, { allowances }).map((v) => v.rule), ["bare-import"])
  })

  test("an allowance without a rule suppresses every rule in that file only", () => {
    const allowances: PurityAllowance[] = [{ file: "x.ts", reason: "specimen" }]
    assert.deepEqual(scan("x.ts", source, { allowances }), [])
    assert.equal(scan("y.ts", source, { allowances }).length, 2)
  })
})

describe("packageNameOf", () => {
  test("strips subpaths and keeps scopes", () => {
    assert.equal(packageNameOf("zod"), "zod")
    assert.equal(packageNameOf("zod/v4"), "zod")
    assert.equal(packageNameOf("@waste/tooling/purity"), "@waste/tooling")
    assert.equal(packageNameOf("node:fs/promises"), "node:fs")
  })
})

describe("manifestProblems", () => {
  const good: PackageManifest = {
    name: "@waste/contracts",
    exports: { "./package.json": "./package.json", "./__tests__/*": null, "./*": "./src/*.ts" },
    dependencies: { zod: "^4.6.5" },
    devDependencies: { "@waste/tooling": "workspace:*" },
  }
  const options = { allowedPackages: ["zod"], allowedTestPackages: ["@waste/tooling"] }

  test("a manifest in order has no problems", () => {
    assert.deepEqual(manifestProblems(good, ["__tests__"], options), [])
  })

  test("dependencies must be exactly the allowed packages, in either direction", () => {
    const extra = manifestProblems({ ...good, dependencies: { zod: "^4", react: "^19" } }, ["__tests__"], options)
    assert.equal(extra.length, 1)
    assert.match(extra[0], /declared \[react, zod\], allowed \[zod\]/)
    const missing = manifestProblems({ ...good, dependencies: {} }, ["__tests__"], options)
    assert.match(missing[0], /declared \[\], allowed \[zod\]/)
    const none = manifestProblems({ ...good, dependencies: undefined }, ["__tests__"], { allowedPackages: [] })
    assert.deepEqual(none.filter((p) => p.startsWith("dependencies")), [])
  })

  test("an allowed test package must be a devDependency", () => {
    const problems = manifestProblems({ ...good, devDependencies: {} }, ["__tests__"], options)
    assert.deepEqual(problems, ['tests may import "@waste/tooling", so it must be a devDependency'])
  })

  test("source is exported by subpath alongside the manifest", () => {
    const problems = manifestProblems({ ...good, exports: { "./*": "./dist/*.js" } }, [], options)
    assert.equal(problems.length, 2, problems.join("\n"))
  })

  test("every __tests__ directory is hidden with a null export", () => {
    const problems = manifestProblems(good, ["__tests__", "route-schemes/__tests__"], options)
    assert.deepEqual(problems, ['exports["./route-schemes/__tests__/*"] must be null to hide the tests from consumers'])
  })
})
