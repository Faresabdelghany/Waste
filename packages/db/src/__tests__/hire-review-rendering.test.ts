// The office's review of hires and jobs (M14 of #293) as drizzle-kit writes
// it: the project's `hold_for_review`, false unless set, and the billable
// event's hold — the instant, the person, the reason — with the person's key
// and index and `billable_event_hold_shape`: an instant and a reason
// together, a person only with them, and a priced event alone held; and a
// run's exclusion its two reasons for the held, its check spelt again. The
// migration is exactly those statements: no table is new, so nothing is
// written by hand. finance-rendering.test.ts spells the event's CREATE TABLE
// as of 0048 and organisation-access-rendering.test.ts the project's. The
// file is found by its name, not its number, which it takes at its turn. No
// database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { EXCLUSION_REASONS } from "@waste/domain/finance/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { billableEvent } from "../schema/finance"
import { statementsOf } from "../sql/hand-written"
import { checksOf, index, ref, tenantFk } from "./rendering"

const HOLD_SHAPE = `(${ref("billable_event", "held_at")} is null) = (${ref("billable_event", "hold_reason")} is null) and (${ref("billable_event", "held_by")} is null or ${ref("billable_event", "held_at")} is not null) and (${ref("billable_event", "held_at")} is null or ${ref("billable_event", "block_reason")} is null)`

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<string[]> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_hire_review\.sql$/.test(name))
  assert.ok(file !== undefined, "the hire review's migration")
  return statementsOf(await readFile(join(MIGRATIONS_FOLDER, file), "utf8"))
}

describe("the review of hires and jobs as drizzle-kit writes it", () => {
  test("the project's choice, the event's three columns, the person's key and index, the hold's shape and the exclusion's reasons: exactly the migration", async () => {
    assert.deepEqual(await migration(), [
      'ALTER TABLE "wms"."billing_run_exclusion" DROP CONSTRAINT "billing_run_exclusion_reason_one_of";',
      'ALTER TABLE "wms"."project" ADD COLUMN "hold_for_review" boolean DEFAULT false NOT NULL;',
      'ALTER TABLE "wms"."billable_event" ADD COLUMN "held_at" timestamp with time zone;',
      'ALTER TABLE "wms"."billable_event" ADD COLUMN "held_by" uuid;',
      'ALTER TABLE "wms"."billable_event" ADD COLUMN "hold_reason" text;',
      tenantFk("billable_event", "held_by", "user_account"),
      index("billable_event", "billable_event_held_by_idx", "company_id", "held_by"),
      `ALTER TABLE "wms"."billable_event" ADD CONSTRAINT "billable_event_hold_shape" CHECK (${HOLD_SHAPE});`,
      `ALTER TABLE "wms"."billing_run_exclusion" ADD CONSTRAINT "billing_run_exclusion_reason_one_of" CHECK (${ref("billing_run_exclusion", "reason")} in (${EXCLUSION_REASONS.map((reason) => `'${reason}'`).join(", ")}));`,
    ])
  })

  test("the hold's shape renders without parameters", () => {
    assert.equal(checksOf(billableEvent).get("billable_event_hold_shape"), HOLD_SHAPE)
  })
})
