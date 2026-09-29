// A Pilot backup's manifest (src/pilot/backup.ts), for the scripts and the
// workflow:
//
//   manifest.ts write    BACKUP_DIR, CLIENT_VERSION and the run from
//                        GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT and GITHUB_SHA:
//                        pilot-backup.sh's step 3
//   manifest.ts verify   RESTORE_DIR and, for a restore, SOURCE_RUN_ID,
//                        SOURCE_ATTEMPT and SOURCE_COMMIT: the decrypted
//                        backup proved against its own manifest, then against
//                        this database and the run whose artifact it was,
//                        before anything is dropped
//
// Both read DATABASE_ADMIN_URL and refuse a URL that is not the Pilot's
// (PILOT_SUPABASE_REF) or, without one, the local stack.
import { createDb } from "../../src/client"
import { checkRestoreTarget, verifyBackup, writeManifest } from "../../src/pilot/backup"
import { databaseIdentity, expectPilot } from "../../src/pilot/identity"
import { required, step, summary } from "../step"

await step(async () => {
  const [mode] = process.argv.slice(2)
  const url = required("DATABASE_ADMIN_URL")
  expectPilot(url, process.env.PILOT_SUPABASE_REF)
  if (mode === "write") {
    const manifest = await writeManifest(required("BACKUP_DIR"), {
      url,
      run: { id: process.env.GITHUB_RUN_ID ?? "local", attempt: process.env.GITHUB_RUN_ATTEMPT ?? "1" },
      commit: process.env.GITHUB_SHA ?? "0".repeat(40),
      clientVersion: required("CLIENT_VERSION"),
    })
    summary(
      `Backup of ${manifest.identity}: schemas ${manifest.schemas.join(", ")}, ${manifest.journal.applied} journal rows (last ${manifest.journal.last ?? "none"}), fingerprint sha256 ${manifest.fingerprint.sha256}`,
    )
  } else if (mode === "verify") {
    const manifest = verifyBackup(required("RESTORE_DIR"))
    const { sql, close } = createDb(url, { max: 1 })
    let identity: string
    try {
      identity = await databaseIdentity(sql, url)
    } finally {
      await close()
    }
    const source = process.env.SOURCE_RUN_ID === undefined ? {} : { commit: required("SOURCE_COMMIT"), run: { id: required("SOURCE_RUN_ID"), attempt: required("SOURCE_ATTEMPT") } }
    checkRestoreTarget(manifest, { identity, ...source })
    summary(
      `Verified a backup of ${manifest.identity} at commit ${manifest.commit}, taken ${manifest.createdAt} by run ${manifest.run.id} attempt ${manifest.run.attempt}: ${manifest.journal.applied} journal rows, schemas ${manifest.schemas.join(", ")}, every file as recorded`,
    )
  } else {
    throw new Error("usage: manifest.ts write | verify")
  }
})
