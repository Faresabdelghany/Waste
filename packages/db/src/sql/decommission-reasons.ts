// The Decommission Reasons' first rows (O30 of #290, row 9.6): every company
// the migration finds starts with the domain's eight, and every decommission
// recorded before the reasons existed is given `other`, its free text kept as
// the note it already is (`stock_movement.reason`). The migration runs both
// after the column and before the shape check that asks every decommission
// for a reason, and before the reasons' audit trail, as the owner, who may
// write the ledger where the API role may not;
// decommission-reasons-rendering.test.ts pins them in the file. A company
// made later is given them by the seed, or by the office in Settings.
import { BACKFILLED_DECOMMISSION_REASON, DEFAULT_DECOMMISSION_REASONS } from "@waste/domain/resources/decommission-reasons"

import { literal } from "../schema/checks"

/** The statement that gives every company the reasons it starts with, leaving any it already holds by code. */
export function decommissionReasonsSeed(): string {
  const values = DEFAULT_DECOMMISSION_REASONS.map(({ code, name }) => `(${literal(code)}, ${literal(name)})`).join(", ")
  return (
    `INSERT INTO "wms"."decommission_reason" ("company_id", "code", "name") ` +
    `SELECT c."id", v."code", v."name" FROM "wms"."company" AS c CROSS JOIN (VALUES ${values}) AS v ("code", "name") ` +
    `ON CONFLICT ("company_id", "code") DO NOTHING;`
  )
}

/** The statement that gives every decommission without a reason its company's `other`. */
export function decommissionReasonsBackfill(): string {
  return (
    `UPDATE "wms"."stock_movement" AS m SET "decommission_reason_id" = r."id" FROM "wms"."decommission_reason" AS r ` +
    `WHERE r."company_id" = m."company_id" AND r."code" = ${literal(BACKFILLED_DECOMMISSION_REASON)} AND m."kind" = 'decommission' AND m."decommission_reason_id" IS NULL;`
  )
}
