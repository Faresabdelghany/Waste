// Prints libpq's environment for DATABASE_ADMIN_URL as `export` lines, for
// pilot-backup.sh and pilot-restore.sh to evaluate (src/pilot/pg-env.ts says
// why), and PILOT_PAUSED_HINT beside them: the sentence the scripts add when
// a Supabase project does not answer (src/pilot/identity.ts's, spelled once),
// empty for the local stack. Its output holds the password: the scripts
// capture it into a shell variable and evaluate it, and never print it or
// write it down.
import { PAUSED_HINT, targetOfUrl } from "../../src/pilot/identity"
import { libpqEnvironment, shellExports } from "../../src/pilot/pg-env"
import { required } from "../step"

const url = required("DATABASE_ADMIN_URL")
let hint = ""
try {
  if (targetOfUrl(url).kind === "supabase") hint = PAUSED_HINT
} catch {
  // A host that is neither a Supabase project nor the local stack: the connection attempt says so itself.
}
process.stdout.write(`${shellExports({ ...libpqEnvironment(url), PILOT_PAUSED_HINT: hint })}\n`)
