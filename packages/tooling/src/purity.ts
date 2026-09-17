// The purity gate, shared by every workspace package whose code must bundle
// into the browser and run on the server alike (packages/domain per ADR-0002,
// packages/contracts). A package opts in with one call from its own
// src/__tests__/purity.test.ts, a path the gate itself insists on:
//
//   definePurityTests({ packageDir, allowedImports: ["zod"], allowedTestImports: ["@waste/tooling/purity"] })
//
// Two mechanisms carry the gate. The compiler: the package's tsconfig.json
// gives shipping code `lib: ["esnext"]` and `types: []`, so window, document,
// localStorage, fetch, process and Buffer are not even names there; a specimen
// compile below proves that holds. The scanner (purity-scan.ts): every import
// in shipping code is relative and stays inside src/, or is one of the allowed
// specifiers, whose packages must be exactly the manifest's dependencies; tests
// may add Node built-ins and the allowed test specifiers, whose packages must
// be devDependencies; reference directives, ambient declarations and
// type-position imports are refused outright. Specifiers come from the
// TypeScript AST, so comments and strings cannot fool it.
//
// Every file read happens inside a test, never in a describe body: on Node 22
// a suite whose body throws is printed `not ok` but the process still exits 0,
// which would turn a missing tsconfig into a silently skipped gate.
//
// This package is not gated by itself: it reads files and drives the
// TypeScript API, so it keeps Node's types and is a devDependency of the
// packages it checks. typescript is its one runtime dependency, because the
// gate imports it whenever a consumer's test suite runs.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, test } from "node:test"
import ts from "typescript"

import {
  findPurityViolations,
  isTestFile,
  packageNameOf,
  readSources,
  testDirectoriesOf,
  type PurityScanOptions,
  type SourceFile,
} from "./purity-scan"

export type PurityGateOptions = PurityScanOptions & {
  /** Absolute path of the package: holds package.json, tsconfig.json, tsconfig.test.json and src/. */
  packageDir: string
}

