// How the SAF-T test validates a file (#291 C7b): against Erhvervsstyrelsen's
// own schema, Danish_SAF-T_Financial_Schema_v_2_1.xsd, through xmllint. The
// schema is not ours to vendor — its repository carries no licence — so the
// test fetches it from a pinned commit and checks it against its digest,
// keeping it in the temp directory for the next run. Like the database
// (`databaseUnderTest`), it skips with the reason when the schema cannot be
// fetched or xmllint is not there, and fails instead under REQUIRE_SAFT_XSD,
// which CI sets, so CI can never pass by skipping.
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

/** The variable CI sets so that the SAF-T schema test may not skip. */
export const REQUIRE_SAFT_XSD = "REQUIRE_SAFT_XSD"

/** The schema at the commit of git.erst.dk/standard-filformater it was read at, and its digest. */
export const SAF_T_XSD_URL = "https://git.erst.dk/standard-filformater/standard-filformater/-/raw/f145639aa044fffa12d1ee291d9bf499c8cc8b91/SAF-T/XSD/Danish_SAF-T_Financial_Schema_v_2_1.xsd"
export const SAF_T_XSD_SHA256 = "01cd75f7bf10f1cdab00b48ea2579e97647d7d01fa00862f76edd5d0a6ad8ec3"

export type SchemaUnderTest = {
  /** A string reason when the test must be skipped, false when it can run. */
  skip: string | false
  /** The schema's file. */
  path: string
}

const digestOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

/** The schema's bytes, fetched with one retry; or why not. */
async function fetched(): Promise<Uint8Array | string> {
  let why = ""
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(SAF_T_XSD_URL, { signal: AbortSignal.timeout(20_000) })
      if (!response.ok) {
        why = `${SAF_T_XSD_URL} answered ${response.status}`
        continue
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (digestOf(bytes) === SAF_T_XSD_SHA256) return bytes
      why = `${SAF_T_XSD_URL} is not the schema pinned (sha256 ${SAF_T_XSD_SHA256})`
    } catch (error) {
      why = `${SAF_T_XSD_URL} could not be fetched: ${(error as Error).message}`
    }
  }
  return why
}

export async function safTSchemaUnderTest(env: Readonly<Record<string, string | undefined>> = process.env): Promise<SchemaUnderTest> {
  const file = path.join(tmpdir(), `waste-saf-t-${SAF_T_XSD_SHA256.slice(0, 16)}.xsd`)
  const why = await (async () => {
    if (spawnSync("xmllint", ["--version"]).error !== undefined) return "xmllint is not on the PATH: install libxml2 (libxml2-utils on Debian and Ubuntu)"
    if (existsSync(file) && digestOf(new Uint8Array(readFileSync(file))) === SAF_T_XSD_SHA256) return undefined
    const bytes = await fetched()
    if (typeof bytes === "string") return bytes
    writeFileSync(file, bytes)
    return undefined
  })()
  if (why === undefined) return { skip: false, path: file }
  const value = env[REQUIRE_SAFT_XSD]
  if (value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false") throw new Error(`${REQUIRE_SAFT_XSD} is set, but ${why}`)
  return { skip: why, path: file }
}

/** xmllint's verdict on a file against the schema: null when it validates, else what it said. */
export function schemaErrors(schema: string, xml: string): string | null {
  const result = spawnSync("xmllint", ["--noout", "--schema", schema, "-"], { input: xml, encoding: "utf8" })
  return result.status === 0 ? null : result.stderr
}
