// `pnpm --filter @waste/db fingerprint` (and `pnpm db:fingerprint` at the
// root): the complete fingerprint of Issue #152 for DATABASE_ADMIN_URL
// (src/fingerprint.ts says what it covers and what it normalises).
//
//   pnpm db:fingerprint                 prints it
//   pnpm db:fingerprint --write         regenerates migrations/meta/_fingerprint.txt;
//                                       run it on a local database the
//                                       migrations built whenever one is added
//   pnpm db:fingerprint --check [file]  compares the database with the
//                                       committed file (or with `file`, a
//                                       backup's recorded fingerprint) and
//                                       exits 1 naming every line that differs
//
// A fingerprint names objects and never data, so what `--check` prints is safe
// in a public log.
import { readFileSync, writeFileSync } from "node:fs"

import { compareFingerprints, committedFingerprint, FINGERPRINT_FILE, fingerprintDatabase, fingerprintDigest } from "../src/fingerprint"
import { required, step } from "./step"

await step(async () => {
  const url = required("DATABASE_ADMIN_URL")
  const [mode, file] = process.argv.slice(2)
  if (mode !== undefined && mode !== "--write" && mode !== "--check") throw new Error(`Unknown argument ${mode}: pnpm db:fingerprint [--write | --check [file]]`)
  const actual = await fingerprintDatabase(url)
  if (mode === undefined) {
    process.stdout.write(actual)
  } else if (mode === "--write") {
    writeFileSync(FINGERPRINT_FILE, actual)
    console.log(`@waste/db: wrote ${FINGERPRINT_FILE} (sha256 ${fingerprintDigest(actual)})`)
  } else {
    const expected = file === undefined ? committedFingerprint() : readFileSync(file, "utf8")
    const against = file === undefined ? "the committed fingerprint" : file
    const { missing, unexpected } = compareFingerprints(expected, actual)
    if (missing.length === 0 && unexpected.length === 0) {
      console.log(`@waste/db: ${new URL(url).hostname} matches ${against} (sha256 ${fingerprintDigest(actual)})`)
      return
    }
    for (const line of missing) console.error(`- ${line}`)
    for (const line of unexpected) console.error(`+ ${line}`)
    throw new Error(
      `@waste/db: ${new URL(url).hostname} differs from ${against} (expected sha256 ${fingerprintDigest(expected)}, found ${fingerprintDigest(actual)}): ${missing.length} line(s) expected and missing (-), ${unexpected.length} found and not expected (+)`,
    )
  }
})
