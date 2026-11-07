// The modules a gated package ships, imported, for a test that holds every
// module's exports to one rule (contracts' int4 walk over every write body).
// The purity gate refuses a computed import in the package's own tests, so the
// walk's imports are made here, over the same shipping program the gate holds
// the package to: tsconfig.json's files, tests excluded. A module added to the
// package is walked without a line anywhere naming it.
import path from "node:path"
import { pathToFileURL } from "node:url"
import ts from "typescript"

/** The package's shipping modules by their path under src/ without the extension (`route-schemes`, `geo/rings`), each read as a namespace. */
export async function importShippingModules(packageDir: string): Promise<Record<string, Record<string, unknown>>> {
  const read = ts.readConfigFile(path.join(packageDir, "tsconfig.json"), ts.sys.readFile)
  if (read.error) throw new Error(`tsconfig.json: ${ts.flattenDiagnosticMessageText(read.error.messageText, " ")}`)
  const { fileNames } = ts.parseJsonConfigFileContent(read.config, ts.sys, packageDir)
  const srcDir = path.join(packageDir, "src")
  const modules: Record<string, Record<string, unknown>> = {}
  for (const file of [...fileNames].sort()) {
    const name = path.relative(srcDir, file).split(path.sep).join("/").replace(/\.ts$/, "")
    modules[name] = (await import(pathToFileURL(file).href)) as Record<string, unknown>
  }
  return modules
}
