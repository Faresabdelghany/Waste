// Prints the arguments `pilot-restore.sh apply` hands psql, one per line, from
// the verified backup in RESTORE_DIR (src/pilot/backup.ts, restorePlan): the
// drop, the schema dumps, the publication's tables, the data dumps.
import { restorePlan, verifyBackup } from "../../src/pilot/backup"

const dir = process.env.RESTORE_DIR
if (!dir) {
  console.error("restore-plan: RESTORE_DIR is not set")
  process.exit(1)
}
process.stdout.write(`${restorePlan(verifyBackup(dir), dir).join("\n")}\n`)
