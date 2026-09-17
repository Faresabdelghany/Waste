// The purity gate, shared by every workspace package whose code must bundle
// into the browser and run on the server alike (packages/domain per ADR-0002,
// packages/contracts). A package opts in with one call from its own
// src/__tests__/purity.test.ts:
//
//   definePurityTests({ packageDir, allowedPackages: ["zod"], allowedTestPackages: ["@waste/tooling"] })
//
// Two mechanisms carry the gate. The compiler: the package's tsconfig.json
// gives shipping code `lib: ["esnext"]` and `types: []`, so window, document,
// localStorage, fetch, process and Buffer are not even names there; a specimen
// compile below proves that holds. The scanner (purity-scan.ts): every import
// in shipping code is relative and stays inside src/, or names one of the
// allowed packages, which must be exactly the manifest's dependencies; tests
// may add Node built-ins and the allowed test packages, which must be
// devDependencies. Specifiers come from the TypeScript AST, so comments and
// strings cannot fool it and computed `import(x)` is caught as such.
//
// This package is not gated by itself: it reads files and drives the
// TypeScript API, so it keeps Node's types and is a devDependency only.
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, test } from "node:test"
import ts from "typescript"

import {
  findPurityViolations,
  isTestFile,
  readSources,
  testDirectories,
  type PurityAllowance,
} from "./purity-scan"

export type PurityGateOptions = {
  /** Absolute path of the package: holds package.json, tsconfig.json, tsconfig.test.json and src/. */
  packageDir: string
  /** Packages shipping code may import. Must equal the manifest's `dependencies`. Default: none. */
  allowedPackages?: readonly string[]
  /** Packages tests may import besides Node built-ins. Must be `devDependencies`. Default: none. */
  allowedTestPackages?: readonly string[]
  /** The whole exception list for the scan. Empty unless a reviewer accepted a reason. */
  allowances?: readonly PurityAllowance[]
}

export type PackageManifest = {
  name?: string
  exports?: Record<string, string | null>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/**
 * What is wrong with a manifest for a gated package, as reviewer-readable
 * sentences; empty when it is in order. Pure, so it is unit-tested on its own.
 */
export function manifestProblems(
  manifest: PackageManifest,
  testDirs: readonly string[],
  options: Pick<PurityGateOptions, "allowedPackages" | "allowedTestPackages">,
): string[] {
  const problems: string[] = []
  const declared = Object.keys(manifest.dependencies ?? {}).sort()
  const allowed = [...(options.allowedPackages ?? [])].sort()
  if (JSON.stringify(declared) !== JSON.stringify(allowed)) {
    problems.push(
      `dependencies must be exactly the allowed packages: declared [${declared.join(", ")}], allowed [${allowed.join(", ")}]`,
    )
  }
  const dev = manifest.devDependencies ?? {}
  for (const name of options.allowedTestPackages ?? []) {
    if (!(name in dev)) problems.push(`tests may import "${name}", so it must be a devDependency`)
  }
  const exports = manifest.exports ?? {}
  if (exports["./*"] !== "./src/*.ts") problems.push('exports["./*"] must be "./src/*.ts" (source by subpath)')
  if (exports["./package.json"] !== "./package.json") problems.push('exports["./package.json"] must be "./package.json"')
  for (const dir of testDirs) {
    if (exports[`./${dir}/*`] !== null) problems.push(`exports["./${dir}/*"] must be null to hide the tests from consumers`)
  }
  return problems
}

/** Registers the gate's node:test suites for one package. Call once, at the top level of a test file. */
export function definePurityTests(options: PurityGateOptions): void {
  const { packageDir } = options
  const srcDir = path.join(packageDir, "src")
  const manifest = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8")) as PackageManifest
  const name = manifest.name ?? path.basename(packageDir)
  const allowedPackages = options.allowedPackages ?? []

  describe(`${name}/src`, () => {
    test("holds only .ts files, so nothing escapes the compiler, the linter, or this scan", () => {
      const files = readSources(srcDir)
      assert.ok(files.length > 0, `no files under ${srcDir}`)
      const strays = files.filter((f) => !f.file.endsWith(".ts")).map((f) => f.file)
      assert.deepEqual(strays, [], `only .ts files belong under src/: ${strays.join(", ")}`)
    })

    const allowed = allowedPackages.length > 0 ? allowedPackages.join(", ") : "nothing else"
    test(`imports itself and ${allowed}`, () => {
      const violations = findPurityViolations(readSources(srcDir), options)
      const report = violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.detail}`).join("\n")
      assert.deepEqual(violations, [], `\n${report}\n`)
    })
  })

  describe(`${name}/package.json`, () => {
    test("declares exactly the allowed dependencies, exports source by subpath, hides the tests", () => {
      const testDirs = testDirectories(srcDir)
      assert.ok(testDirs.length >= 1, "the purity test itself lives in a __tests__ directory")
      const problems = manifestProblems(manifest, testDirs, options)
      assert.deepEqual(problems, [], `\n${problems.join("\n")}\n`)
    })
  })

  describe(`${name}/tsconfig`, () => {
    const load = (file: string) => {
      const read = ts.readConfigFile(path.join(packageDir, file), ts.sys.readFile)
      assert.equal(read.error, undefined, `${file}: ${read.error ? ts.flattenDiagnosticMessageText(read.error.messageText, " ") : ""}`)
      return ts.parseJsonConfigFileContent(read.config, ts.sys, packageDir)
    }
    const shipping = load("tsconfig.json")
    const tests = load("tsconfig.test.json")
    const relativeTo = (fileNames: readonly string[]) =>
      new Set(fileNames.map((f) => path.relative(srcDir, f).split(path.sep).join("/")))
    const sources = readSources(srcDir).map((f) => f.file)

    test("the shipping config covers every module and none of the tests", () => {
      const covered = relativeTo(shipping.fileNames)
      const missing = sources.filter((f) => !isTestFile(f) && !covered.has(f))
      assert.deepEqual(missing, [], `modules outside the shipping program: ${missing.join(", ")}`)
      assert.deepEqual([...covered].filter(isTestFile), [], "tests inside the shipping program")
      assert.ok(covered.size >= 1, "the shipping program is empty")
    })

    test("the test config covers every test file", () => {
      const covered = relativeTo(tests.fileNames)
      const missing = sources.filter((f) => isTestFile(f) && !covered.has(f))
      assert.deepEqual(missing, [], `tests outside the test program: ${missing.join(", ")}`)
    })

    test("the shipping config rejects browser and Node globals and accepts plain ECMAScript", () => {
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
      const fileExists = host.fileExists
      host.fileExists = (file) => file === fileName || fileExists.call(host, file)
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
