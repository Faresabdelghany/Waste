// The import scan behind the purity gate (see purity.ts). Module specifiers
// are read from the TypeScript AST, so comments and strings cannot fool the
// scan, a wrapped import reports the line of its specifier, and a computed
// `import(x)` is a finding of its own. Type-position imports (`import("x").T`),
// triple-slash reference directives and ambient declarations (`declare global`,
// `declare module "x"`) are findings too: each is a way to reach a package or
// re-enable a global without an import statement.
//
// Browser and Node globals are otherwise not this scanner's job: the checked
// package's tsconfig.json gives shipping code no DOM lib and no ambient types,
// so the compiler rejects them; purity.ts proves that with a specimen compile.
import { readdirSync, readFileSync, statSync } from "node:fs"
import { isBuiltin } from "node:module"
import path from "node:path"
import ts from "typescript"

export type PurityRule =
  | "bare-import"
  | "escapes-package"
  | "computed-import"
  | "reference-directive"
  | "ambient-declaration"

export type PurityViolation = {
  /** Path relative to src/, posix separators. */
  file: string
  /** 1-based line of the specifier or directive. */
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

export type PurityScanOptions = {
  /**
   * Exact specifiers shipping code may import, e.g. `["zod"]`. A subpath is a
   * different specifier: `zod/v3` is refused unless listed. Empty: the package
   * imports nothing but itself.
   */
  allowedImports?: readonly string[]
  /** Exact specifiers tests may import besides Node built-ins and allowedImports. */
  allowedTestImports?: readonly string[]
  /** The whole exception list. Every entry carries a reason a reviewer can check. */
  allowances?: readonly PurityAllowance[]
}

export type SourceFile = { file: string; source: string }

export function findPurityViolations(files: readonly SourceFile[], options: PurityScanOptions = {}): PurityViolation[] {
  const allowedImports = options.allowedImports ?? []
  const allowedTestImports = options.allowedTestImports ?? []
  const allowances = options.allowances ?? []
  const violations: PurityViolation[] = []
  for (const { file, source } of files) {
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const lineOf = (pos: number) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1
    for (const found of specifiersIn(sourceFile)) {
      const line = lineOf(found.node.getStart(sourceFile))
      if (found.specifier === null) {
        violations.push({ file, line, rule: "computed-import", detail: `${found.kind} with a computed specifier` })
        continue
      }
      const verdict = judge(file, found.specifier, allowedImports, allowedTestImports)
      if (verdict) violations.push({ file, line, ...verdict })
    }
    for (const directive of referenceDirectivesIn(sourceFile)) {
      violations.push({
        file,
        line: lineOf(directive.pos),
        rule: "reference-directive",
        detail: `/// <reference ${directive.kind}="${directive.fileName}" /> reaches past the package's tsconfig`,
      })
    }
    for (const declaration of ambientDeclarationsIn(sourceFile)) {
      violations.push({
        file,
        line: lineOf(declaration.getStart(sourceFile)),
        rule: "ambient-declaration",
        detail: `${declaration.name.getText(sourceFile)} augments the global scope or another package`,
      })
    }
  }
  return violations.filter((v) => !isAllowed(v, allowances))
}

type FoundSpecifier = { node: ts.Node; specifier: string | null; kind: string }

/** Every static import/export-from, `import x = require()`, `import()`, `require()` and `import("x").T`. */
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
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument
      const specifier = ts.isLiteralTypeNode(argument) ? literalText(argument.literal) : null
      found.push({ node: argument, specifier, kind: "import() type" })
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

type ReferenceDirective = { kind: "path" | "types" | "lib"; fileName: string; pos: number }

/** Every `/// <reference path|types|lib="…" />` at the top of the file. */
function referenceDirectivesIn(sourceFile: ts.SourceFile): ReferenceDirective[] {
  const of = (kind: ReferenceDirective["kind"], list: readonly ts.FileReference[]) =>
    list.map((d) => ({ kind, fileName: d.fileName, pos: d.pos }))
  return [
    ...of("path", sourceFile.referencedFiles),
    ...of("types", sourceFile.typeReferenceDirectives),
    ...of("lib", sourceFile.libReferenceDirectives),
  ].sort((a, b) => a.pos - b.pos)
}

/** Every `declare global { … }` and `declare module "x" { … }`. */
function ambientDeclarationsIn(sourceFile: ts.SourceFile): ts.ModuleDeclaration[] {
  const found: ts.ModuleDeclaration[] = []
  const visit = (node: ts.Node) => {
    if (ts.isModuleDeclaration(node)) {
      const isGlobal = (node.flags & ts.NodeFlags.GlobalAugmentation) !== 0
      if (isGlobal || ts.isStringLiteral(node.name)) found.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return found
}

function judge(
  file: string,
  specifier: string,
  allowedImports: readonly string[],
  allowedTestImports: readonly string[],
): { rule: PurityRule; detail: string } | null {
  if (specifier.startsWith(".")) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
    if (resolved.startsWith("..")) {
      return { rule: "escapes-package", detail: `"${specifier}" resolves outside src/` }
    }
    return null
  }
  if (allowedImports.includes(specifier)) return null
  if (isTestFile(file)) {
    if (isBuiltin(specifier) || allowedTestImports.includes(specifier)) return null
    const extra = allowedTestImports.length > 0 ? ` and ${allowedTestImports.join(", ")}` : ""
    return { rule: "bare-import", detail: `imports "${specifier}"; tests may add only Node built-ins${extra}` }
  }
  const allowed = allowedImports.length > 0 ? `only ${allowedImports.join(", ")}` : "nothing"
  return { rule: "bare-import", detail: `imports "${specifier}"; shipping code may import ${allowed}` }
}

/** The package a specifier addresses: `zod/v4` is zod, `@waste/tooling/purity` is @waste/tooling. */
export function packageNameOf(specifier: string): string {
  const parts = specifier.split("/")
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]
}

export function isTestFile(file: string): boolean {
  return file.split("/").includes("__tests__")
}

/** The `__tests__` directories the given source paths live in, relative posix, sorted, unique. */
export function testDirectoriesOf(files: readonly string[]): string[] {
  const dirs = new Set<string>()
  for (const file of files) {
    const parts = file.split("/")
    const index = parts.indexOf("__tests__")
    if (index >= 0) dirs.add(parts.slice(0, index + 1).join("/"))
  }
  return [...dirs].sort()
}

function isAllowed(violation: PurityViolation, allowances: readonly PurityAllowance[]): boolean {
  return allowances.some((a) => a.file === violation.file && (a.rule === undefined || a.rule === violation.rule))
}

/**
 * Every file under rootDir, whatever its extension, as relative posix paths,
 * sorted. Hidden entries (`.DS_Store`, editor swap files) are not sources and
 * are skipped.
 */
export function readSources(rootDir: string): SourceFile[] {
  const files: SourceFile[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith(".")) continue
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
