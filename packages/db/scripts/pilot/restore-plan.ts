// Prints the arguments `pilot-restore.sh apply` hands psql, one per line, from
// the verified backup in RESTORE_DIR (src/pilot/backup.ts, restorePlan): the
// drop, the schema dumps, the publication's tables, the data dumps.
import { restorePlan, verifyBackup } from "../../src/pilot/backup"
import { required } from "../step"

const dir = required("RESTORE_DIR")
process.stdout.write(`${restorePlan(verifyBackup(dir), dir).join("\n")}\n`)
