// The CSV import's record (#291 slice 12, row 20.1, migration 0020): one
// `import_run` per file committed and one `import_run_row` per row it
// recorded. A preview stores nothing; a run is made when a person commits a
// file, and each batch of its rows appends their outcomes here in the
// transaction that wrote them, so a run says exactly what it did, row by
// row, the refusals in the API's own sentence.
//
// `import_run` is current state, `timestamps` and the trigger: its counts
// move as its batches land. It is the company's, since a Customers file
// belongs to no project; a project's kinds name the project they were
// imported into, a Customers run none (`import_run_project_shape`). The
// counts never pass the rows the file was said to hold
// (`import_run_counts_shape`), and the run is complete when they reach it — a
// reading, never a column. `import_run_row` is a ledger, `recorded` and the
// revoke: an outcome is never rewritten. A row is recorded once per run
// (`import_run_row_import_run_id_row_number_key`), which is what makes a
// batch sent twice write nothing twice; its row number is a spreadsheet's,
// the header being row 1. A refusal carries its sentence and names no record,
// and every other outcome names the record it made or matched and carries no
// sentence (`import_run_row_outcome_shape`). `resource_id` is a soft uuid, as
// `outbox_event.aggregate_id` is: the record is a customer's, a property's, a
// container's, an agreement's or a subscription's by the run's kind, and a
// key could point at one table only.
//
// Neither table is audited: a run is the import's own log, as a generation
// run is, and its rows a ledger, which carries its own history.
import { IMPORT_KINDS, IMPORT_ROW_OUTCOMES } from "@waste/domain/imports/vocabulary"
import { sql } from "drizzle-orm"
import { check, integer, text, uuid } from "drizzle-orm/pg-core"

import { tableObjectName } from "../names"
import { userAccount } from "./access"
import { oneOf, positive } from "./checks"
import { id, recorded, tenant, timestamps } from "./columns"
import { company, project } from "./organisation"
import { companyReference, tenantIndex, tenantKey, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const importRun = wms.table(
  "import_run",
  {
    ...id,
    ...tenant,
    ...timestamps,
    /** The project the records were imported into; null for the company's Customers. */
    projectId: uuid(),
    kind: text().notNull(),
    /** The file's name as the browser read it. */
    fileName: text().notNull(),
    /** How many rows the file held; the run is complete when its counts reach it. */
    rowCount: integer().notNull(),
    createdCount: integer().notNull().default(0),
    updatedCount: integer().notNull().default(0),
    unchangedCount: integer().notNull().default(0),
    refusedCount: integer().notNull().default(0),
    /** Who committed the file. */
    requestedBy: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantReference(t, [t.requestedBy], userAccount),
    // A run's rows name it.
    tenantKey(t),
    oneOf(t.kind, IMPORT_KINDS),
    positive(t.rowCount),
    // A project's kinds name their project, the company's Customers none.
    check(tableObjectName(t.id.table, "project_shape", "importRun"), sql`(${t.kind} = 'customers') = (${t.projectId} is null)`),
    // Never fewer than none, never more than the file held.
    check(
      tableObjectName(t.id.table, "counts_shape", "importRun"),
      sql`${t.createdCount} >= 0 and ${t.updatedCount} >= 0 and ${t.unchangedCount} >= 0 and ${t.refusedCount} >= 0 and ${t.createdCount} + ${t.updatedCount} + ${t.unchangedCount} + ${t.refusedCount} <= ${t.rowCount}`,
    ),
    tenantIndex(t, t.projectId),
    tenantIndex(t, t.requestedBy),
  ],
)

export const importRunRow = wms.table(
  "import_run_row",
  {
    ...id,
    ...tenant,
    ...recorded,
    importRunId: uuid().notNull(),
    /** The spreadsheet's row number: the header is row 1. */
    rowNumber: integer().notNull(),
    outcome: text().notNull(),
    /** What the row was matched on, as a person reads it. */
    key: text(),
    /** The record the row made or matched, of the run's kind: a soft uuid. */
    resourceId: uuid(),
    /** A refusal's sentence. */
    detail: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.importRunId], importRun),
    // A row is recorded once per run; leading with the run, it is the reference's index and the run's list too.
    tenantUnique(t, t.importRunId, t.rowNumber),
    oneOf(t.outcome, IMPORT_ROW_OUTCOMES),
    check(tableObjectName(t.id.table, "row_number_shape", "importRunRow"), sql`${t.rowNumber} >= 2`),
    // A refusal says why and names no record; every other outcome names its record and says nothing.
    check(
      tableObjectName(t.id.table, "outcome_shape", "importRunRow"),
      sql`(${t.outcome} = 'refused') = (${t.detail} is not null) and (${t.outcome} = 'refused') = (${t.resourceId} is null)`,
    ),
  ],
)