export type PackageManifest = {
  name?: string
  exports?: Record<string, string | null>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** The gate's own test file, relative to src/. Every gated package has one. */
export const GATE_TEST_FILE = "__tests__/purity.test.ts"

/**
 * What is wrong with a manifest for a gated package, as reviewer-readable
 * sentences; empty when it is in order. Pure, so it is unit-tested on its own.
 */
export function manifestProblems(
  manifest: PackageManifest,
  testDirs: readonly string[],
  options: Pick<PurityGateOptions, "allowedImports" | "allowedTestImports">,
): string[] {
  const problems: string[] = []
  const declared = Object.keys(manifest.dependencies ?? {}).sort()
  const allowed = uniqueSorted((options.allowedImports ?? []).map(packageNameOf))
  if (JSON.stringify(declared) !== JSON.stringify(allowed)) {
    problems.push(
      `dependencies must be exactly the packages of the allowed imports: declared [${declared.join(", ")}], allowed [${allowed.join(", ")}]`,
    )
  }
  const dev = manifest.devDependencies ?? {}
  for (const name of uniqueSorted((options.allowedTestImports ?? []).map(packageNameOf))) {
    if (!(name in dev)) problems.push(`tests may import from "${name}", so it must be a devDependency`)
  }
  const exports = manifest.exports ?? {}
  if (exports["./*"] !== "./src/*.ts") problems.push('exports["./*"] must be "./src/*.ts" (source by subpath)')
  if (exports["./package.json"] !== "./package.json") problems.push('exports["./package.json"] must be "./package.json"')
  for (const dir of testDirs) {
    if (exports[`./${dir}/*`] !== null) problems.push(`exports["./${dir}/*"] must be null to hide the tests from consumers`)
  }
  return problems
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

type Loaded = {
  manifest: PackageManifest
  files: SourceFile[]
  sources: string[]
  shipping: ts.ParsedCommandLine
  tests: ts.ParsedCommandLine
}

/** Registers the gate's node:test suites for one package. Call once, at the top level of a test file. */
export function definePurityTests(options: PurityGateOptions): void {
  const { packageDir } = options
  const srcDir = path.join(packageDir, "src")
  const label = `${path.basename(path.dirname(packageDir))}/${path.basename(packageDir)}`

  let loaded: Loaded | undefined
  const load = (): Loaded => {
    if (loaded) return loaded
    const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as PackageManifest
    const files = readSources(srcDir)
    const parse = (file: string) => {
      const read = ts.readConfigFile(path.join(packageDir, file), ts.sys.readFile)
      if (read.error) throw new Error(`${file}: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`)
      return ts.parseJsonConfigFileContent(read.config, ts.sys, packageDir)
    }
    loaded = {
      manifest,
      files,
      sources: files.map((f) => f.file),
      shipping: parse("tsconfig.json"),
      tests: parse("tsconfig.test.json"),
    }
    return loaded
  }
  const relativeTo = (fileNames: readonly string[]) =>
    fileNames.map((f) => path.relative(srcDir, f).split(path.sep).join("/"))

  describe(`${label}/src`, () => {
    test("holds only .ts files, and the gate's own test, so nothing escapes the compiler, the linter, or this scan", () => {
      const { files } = load()
      assert.ok(files.length > 0, `no files under ${srcDir}`)
      assert.ok(files.some((f) => f.file === GATE_TEST_FILE), `${GATE_TEST_FILE} is missing or the walker skipped it`)
      const strays = files.filter((f) => !f.file.endsWith(".ts")).map((f) => f.file)
      assert.deepEqual(strays, [], `only .ts files belong under src/: ${strays.join(", ")}`)
    })

    const allowedImports = options.allowedImports ?? []
    const allowed = allowedImports.length > 0 ? allowedImports.join(", ") : "nothing else"
    test(`imports itself and ${allowed}`, () => {
      const violations = findPurityViolations(load().files, options)
      const report = violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.detail}`).join("\n")
      assert.deepEqual(violations, [], `\n${report}\n`)
    })
  })

  describe(`${label}/package.json`, () => {
    test("declares exactly the packages of the allowed imports, exports source by subpath, hides every __tests__", () => {
      const { manifest, sources } = load()
      const testDirs = testDirectoriesOf(sources)
      assert.ok(testDirs.includes("__tests__"), `expected src/__tests__ among ${JSON.stringify(testDirs)}`)
      const problems = manifestProblems(manifest, testDirs, options)
      assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`)
    })
  })

  describe(`${label}/tsconfig`, () => {
    test("the shipping config covers every module, none of the tests, and nothing this gate did not see", () => {
      const { shipping, sources } = load()
      const covered = relativeTo(shipping.fileNames)
      const coveredSet = new Set(covered)
      const missing = sources.filter((f) => !isTestFile(f) && !coveredSet.has(f))
      assert.deepEqual(missing, [], `modules outside the shipping program: ${missing.join(", ")}`)
      assert.deepEqual(covered.filter(isTestFile), [], "tests inside the shipping program")
      const seen = new Set(sources)
      const unseen = covered.filter((f) => !seen.has(f))
      assert.deepEqual(unseen, [], `the compiler sees files this gate did not: ${unseen.join(", ")}`)
      assert.ok(covered.length >= 1, "the shipping program is empty")
    })

    test("the test config covers every test file and nothing this gate did not see", () => {
      const { tests, sources } = load()
      const covered = relativeTo(tests.fileNames)
      const coveredSet = new Set(covered)
      const missing = sources.filter((f) => isTestFile(f) && !coveredSet.has(f))
      assert.deepEqual(missing, [], `tests outside the test program: ${missing.join(", ")}`)
      const seen = new Set(sources)
      const unseen = covered.filter((f) => !seen.has(f))
      assert.deepEqual(unseen, [], `the compiler sees files this gate did not: ${unseen.join(", ")}`)
    })

    test("the shipping config rejects browser and Node globals and accepts plain ECMAScript", () => {
      const { shipping } = load()
      const banned = [
        "export const a = window.innerWidth",
        "export const b = document.title",
        'export const c = localStorage.getItem("k")',
        'export const d = fetch("u")',
        "export const e = process.env.X",
        'export const f = globalThis.fetch("u")',
        'export const g = Buffer.from("x")',
        "export const h = navigator.language",
      ]
      const plain = "export const ok = [1, 2].at(-1) ?? new Map<string, number>().size"
      const specimen = [...banned, plain].join("\n")
      const fileName = path.join(srcDir, "__specimen__.ts")
      const compilerOptions: ts.CompilerOptions = { ...shipping.options, noEmit: true }
      const host = ts.createCompilerHost(compilerOptions)
      const getSourceFile = host.getSourceFile
      host.getSourceFile = (file, languageVersion, onError, shouldCreate) =>
        file === fileName
          ? ts.createSourceFile(file, specimen, languageVersion)
          : getSourceFile.call(host, file, languageVersion, onError, shouldCreate)
      const program = ts.createProgram([fileName], compilerOptions, host)
      const diagnostics = ts.getPreEmitDiagnostics(program).filter((d) => d.file?.fileName === fileName)
      const lineOf = (d: ts.Diagnostic) => d.file!.getLineAndCharacterOfPosition(d.start!).line + 1
      const linesWithErrors = new Set(diagnostics.map(lineOf))
      const messages = diagnostics.map((d) => `${lineOf(d)}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`)
      banned.forEach((_, index) => {
        const line = index + 1
        assert.ok(linesWithErrors.has(line), `line ${line} should not type-check:\n${messages.join("\n")}`)
      })
      assert.ok(!linesWithErrors.has(banned.length + 1), `plain ECMAScript must compile:\n${messages.join("\n")}`)
    })
  })
}
