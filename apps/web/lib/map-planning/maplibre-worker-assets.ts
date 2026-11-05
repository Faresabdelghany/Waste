// The MapLibre worker files app/maplibre/[version]/[asset]/route.ts serves
// from the installed package. next.config.mjs names the same files in
// `outputFileTracingIncludes`, so a deployment ships them where the route
// reads them; lib/__tests__/maplibre-worker-trace.test.ts holds the two equal.

export const MAPLIBRE_WORKER_ASSETS: ReadonlySet<string> = new Set([
  "maplibre-gl-worker.mjs",
  "maplibre-gl-worker-dev.mjs",
  "maplibre-gl-shared.mjs",
  "maplibre-gl-shared-dev.mjs",
])

/** Where the route reads them, relative to the app's directory (the server's working directory). */
export const MAPLIBRE_DIST_DIR = "node_modules/maplibre-gl/dist"
