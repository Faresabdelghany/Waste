// The `repair` operation (src/pilot/repair.ts): REPAIR_ID, validated and
// resolved through the committed allow-list (scripts/repairs/index.ts) and
// never through a path, run once against DATABASE_ADMIN_URL under the
// migration lock. Says only the outcome: no row data, no secret.
import { expectPilot } from "../../src/pilot/identity"
import { runRepair } from "../../src/pilot/repair"
import { ACTIVE_REPAIRS } from "../repairs/index"
import { required, step, summary } from "../step"

await step(async () => {
  const url = required("DATABASE_ADMIN_URL")
  expectPilot(url, process.env.PILOT_SUPABASE_REF)
  const id = required("REPAIR_ID")
  const outcome = await runRepair(url, id, ACTIVE_REPAIRS)
  summary(outcome === "applied" ? `Repair ${id} applied; its postcondition holds` : `Repair ${id} was already applied; its postcondition holds and nothing was written`)
})
