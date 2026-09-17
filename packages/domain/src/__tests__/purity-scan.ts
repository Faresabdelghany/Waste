// Test support for purity.test.ts: a text scanner over the package sources.
// Deliberately lexical — no TypeScript program is built — so it stays fast
// and its rules stay readable. Where a lexical rule would misfire (a local
// named `window`), rename the local; do not weaken the rule.
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

export type PurityRule =
  | "forbidden-import"
  | "node-import"
  | "escapes-package"
  | "browser-global"

export type PurityViolation = {
  /** Path relative to src/, posix separators. */
  file: string
  /** 1-based line. */
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

/** Module specifiers the domain package must never import. */
const FORBIDDEN_SPECIFIERS: Array<[label: string, pattern: RegExp]> = [
  ["react", /^react(?:$|[/-])/],
  ["next", /^next(?:$|\/)/],
  ["maplibre-gl", /^maplibre-gl(?:$|\/)/],
  ["the @/ alias into apps/web", /^@\//],
  ["the web app package", /^@waste\/web(?:$|\/)/],
  ["the fixture registry", /business-modules/],
]

/** Node built-ins: fine in tests, never in code that ships to the browser. */
const NODE_BUILTIN = /^(?:node:|(?:fs|path|os|crypto|child_process|http|https|net|stream|url|util|worker_threads|zlib|buffer|events)(?:$|\/))/

/** Browser globals, matched as text; see the header about false positives. */
const BROWSER_GLOBALS: Array<[label: string, pattern: RegExp]> = [
  ["window.", /(?<![\w$.])window\.[A-Za-z_$]/],
  ["document.", /(?<![\w$.])document\.[A-Za-z_$]/],
  ["navigator.", /(?<![\w$.])navigator\.[A-Za-z_$]/],
  ["localStorage", /(?<![\w$.])localStorage\b/],
  ["sessionStorage", /(?<![\w$.])sessionStorage\b/],
  ["fetch(", /(?<![\w$.])fetch\s*\(/],
]

/** Every static, dynamic, side-effect import and require in one pass. */
const IMPORT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["']([^"']+)["']/g

export function findPurityViolations(
  files: SourceFile[],
  allowances: PurityAllowance[] = [],
): PurityViolation[] {
  const violations: PurityViolation[] = []
  for (const { file, source } of files) {
    const lines = source.split("\n")
    lines.forEach((text, index) => {
      const line = index + 1
      for (const specifier of importSpecifiers(text)) {
        const rule = importRule(file, specifier)
        if (rule) violations.push({ file, line, rule: rule.rule, detail: rule.detail })
      }
      for (const [label, pattern] of BROWSER_GLOBALS) {
        if (pattern.test(text)) {
          violations.push({ file, line, rule: "browser-global", detail: `uses ${label}` })
        }
      }
    })
  }
  return violations.filter((v) => !isAllowed(v, allowances))
}

function importSpecifiers(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(IMPORT_SPECIFIER)) found.push(match[1])
  return found
}

function importRule(
  file: string,
  specifier: string,
): { rule: PurityRule; detail: string } | null {
  for (const [label, pattern] of FORBIDDEN_SPECIFIERS) {
    if (pattern.test(specifier)) {
      return { rule: "forbidden-import", detail: `imports ${label}: "${specifier}"` }
    }
  }
  if (specifier.startsWith(".")) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier))
    if (resolved.startsWith("..")) {
      return { rule: "escapes-package", detail: `"${specifier}" resolves outside src/` }
    }
    return null
  }
  if (NODE_BUILTIN.test(specifier) && !isTestFile(file)) {
    return { rule: "node-import", detail: `imports a Node built-in: "${specifier}"` }
  }
  return null
}

function isTestFile(file: string): boolean {
  return file.split("/").includes("__tests__")
}

function isAllowed(violation: PurityViolation, allowances: PurityAllowance[]): boolean {
  return allowances.some(
    (a) => a.file === violation.file && (a.rule === undefined || a.rule === violation.rule),
  )
}

/** Every .ts file under rootDir, paths relative to it with posix separators. */
export function readSources(rootDir: string): SourceFile[] {
  const files: SourceFile[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
      } else if (entry.endsWith(".ts")) {
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
