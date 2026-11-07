// Prints every member a backup's archive may hold, one per line
// (src/pilot/backup.ts, backupMembers), so `pilot-restore.sh decrypt` spells
// no file name of its own when it refuses an archive that is not a backup's.
import { backupMembers } from "../../src/pilot/backup"

process.stdout.write(`${backupMembers().join("\n")}\n`)
