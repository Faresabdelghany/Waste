// MapLibre GL's tile worker (2026-09-16). MapLibre 6 runs its tile parsing in
// a module Worker whose URL it derives from its own module URL and which
// imports `./maplibre-gl-shared.mjs` beside it — a layout Turbopack's chunk
// URLs do not preserve, so the worker never starts and no tile ever loads.
// This handler serves the worker and its shared chunk verbatim from the
// installed package, same-origin, under a version-stamped path so the
// immutable cache header can never pin a stale copy across an upgrade.
// components/waste/map-planning/planning-map.tsx points setWorkerUrl here.

import { readFile } from "node:fs/promises"
import path from "node:path"

import { NextResponse } from "next/server"

const WORKER_ASSETS: ReadonlySet<string> = new Set([
  "maplibre-gl-worker.mjs",
  "maplibre-gl-worker-dev.mjs",
  "maplibre-gl-shared.mjs",
  "maplibre-gl-shared-dev.mjs",
])

const VERSION_SHAPE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/

const distDir = path.join(process.cwd(), "node_modules", "maplibre-gl", "dist")

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ version: string; asset: string }> },
) {
  const { version, asset } = await params
  if (!VERSION_SHAPE.test(version) || !WORKER_ASSETS.has(asset)) {
    return new NextResponse("Not found", { status: 404 })
  }
  try {
    // Read as text: a Buffer is no longer a valid Response body under
    // TypeScript 5.9 typings, and the worker is a UTF-8 JavaScript file anyway.
    const body = await readFile(path.join(distDir, asset), "utf8")
    return new NextResponse(body, {
      headers: {
        "Content-Type": "text/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    })
  } catch {
    return new NextResponse("Not found", { status: 404 })
  }
}
