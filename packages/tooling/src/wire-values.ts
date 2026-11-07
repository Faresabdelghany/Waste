// The wire states values: a closed list a field takes, the shape a code has,
// the bound a set or a text keeps, the sentence a refusal says. Each is the
// domain's (@waste/domain), read by the database's checks, the API and the
// web alike, and the wire package only wraps it in zod. This scan finds a
// value a module spells itself instead, from the TypeScript AST:
//
//   closed-list — an array of two or more string literals, or a string literal
//                 handed to `enum`, `exclude` or `extract`;
//   pattern     — a regular expression literal, or `new RegExp` over a
//                 literal;
//   bound       — a number literal other than 0 and 1;
//   sentence    — a string or template literal holding whitespace.
//
// The arguments of `.describe()` and `.meta()` document the schema, and are
// not values it states.
//
// A field's name, a union's tag (`z.literal`) and a token such as zod's
// issue code are none of these: they are the shape of a body, not a value of
// it.
//
// A package opts in with one call from a test, naming the modules that state
// no domain's values at all and why (`beside`): the probes' answer, which
// states the process's own state, say.
import assert from "node:assert/strict"
import path from "node:path"
import { test } from "node:test"
import ts from "typescript"

import { isTestFile, readSources, type SourceFile } from "./purity-scan"

/** Registers the test that a package's shipping modules state no value of their own, but the modules `beside`, each with its reason. */
export function defineWireValueTests({ packageDir, beside }: { packageDir: string; beside: Readonly<Record<string, string>> }): void {
  test(`states no closed list, pattern, bound or sentence of its own; the domain's, wrapped, and nothing beside ${Object.keys(beside).join(", ")}`, () => {
    const files = readSources(path.join(packageDir, "src")).filter((f) => f.file.endsWith(".ts") && !isTestFile(f.file))
    for (const file of Object.keys(beside)) assert.ok(files.some((f) => f.file === file), `${file} is set beside but is no module of the package`)
    const own = findOwnValues(files.filter((f) => !(f.file in beside)))
    assert.deepEqual(own.map((v) => `${v.file}:${v.line} ${v.kind} ${v.text}`), [])
  })
}

export type OwnValueKind = "closed-list" | "pattern" | "bound" | "sentence"

export type OwnValue = {
  /** Path relative to src/, posix separators. */
  file: string
  /** 1-based line of the value. */
  line: number
  kind: OwnValueKind
  /** The value as written, shortened. */
  text: string
}

/** The calls whose arguments document a schema or tag a union, and state no value. */
const STATING_NOTHING = new Set(["describe", "meta", "literal"])
const LISTING = new Set(["enum", "exclude", "extract"])

/** Every value the files spell themselves, in file and line order. */
export function findOwnValues(files: readonly SourceFile[]): OwnValue[] {
  const found: OwnValue[] = []
  for (const { file, source } of files) {
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true)
    const push = (node: ts.Node, kind: OwnValueKind) => {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
      found.push({ file, line, kind, text: node.getText(sourceFile).replace(/\s+/g, " ").slice(0, 100) })
    }
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isTypeNode(node)) return
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && STATING_NOTHING.has(node.expression.name.text)) {
        visit(node.expression)
        return
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && LISTING.has(node.expression.name.text)) {
        const [list] = node.arguments
        if (list !== undefined && ts.isArrayLiteralExpression(list) && list.elements.some(isText)) {
          push(list, "closed-list")
          visit(node.expression)
          return
        }
      }
      if (ts.isArrayLiteralExpression(node) && node.elements.length >= 2 && node.elements.every(isText) && !isIssuePath(node)) {
        push(node, "closed-list")
        return
      }
      if (node.kind === ts.SyntaxKind.RegularExpressionLiteral) {
        push(node, "pattern")
        return
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "RegExp" && node.arguments?.[0] !== undefined && isTextOrTemplate(node.arguments[0])) {
        push(node, "pattern")
        return
      }
      if (ts.isNumericLiteral(node) && Number(node.text) !== 0 && Number(node.text) !== 1) {
        push(node, "bound")
        return
      }
      if (isTextOrTemplate(node) && !isPropertyName(node) && /\s/.test(textOf(node))) {
        push(node, "sentence")
        return
      }
      ts.forEachChild(node, visit)
    }
    visit(sourceFile)
  }
  return found
}

function isText(node: ts.Node): boolean {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
}

function isTextOrTemplate(node: ts.Node): boolean {
  return isText(node) || ts.isTemplateExpression(node)
}

function textOf(node: ts.Node): string {
  if (ts.isTemplateExpression(node)) return [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join("")
  return (node as ts.StringLiteral).text
}

/** Whether an array is an issue's `path`: the field names a refusal is told at, the shape of a body and not a list of its values. */
function isIssuePath(node: ts.ArrayLiteralExpression): boolean {
  const parent = node.parent
  return ts.isPropertyAssignment(parent) && parent.initializer === node && ts.isIdentifier(parent.name) && parent.name.text === "path"
}

function isPropertyName(node: ts.Node): boolean {
  const parent = node.parent
  return (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent)) && parent.name === node
}
