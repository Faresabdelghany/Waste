// No two folders of the web import each other, directly or round a longer
// loop (F9 of #574): the components' platform layer is what every feature
// folder shares, lib/data the inner ring the adapters and the screens read,
// and lib/records, lib/format and lib/modules beneath it. A folder is
// lib/<name> or components/<name> (a file at either root is its own); a test
// is no edge.
import assert from "node:assert/strict"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, normalize, relative } from "node:path"
import { describe, test } from "node:test"

const WEB = join(import.meta.dirname, "..", "..")
const ROOTS = ["app", "components", "lib"]
const EXTENSIONS = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"]
const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm

const isTest = (file: string) => /(^|\/)__tests__\//.test(file) || /\.test\.tsx?$/.test(file)

function sourcesUnder(folder: string): string[] {
  return readdirSync(join(WEB, folder), { recursive: true, encoding: "utf8" })
    .map((file) => join(folder, file))
    .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".d.ts") && !isTest(file) && statSync(join(WEB, file)).isFile())
}

function resolved(from: string, spec: string): string | undefined {
  const base = spec.startsWith("@/") ? spec.slice(2) : spec.startsWith(".") ? normalize(join(dirname(from), spec)) : undefined
  if (base === undefined) return undefined
  const found = EXTENSIONS.map((extension) => base + extension).find((candidate) => existsSync(join(WEB, candidate)) && statSync(join(WEB, candidate)).isFile())
  return found === undefined ? undefined : relative(WEB, join(WEB, found))
}

const folderOf = (file: string) => file.split("/").slice(0, 2).join("/")

function folderEdges(): Map<string, Map<string, string[]>> {
  const edges = new Map<string, Map<string, string[]>>()
  for (const file of ROOTS.flatMap(sourcesUnder)) {
    for (const match of readFileSync(join(WEB, file), "utf8").matchAll(IMPORT)) {
      const target = resolved(file, match[1])
      if (target === undefined || isTest(target)) continue
      const [from, to] = [folderOf(file), folderOf(target)]
      if (from === to) continue
      const out = edges.get(from) ?? new Map<string, string[]>()
      out.set(to, [...(out.get(to) ?? []), `${file} -> ${target}`])
      edges.set(from, out)
    }
  }
  return edges
}

/** The strongly connected components of more than one folder (Tarjan's). */
function folderCycles(edges: Map<string, Map<string, string[]>>): string[][] {
  let next = 0
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const cycles: string[][] = []
  const visit = (folder: string) => {
    index.set(folder, next)
    low.set(folder, next)
    next += 1
    stack.push(folder)
    onStack.add(folder)
    for (const to of edges.get(folder)?.keys() ?? []) {
      if (!index.has(to)) {
        visit(to)
        low.set(folder, Math.min(low.get(folder)!, low.get(to)!))
      } else if (onStack.has(to)) low.set(folder, Math.min(low.get(folder)!, index.get(to)!))
    }
    if (low.get(folder) === index.get(folder)) {
      const component: string[] = []
      let member: string
      do {
        member = stack.pop()!
        onStack.delete(member)
        component.push(member)
      } while (member !== folder)
      if (component.length > 1) cycles.push(component.sort())
    }
  }
  for (const folder of edges.keys()) if (!index.has(folder)) visit(folder)
  return cycles
}

describe("the web's folders", () => {
  test("import one another in one direction only: no folder is in a cycle", () => {
    const edges = folderEdges()
    const told = folderCycles(edges).map((cycle) =>
      [cycle.join(" ↔ "), ...cycle.flatMap((from) => cycle.filter((to) => to !== from).flatMap((to) => (edges.get(from)?.get(to) ?? []).slice(0, 3)))].join("\n  "),
    )
    assert.deepEqual(told, [])
  })

  test("are read: the walk finds the layers it guards", () => {
    const edges = folderEdges()
    assert.ok(edges.get("lib/api")?.has("lib/data"), "the adapters read lib/data")
    assert.ok(edges.get("components/waste")?.has("components/platform"), "the workspace reads the platform")
  })
})
