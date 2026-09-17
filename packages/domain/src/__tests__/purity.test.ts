// ADR-0002 made mechanical. Everything under packages/domain/src must be
// pure, deterministic logic that bundles into the browser and runs on the
// server alike. Two gates enforce it:
//
// 1. The compiler. tsconfig.json gives shipping code `lib: ["esnext"]` and
//    `types: []`, so window, document, localStorage, fetch, process and
//    Buffer are not even names there. The last tests below prove that holds.
// 2. This scanner. The package depends on nothing, so every import in
//    shipping code must be relative and stay inside src/; tests may add Node
//    built-ins and the packages listed in purity-scan.ts. Specifiers come
//    from the TypeScript AST, not from regexes, so comments and strings
//    cannot fool it and computed `import(x)` is caught as such.
//
// ALLOWANCES is the whole exception list. Add to it only with a reason a
// reviewer can check. It is empty on purpose.
import assert from "node:assert/strict"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, test } from "node:test"
import { fileURLToPath } from "node:url"
import ts from "typescript"

import {
  findPurityViolations,
  readSources,
  type PurityAllowance,
  type SourceFile,
} from "./purity-scan"

const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const PKG_DIR = path.resolve(SRC_DIR, "..")

const ALLOWANCES: PurityAllowance[] = []

function scan(file: string, source: string, allowances: PurityAllowance[] = []) {
  const files: SourceFile[] = [{ file, source }]
  return findPurityViolations(files, allowances)
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
      "/* import { a } from \"maplibre-gl\" */",
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
      "test(\"x\", () => assert.ok([addDays, ts, isBuiltin]))",
    ].join("\n")
    assert.deepEqual(scan("route-schemes/__tests__/x.test.ts", source), [])
  })

  test("flags any other package inside __tests__", () => {
    const violations = scan("route-schemes/__tests__/x.test.ts", 'import { z } from "zod"\n')
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
  test("an allowance for a rule suppresses only that rule in that file", () => {
    const source = 'import { x } from "react"\nimport { y } from "../../apps/web/y"\n'
    const allowances: PurityAllowance[] = [{ file: "x.ts", rule: "escapes-package", reason: "specimen" }]
    assert.deepEqual(scan("x.ts", source, allowances).map((v) => v.rule), ["bare-import"])
  })

  test("an allowance without a rule suppresses every rule in that file only", () => {
    const source = 'import { x } from "react"\nimport { y } from "../../apps/web/y"\n'
    const allowances: PurityAllowance[] = [{ file: "x.ts", reason: "specimen" }]
    assert.deepEqual(scan("x.ts", source, allowances), [])
    assert.equal(scan("y.ts", source, allowances).length, 2)
  })
})

