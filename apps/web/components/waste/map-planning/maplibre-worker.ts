// MapLibre 6 derives its module-worker URL from its own module URL, which
// Turbopack's chunking breaks (the worker never starts, no tile loads). The
// route handler at app/maplibre/[version]/[asset] serves the worker and its
// shared chunk from the installed package; the version stamp keeps the
// immutable cache honest across upgrades. Every map in the app — the
// planning map and, since Issue #39, the guided setup's route map — points
// the worker there through this one call before it constructs a Map.

import { getVersion, setWorkerUrl } from "maplibre-gl"

export function pointMapLibreWorkerAtRouteHandler(): void {
  setWorkerUrl(`/maplibre/${getVersion()}/maplibre-gl-worker.mjs`)
}
