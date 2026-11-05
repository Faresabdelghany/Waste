// The MapLibre worker route's files reach a deployment only through
// next.config.mjs's `outputFileTracingIncludes`: the automatic trace ships
// them under `.pnpm`, not at `node_modules/maplibre-gl`, where the route
// reads them, and on Vercel the route answered 404 and no base map drew.
// The include is matched against the route the way Next's build matches it
// (collect-build-traces.js: picomatch, dot and contains), and names every
// file the route serves, each present in the installed package.
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { describe, test } from "node:test"

import nextConfig from "../../next.config.mjs"
import { MAPLIBRE_DIST_DIR, MAPLIBRE_WORKER_ASSETS } from "../map-planning/maplibre-worker-assets"

/** Next's own picomatch, which ships no types. */
const picomatch = createRequire(import.meta.url)("next/dist/compiled/picomatch") as (
  glob: string,
  options: { dot: boolean; contains: boolean },
) => (input: string) => boolean

const ROUTE = "/maplibre/[version]/[asset]"
const APP_DIR = path.join(import.meta.dirname, "..", "..")

function includesFor(route: string): string[] {
  const includes = nextConfig.outputFileTracingIncludes ?? {}
  return Object.entries(includes)
    .filter(([glob]) => picomatch(glob, { dot: true, contains: true })(route))
    .flatMap(([, files]) => files)
}

describe("the MapLibre worker route's trace", () => {
  test("names every file the route serves, at the path the route reads", () => {
    const included = new Set(includesFor(ROUTE).map((file) => path.posix.normalize(file)))
    for (const asset of MAPLIBRE_WORKER_ASSETS) {
      assert.ok(included.has(path.posix.join(MAPLIBRE_DIST_DIR, asset)), asset)
    }
  })

  test("every file it names is in the installed package", () => {
    for (const asset of MAPLIBRE_WORKER_ASSETS) {
      assert.ok(existsSync(path.join(APP_DIR, MAPLIBRE_DIST_DIR, asset)), asset)
    }
  })
})