describe("packages/domain/src", () => {
  test("holds only .ts files, so nothing escapes the compiler, the linter, or this scan", () => {
    const files = readSources(SRC_DIR)
    assert.ok(files.length > 20, `expected the moved modules, found ${files.length} files`)
    assert.ok(files.some((f) => f.file === "__tests__/purity.test.ts"))
    const strays = files.filter((f) => !f.file.endsWith(".ts")).map((f) => f.file)
    assert.deepEqual(strays, [], `only .ts files belong under src/: ${strays.join(", ")}`)
  })

  test("imports nothing but itself", () => {
    const violations = findPurityViolations(readSources(SRC_DIR), ALLOWANCES)
    const report = violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.detail}`).join("\n")
    assert.deepEqual(violations, [], `\n${report}\n`)
  })
})

describe("packages/domain/package.json", () => {
  const manifest = JSON.parse(readFileSync(path.join(PKG_DIR, "package.json"), "utf8")) as {
    exports: Record<string, string | null>
    dependencies?: Record<string, string>
  }

  test("declares no runtime dependencies", () => {
    assert.equal(manifest.dependencies, undefined)
  })

  test("exports source by subpath and its own manifest", () => {
    assert.equal(manifest.exports["./*"], "./src/*.ts")
    assert.equal(manifest.exports["./package.json"], "./package.json")
  })

  test("hides every __tests__ directory from consumers", () => {
    const testDirs: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        if (!statSync(full).isDirectory()) continue
        if (entry === "__tests__") testDirs.push(path.relative(SRC_DIR, full).split(path.sep).join("/"))
        else walk(full)
      }
    }
    walk(SRC_DIR)
    assert.ok(testDirs.length >= 2)
    for (const dir of testDirs) {
      assert.equal(manifest.exports[`./${dir}/*`], null, `exports["./${dir}/*"] must be null`)
    }
  })
})

describe("packages/domain tsconfig", () => {
  const shipping = ts.parseJsonConfigFileContent(
    ts.readConfigFile(path.join(PKG_DIR, "tsconfig.json"), ts.sys.readFile).config,
    ts.sys,
    PKG_DIR,
  )
  const tests = ts.parseJsonConfigFileContent(
    ts.readConfigFile(path.join(PKG_DIR, "tsconfig.test.json"), ts.sys.readFile).config,
    ts.sys,
    PKG_DIR,
  )
  const relativeTo = (fileNames: readonly string[]) =>
    new Set(fileNames.map((f) => path.relative(SRC_DIR, f).split(path.sep).join("/")))
  const sources = readSources(SRC_DIR).map((f) => f.file)
  const isTest = (file: string) => file.split("/").includes("__tests__")

  test("the shipping config covers every module and none of the tests", () => {
    const covered = relativeTo(shipping.fileNames)
    const missing = sources.filter((f) => !isTest(f) && !covered.has(f))
    assert.deepEqual(missing, [], `modules outside the shipping program: ${missing.join(", ")}`)
    assert.deepEqual([...covered].filter(isTest), [], "tests inside the shipping program")
    assert.ok(covered.size >= 40, `expected the moved modules, found ${covered.size}`)
  })

  test("the test config covers every test file", () => {
    const covered = relativeTo(tests.fileNames)
    const missing = sources.filter((f) => isTest(f) && !covered.has(f))
    assert.deepEqual(missing, [], `tests outside the test program: ${missing.join(", ")}`)
  })

  test("the shipping config rejects browser and Node globals and accepts plain ECMAScript", () => {
    const specimen = [
      "export const a = window.innerWidth",
      "export const b = document.title",
      'export const c = localStorage.getItem("k")',
      'export const d = fetch("u")',
      "export const e = process.env.X",
      'export const f = globalThis.fetch("u")',
      'export const g = Buffer.from("x")',
      "export const h = navigator.language",
      "export const ok = [1, 2].at(-1) ?? new Map<string, number>().size",
    ].join("\n")
    const fileName = path.join(SRC_DIR, "__specimen__.ts")
    const options: ts.CompilerOptions = { ...shipping.options, noEmit: true }
    const host = ts.createCompilerHost(options)
    const getSourceFile = host.getSourceFile
    host.getSourceFile = (name, languageVersion, onError, shouldCreate) =>
      name === fileName
        ? ts.createSourceFile(name, specimen, languageVersion)
        : getSourceFile.call(host, name, languageVersion, onError, shouldCreate)
    const fileExists = host.fileExists
    host.fileExists = (name) => name === fileName || fileExists.call(host, name)
    const program = ts.createProgram([fileName], options, host)
    const diagnostics = ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === fileName)
    const linesWithErrors = new Set(
      diagnostics.map((d) => d.file!.getLineAndCharacterOfPosition(d.start!).line + 1),
    )
    const bannedLines = [1, 2, 3, 4, 5, 6, 7, 8]
    const messages = diagnostics.map(
      (d) => `${d.file!.getLineAndCharacterOfPosition(d.start!).line + 1}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
    )
    for (const line of bannedLines) {
      assert.ok(linesWithErrors.has(line), `line ${line} should not type-check:\n${messages.join("\n")}`)
    }
    assert.ok(!linesWithErrors.has(9), `plain ECMAScript must compile:\n${messages.join("\n")}`)
  })
})
