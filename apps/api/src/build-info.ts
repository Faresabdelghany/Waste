// Which build this process is (Issue #152): the commit an image was built
// from, read once at startup from the file its Dockerfile wrote from the
// `SOURCE_COMMIT` build argument (apps/api/Dockerfile, beside the OCI
// `org.opencontainers.image.revision` label). Immutable build metadata, never
// an environment variable a host could set: the Pilot's release proves a
// deployment live by reading `build.commit` off GET /healthz. A checkout has
// no such file and answers null; an image whose file is there and says
// nothing usable does not start, since a probe that names no commit would
// hold every release until it timed out.
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { BuildInfo } from "@waste/contracts/health"

/** Where an image writes its build: the package's root, beside package.json. */
export const BUILD_INFO_FILE = fileURLToPath(new URL("../build.json", import.meta.url))

export function readBuildInfo(file: string = BUILD_INFO_FILE): BuildInfo | null {
  if (!existsSync(file)) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    parsed = undefined
  }
  const build = BuildInfo.safeParse(parsed)
  if (!build.success) throw new Error(`${file} does not say which commit this image was built from: expected {"commit": "<40 lowercase hex digits>"}`)
  return build.data
}
