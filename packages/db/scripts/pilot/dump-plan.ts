// Prints what pilot-backup.sh dumps, one schema per line — the schema,
// `required` or `optional`, its schema file and its data file
// (src/pilot/backup.ts, dumpPlan) — so the shell spells no schema and no file
// name of its own.
import { dumpPlan } from "../../src/pilot/backup"

const lines = dumpPlan().map(({ schema, required, schemaFile, dataFile }) => `${schema} ${required ? "required" : "optional"} ${schemaFile} ${dataFile}`)
process.stdout.write(`${lines.join("\n")}\n`)
