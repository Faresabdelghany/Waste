// The bundle step over a small TypeScript program in a temporary directory: a
// relative import, an npm dependency resolved from the workspace (zod, which
// both apps depend on), a Node built-in, and a `require` at run time (the
// banner's createRequire). The bundle runs with plain node and prints what
// the source would.
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"

import { bundleEntry, REPOSITORY_ROOT } from "../bundle"

const dir = mkdtempSync(path.join(tmpdir(), "waste-pilot-bundle-"))
after(() => rmSync(dir, { recursive: true, force: true }))

describe("bundleEntry", () => {
  test("inlines the entry's TypeScript, its relative imports and its npm dependencies into one ESM file that plain node runs, Node's built-ins left native", async () => {
    mkdirSync(path.join(dir, "src"))
    writeFileSync(path.join(dir, "src", "greeting.ts"), `export const greet = (name: string): string => \`hello \${name}\`\n`)
    writeFileSync(
      path.join(dir, "src", "entry.ts"),
      [
        `import { hostname } from "node:os"`,
        `import * as z from "zod"`,
        `import { greet } from "./greeting"`,
        `const Name = z.string().min(1)`,
        `console.log(greet(Name.parse("pilot")), typeof hostname(), typeof require)`,
        "",
      ].join("\n"),
    )
    writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "es2022", module: "esnext", moduleResolution: "bundler", strict: true } }))
    const outfile = path.join(dir, "out", "entry.mjs")
    // zod is resolved from the API's directory in this workspace, as the image resolves the API's own dependencies.
    const result = await bundleEntry({ entry: path.join(dir, "src", "entry.ts"), outfile, tsconfig: path.join(dir, "tsconfig.json"), resolveFrom: path.join(REPOSITORY_ROOT, "apps", "api") })
    assert.ok(result.bytes > 10_000, `zod is inlined: ${result.bytes} bytes`)
    const text = readFileSync(outfile, "utf8")
    assert.doesNotMatch(text, /from "zod"|require\("zod"\)/, "no zod import survives")
    assert.match(text, /from "node:os"|require\("node:os"\)/, "the built-in stays native")
    assert.equal(execFileSync(process.execPath, [outfile], { encoding: "utf8" }).trim(), "hello pilot string function")
  })
})
