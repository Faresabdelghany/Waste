// `pnpm --filter @waste/db pgboss-plan`: pg-boss's schema as the pinned
// pg-boss would install it, in the shape a migration file carries — its
// transaction wrapper dropped, one statement per `--> statement-breakpoint`
// (see src/sql/pgboss.ts). `0011_worker.sql` was written from this output;
// a pg-boss upgrade whose schema version moves gets a new file from
// `getMigrationPlans(PGBOSS_SCHEMA, PGBOSS_SCHEMA_VERSION)` run through the
// same splitter, never an edit to an applied one. Prints to stdout; redirect
// or paste.
import { getConstructionPlans } from "pg-boss"

import { PGBOSS_SCHEMA, pgbossSchemaVersionOf, pgbossStatementsOf } from "../src/sql/pgboss"

const plan = getConstructionPlans(PGBOSS_SCHEMA)
console.log(`-- pg-boss schema version ${pgbossSchemaVersionOf(plan)}, as getConstructionPlans("${PGBOSS_SCHEMA}") of the pinned pg-boss writes it.`)
console.log(pgbossStatementsOf(plan).join("\n--> statement-breakpoint\n"))
