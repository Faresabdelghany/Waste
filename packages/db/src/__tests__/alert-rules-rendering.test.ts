// The worker's alert rules (O4 of #290) as drizzle-kit writes them: the rule
// and the occurrence an alert was raised for, held together and unique per
// company across every status; a ticket as a subject; and a rule's alert
// resolvable with no account — nine statements diffed from the alert as 0009
// left it (alert-as-of.ts), since an applied file is never edited;
// resolution-rendering.test.ts maps today's table back. Then migration 0034,
// which is exactly those statements under its header: no table is new, so
// nothing is hand-written, and every row present passes the widened checks
// and names no rule, so nothing is guarded. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { ALERT_RULES } from "@waste/domain/resolution/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { userAccount } from "../schema/access"
import { container } from "../schema/containers"
import { route } from "../schema/execution"
import { driver, vehicle } from "../schema/fleet"
import { company, project } from "../schema/organisation"
import { alert, ticket } from "../schema/resolution"
import { normalised, statementsOf } from "../sql/hand-written"
import { alertAsOf0009, RESOLVED_SHAPE, RULE_KEY_INDEX, RULE_SHAPE, SUBJECT_SHAPE } from "./alert-as-of"
import { checksOf, list, ref } from "./rendering"
import { statementsBetween } from "./specimen"

const MIGRATION = "0034_alert_rules.sql"

const referenced = { company, project, route, vehicle, driver, container, ticket, userAccount }

const column = (name: string) => ref("alert", name)

describe("the alert rules as drizzle-kit writes them", () => {
  const generated = statementsBetween({ ...referenced, alert: alertAsOf0009 }, { ...referenced, alert })

  test("the rule and its occurrence, one alert per occurrence whatever its status, a ticket as a subject, and a rule's alert resolved by nobody", async () => {
    assert.deepEqual(await generated, [
      'ALTER TABLE "wms"."alert" DROP CONSTRAINT "alert_subject_shape";',
      'ALTER TABLE "wms"."alert" DROP CONSTRAINT "alert_resolved_shape";',
      'ALTER TABLE "wms"."alert" ADD COLUMN "rule" text;',
      'ALTER TABLE "wms"."alert" ADD COLUMN "rule_key" text;',
      RULE_KEY_INDEX,
      `ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_rule_one_of" CHECK (${column("rule")} in (${list(...ALERT_RULES)}));`,
      `ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_rule_shape" CHECK (${RULE_SHAPE});`,
      `ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_subject_shape" CHECK (${SUBJECT_SHAPE});`,
      `ALTER TABLE "wms"."alert" ADD CONSTRAINT "alert_resolved_shape" CHECK (${RESOLVED_SHAPE});`,
    ])
  })

  test("migration 0034 is exactly those statements", async () => {
    const statements = statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
    assert.deepEqual(statements, (await generated).map(normalised))
  })

  test("the checks render without parameters", () => {
    assert.equal(checksOf(alert).get("alert_rule_shape"), RULE_SHAPE)
    assert.equal(checksOf(alert).get("alert_resolved_shape"), RESOLVED_SHAPE)
  })
})
