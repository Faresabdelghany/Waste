// `node --import tsx src/operate.ts <operation> <phase>`: one phase of one of
// the Pilot's operations (operations.ts), as a step of
// .github/workflows/pilot-database.yml runs it, reading what it needs from the
// step's environment.
import { operateFromCommandLine } from "./operation"
import { OPERATIONS } from "./operations"

await operateFromCommandLine(OPERATIONS, process.argv.slice(2))
