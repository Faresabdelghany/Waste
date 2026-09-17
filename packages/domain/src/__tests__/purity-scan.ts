// Test support for purity.test.ts. Module specifiers are read from the
// TypeScript AST (typescript is a devDependency of this package), so comments
// and strings cannot fool the scan, a wrapped import reports the line of its
// specifier, and a computed `import(x)` is a finding of its own.
//
// Browser and Node globals are not this scanner's job: tsconfig.json gives
// shipping code no DOM lib and no ambient types, so the compiler rejects them.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { isBuiltin } from "node:module"
import path from "node:path"
import ts from "typescript"

export type PurityRule = "bare-import" | "escapes-package" | "computed-import"

export type PurityViolation = {
  /** Path relative to src/, posix separators. */
  file: string
  /** 1-based line of the specifier. */
  line: number
  rule: PurityRule
  detail: string
}

export type PurityAllowance = {
  /** Path relative to src/, posix separators. */
  file: string
  /** Omit to allow every rule in that file. */
  rule?: PurityRule
  reason: string
}

export type SourceFile = { file: string; source: string }

/** Packages shipping code may import. Empty on purpose: the domain depends on nothing. */
export const ALLOWED_PACKAGES: readonly string[] = []

/** Packages tests may import besides Node built-ins. */
export const ALLOWED_TEST_PACKAGES: readonly string[] = ["typescript"]

export function findPurityViolations(
  files: SourceFile[],
  allowances: PurityAllowance[] = [],
): PurityViolation[] {
  const violations: PurityViolation[] = []
  for (const { file, source } of files) {
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    for (const found of specifiersIn(sourceFile)) {
      const line = sourceFile.getLineAndCharacterOfPosition(found.node.getStart(sourceFile)).line + 1
      if (found.specifier === null) {
        violations.push({ file, line, rule: "computed-import", detail: `${found.kind} with a computed specifier` })
        continue
      }
      const verdict = judge(file, found.specifier)
      if (verdict) violations.push({ file, line, ...verdict })
    }
  }
  return violations.filter((v) => !isAllowed(v, allowances))
}

type FoundSpecifier = { node: ts.Node; specifier: string | null; kind: string }

/** Every static import/export-from, `import x = require()`, `import()` and `require()`. */
function specifiersIn(sourceFile: ts.SourceFile): FoundSpecifier[] {
  const found: FoundSpecifier[] = []
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      found.push({ node: node.moduleSpecifier, specifier: literalText(node.moduleSpecifier), kind: "import" })
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const expression = node.moduleReference.expression
      found.push({ node: expression, specifier: literalText(expression), kind: "import = require()" })
    } else if (ts.isCallExpression(node) && isImportLikeCall(node)) {
      const argument = node.arguments[0]
      const kind = node.expression.kind === ts.SyntaxKind.ImportKeyword ? "import()" : "require()"
      found.push({ node: argument ?? node, specifier: argument ? literalText(argument) : null, kind })
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function isImportLikeCall(node: ts.CallExpression): boolean {
  return (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === "require")
  )
}

function literalText(node: ts.Node): string | null {
  return ts.isStringLiteralLike(node) ? node.text : null
}

function judge(file: string, specifier: string): { rule: PurityRule; detail: string } | null {
  if (specifier.startsWith(".")) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
    if (resolved.startsWith("..")) {
      return { rule: "escapes-package", detail: `"${specifier}" resolves outside src/` }
    }
    return null
  }
  const packageName = packageNameOf(specifier)
  if (ALLOWED_PACKAGES.includes(packageName)) return null
  if (isTestFile(file)) {
    if (isBuiltin(specifier) || ALLOWED_TEST_PACKAGES.includes(packageName)) return null
    return {
      rule: "bare-import",
      detail: `imports "${specifier}"; tests may add only Node built-ins and ${ALLOWED_TEST_PACKAGES.join(", ")}`,
    }
  }
  return { rule: "bare-import", detail: `imports "${specifier}"; the domain package depends on nothing` }
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

function isTestFile(file: string): boolean {
  return file.split("/").includes("__tests__")
}

function isAllowed(violation: PurityViolation, allowances: PurityAllowance[]): boolean {
  return allowances.some(
    (a) => a.file === violation.file && (a.rule === undefined || a.rule === violation.rule),
  )
}

/** Every file under rootDir, whatever its extension, relative posix paths. */
export function readSources(rootDir: string): SourceFile[] {
  const files: SourceFile[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else {
        files.push({
          file: path.relative(rootDir, full).split(path.sep).join("/"),
          source: readFileSync(full, "utf8"),
        })
      }
    }
  }
  walk(rootDir)
  return files
}
