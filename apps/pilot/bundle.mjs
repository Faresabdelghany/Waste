// PROTOTYPE — throwaway, ticket #134: bundles one app entry into a single
// ESM file with esbuild (tsx's own dependency), workspace TypeScript and npm
// dependencies inlined, Node built-ins native, so the image runs plain JS: no
// tsx loader at boot and no esbuild service per child. The measured reason: at
// 0.1 vCPU, tsx took 100–145 s to boot both apps on Suga; the bundles boot in
// a fraction of a second on a workstation.
//
//   node apps/pilot/bundle.mjs <api|worker> <entry.ts> <outfile.mjs>
import { createRequire } from "node:module"
const [app, entry, outfile] = process.argv.slice(2)
const require = createRequire(`${process.cwd()}/apps/${app}/package.json`)
const esbuild = require(require.resolve("esbuild", { paths: [require.resolve("tsx")] }))
const result = await esbuild.build({
  entryPoints: [`apps/${app}/src/${entry}`],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  minify: false,
  metafile: true,
  external: ["pg-native", "cloudflare:sockets"],
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  tsconfig: `apps/${app}/tsconfig.json`,
  logLevel: "warning",
})
const bytes = Object.values(result.metafile.outputs).reduce((sum, o) => sum + o.bytes, 0)
console.log(`${app}: ${outfile} ${(bytes / 1024).toFixed(0)} KiB`)
