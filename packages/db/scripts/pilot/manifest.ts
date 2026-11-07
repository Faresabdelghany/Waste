// pilot-backup.sh's step 4 (src/pilot/backup.ts): the manifest and the
// fingerprint written beside the dumps in BACKUP_DIR, for DATABASE_ADMIN_URL,
// with CLIENT_VERSION and the run and the commit the caller passes as
// GITHUB_RUN_ID, GITHUB_RUN_ATTEMPT and GITHUB_SHA. Its caller is
// `backUpDatabase` (src/pilot/backup-scripts.ts), whose callers hold the URL
// to the Pilot or the local stack before they hand it over.
import { writeManifest } from "../../src/pilot/backup"
import { required, step, summary } from "../step"

await step(async () => {
  const manifest = await writeManifest(required("BACKUP_DIR"), {
    url: required("DATABASE_ADMIN_URL"),
    run: { id: required("GITHUB_RUN_ID"), attempt: required("GITHUB_RUN_ATTEMPT") },
    commit: required("GITHUB_SHA"),
    clientVersion: required("CLIENT_VERSION"),
  })
  summary(
    `Backup of ${manifest.identity}: schemas ${manifest.schemas.join(", ")}, ${manifest.journal.applied} journal rows (last ${manifest.journal.last ?? "none"}), fingerprint sha256 ${manifest.fingerprint.sha256}`,
  )
})
