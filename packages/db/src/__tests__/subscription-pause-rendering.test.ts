// A Subscription's pause (#291, slice 10) as drizzle-kit writes it: one
// effective-dated table of the subscription, keyed to it with the project
// (a pause is its subscription's project's), indexed by it for the matcher's
// lookup. Then migration 0025, which has to begin with exactly those
// statements and carry below them the table's fence and trigger, the
// exclusion constraint that holds one pause of a subscription in force at a
// time, the audit trail's trigger, the pause a set of its subscription, and
// the public door's grant and policy, since a paused address shows no
// collection day — and nothing else. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { MIGRATIONS_FOLDER } from "../migrate"
import { subscriptionPause } from "../schema/agreements"
import { auditTrail, SUBSCRIPTION_PAUSE_AUDITED } from "../sql/audit-trail"
import { excludeOverlapping } from "../sql/exclude-overlapping"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { SUBSCRIPTION_PAUSE_DOOR, subscriptionPauseDoorStatements } from "../sql/public-door"
import { companyFk, createTable, index, projectFk, projectFkTo, validityCheck } from "./rendering"
import { statementsFor } from "./specimen"

const MIGRATION = "0025_subscription_pause.sql"

const expected = [
  createTable("subscription_pause", "dated", ['"subscription_id" uuid NOT NULL', validityCheck("subscription_pause")]),
  companyFk("subscription_pause"),
  projectFk("subscription_pause"),
  projectFkTo("subscription_pause", "subscription_id", "subscription"),
  index("subscription_pause", "subscription_pause_subscription_id_idx", "company_id", "subscription_id"),
]

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("a subscription's pause as drizzle-kit writes it", () => {
  test("one effective-dated table of the subscription, keyed with the project and indexed by it", async () => {
    assert.deepEqual(await statementsFor({ subscriptionPause }), expected)
  })
})

describe("migration 0025", () => {
  test("the public door reads the pause's period under its subscription and its keys, nothing more, under one policy", () => {
    assert.deepEqual(SUBSCRIPTION_PAUSE_DOOR.map(({ columns }) => columns.length), [5])
    const statements = subscriptionPauseDoorStatements()
    assert.equal(statements.filter((statement) => statement.startsWith("GRANT SELECT (")).length, 1)
    assert.equal(statements.filter((statement) => statement.startsWith("CREATE POLICY ")).length, 1)
  })

  test("is exactly that, then the fence and the trigger, the exclusion over the subscription, the audit trail as a set of the subscription, and the public door's grant and policy", async () => {
    assert.deepEqual(SUBSCRIPTION_PAUSE_AUDITED.map((entry) => [entry.table, entry.module]), [[subscriptionPause, "customers.agreements"]], "the pause, audited under the agreements' grant")
    assert.deepEqual(
      await fileStatements(),
      [...expected, ...handWrittenStatements(subscriptionPause), ...excludeOverlapping(subscriptionPause, [subscriptionPause.subscriptionId]), ...SUBSCRIPTION_PAUSE_AUDITED.flatMap(auditTrail), ...subscriptionPauseDoorStatements()].map(normalised),
    )
  })
})
