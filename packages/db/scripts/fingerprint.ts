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

import { FINGERPRINT_FILE, fingerprintDatabase, fingerprintDigest, requireFingerprint } from "../src/fingerprint"
import { required, step } from "./step"

await step(async () => {
  const url = required("DATABASE_ADMIN_URL")
  const [mode, file] = process.argv.slice(2)
  if (mode !== undefined && mode !== "--write" && mode !== "--check") throw new Error(`Unknown argument ${mode}: pnpm db:fingerprint [--write | --check [file]]`)
  if (mode === "--check") {
    await requireFingerprint(url, (line) => console.log(line), file === undefined ? undefined : { text: readFileSync(file, "utf8"), name: file })
    return
  }
  const actual = await fingerprintDatabase(url)
  if (mode === undefined) {
    process.stdout.write(actual)
  } else {
    writeFileSync(FINGERPRINT_FILE, actual)
    console.log(`@waste/db: wrote ${FINGERPRINT_FILE} (sha256 ${fingerprintDigest(actual)})`)
  }
})
