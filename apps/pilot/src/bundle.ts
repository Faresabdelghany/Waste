// The bundle step of the Pilot image (#134, gate 1's finding): one app entry
// into a single ESM file with esbuild — the workspace packages' TypeScript
// and the npm dependencies inlined, Node's built-ins left native — so the
// image runs plain node with no tsx loader at boot and no esbuild service
// per child. Measured on Suga at a tenth of a core: tsx took 100–145 s to
// boot both apps, the bundles 13–18 s. No line of either app changes for it.
//
// Run by the Dockerfile's build stage once per entry, as this package's
// `bundle` script, from anywhere in the installed workspace:
//
//     pnpm --filter @waste/pilot bundle <app> <entry.ts> <outfile.mjs>
//
// `app` is the directory under apps/ whose dependencies the entry resolves
// against and whose tsconfig esbuild reads; the outfile is absolute or
// relative to the working directory. The banner gives the bundle a
// `require`, since a CommonJS dependency inlined into ESM may call it at run
// time (pg's optional pg-native, among others); the two externals are
// requires that never resolve in this image and are meant not to.
import { createRequire } from "node:module"
import path from "node:path"

/** What a dependency may `require` and the image never has: pg's native binding, and the Cloudflare sockets postgres.js probes for. */
export const EXTERNALS = ["pg-native", "cloudflare:sockets"]

export type BundleOptions = {
  /** The entry file, absolute. */
  entry: string
  /** Where the bundle is written, absolute; its directory is made. */
  outfile: string
  /** The app's tsconfig, for esbuild's compiler options. */
  tsconfig: string
  /** The directory whose node_modules the entry's dependencies resolve from when the walk up from the entry finds none: the app's own. */
  resolveFrom: string
}

export async function bundleEntry({ entry, outfile, tsconfig, resolveFrom }: BundleOptions): Promise<{ bytes: number }> {
  // esbuild as this package depends on it; a bare import resolves up from the importing file as Node does, and from the app's node_modules after that.
  const esbuild = await import("esbuild")
  const result = await esbuild.build({
    entryPoints: [entry],
    outfile,
    absWorkingDir: resolveFrom,
    nodePaths: [path.join(resolveFrom, "node_modules")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    sourcemap: false,
    minify: false,
    metafile: true,
    external: EXTERNALS,
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
    tsconfig,
    logLevel: "warning",
  })
  const bytes = Object.values(result.metafile.outputs).reduce((sum, output) => sum + output.bytes, 0)
  return { bytes }
}

/** The repository root: this file is apps/pilot/src/bundle.ts. */
export const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "../../..")

// The command line: `<app> <entry.ts> <outfile.mjs>`.
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const [app, entry, outfile] = process.argv.slice(2)
  if (app === undefined || entry === undefined || outfile === undefined) {
    console.error("usage: pnpm --filter @waste/pilot bundle <app> <entry.ts> <outfile.mjs>")
    process.exit(2)
  }
  const appDir = path.join(REPOSITORY_ROOT, "apps", app)
  // The app's manifest must resolve from here, so a typo in `app` fails before esbuild runs.
  createRequire(`${appDir}/package.json`)(`${appDir}/package.json`)
  const { bytes } = await bundleEntry({ entry: path.join(appDir, "src", entry), outfile: path.resolve(outfile), tsconfig: path.join(appDir, "tsconfig.json"), resolveFrom: appDir })
  console.log(`${app}: ${outfile} ${(bytes / 1024).toFixed(0)} KiB`)
}
