// Applications and their Decisions (M7 of #293) as drizzle-kit writes them:
// an Application over its project, its kind, status and channel read off the
// Registry's vocabulary, its subject the customer and one place at most, its
// number the company's own; and the Decisions, a ledger, a refusal in force
// for no period and anything less than a grant in full saying how to appeal.
// The outbox's two checks grow by the Registry's `application-decided` on an
// `application`, the seam each kind's effect is consumed from in its owner's
// lane. Then migration 0040, which has to begin with exactly those
// statements and carry below them the two tables' fences, the Application's trigger and the
// Decisions' revoke, and the Application's audit trail
// (`APPLICATIONS_AUDITED`). No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { APPLICATION_CHANNELS, APPLICATION_KINDS, APPLICATION_STATUSES, DECISION_OUTCOMES } from "@waste/domain/registry/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { userAccount } from "../schema/access"
import { subscription } from "../schema/agreements"
import { application, applicationDecision } from "../schema/applications"
import { customer, property, sharedCollectionPoint } from "../schema/customers"
import { company, project } from "../schema/organisation"
import { APPLICATIONS_AUDITED, auditTrail, EXEMPT } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, list, ref } from "./rendering"
import { OUTBOX_AGGREGATES_AS_OF_0040, OUTBOX_KINDS_AS_OF_0040, outboxEventAsOf0010, outboxEventAsOf0040 } from "./outbox-as-of"
import { statementsBetween } from "./specimen"

const MIGRATION = "0040_applications.sql"

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))
/** The tables the two name, the same on both sides of the diff. */
const referenced = { company, project, customer, property, sharedCollectionPoint, subscription, userAccount }

/** What drizzle-kit writes for 0040: the two tables, and the outbox from its 0010 spelling to its 0040 one (outbox-as-of.ts; 0054 grew it again). */
const generated = (): Promise<string[]> => statementsBetween({ ...referenced, outboxEvent: outboxEventAsOf0010 }, { ...referenced, outboxEvent: outboxEventAsOf0040, application, applicationDecision })

const decision = (column: string) => ref("application_decision", column)
const PERIOD = `case when ${decision("outcome")} = 'refused' then ${decision("granted_from")} is null and ${decision("granted_to")} is null else ${decision("granted_from")} is not null and (${decision("granted_to")} is null or ${decision("granted_to")} > ${decision("granted_from")}) end`
const APPEAL = `${decision("outcome")} = 'granted' or length(btrim(coalesce(${decision("appeal_text")}, ''))) > 0`

describe("the applications as drizzle-kit writes them", () => {
  test("migration 0040 is exactly what the schema generates, then the fences, the Application's trigger, the Decisions' revoke and the audit trail", async () => {
    assert.deepEqual(await fileStatements(), [...(await generated()), ...[application, applicationDecision].flatMap((table) => handWrittenStatements(table)), ...APPLICATIONS_AUDITED.flatMap(auditTrail)].map(normalised))
  })

  test("an Application names its customer within the tenant, and its place and subscription within its project", async () => {
    const keys = (await generated()).filter((statement) => statement.includes("FOREIGN KEY") && statement.startsWith('ALTER TABLE "wms"."application" '))
    assert.deepEqual(
      keys.map((statement) => statement.match(/FOREIGN KEY \(([^)]*)\) REFERENCES "wms"\."([a-z_]+)"/)?.slice(1, 3).join(" → ")),
      [
        '"company_id" → company',
        '"company_id","project_id" → project',
        '"company_id","customer_id" → customer',
        '"company_id","project_id","property_id" → property',
        '"company_id","project_id","shared_collection_point_id" → shared_collection_point',
        '"company_id","project_id","subscription_id" → subscription',
      ],
    )
  })
})

describe("the outbox", () => {
  test("its two checks are dropped and added again, grown by the decided application", async () => {
    const outbox = (await generated()).filter((statement) => statement.includes('"wms"."outbox_event"'))
    assert.deepEqual(outbox, [
      'ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_kind_one_of";',
      'ALTER TABLE "wms"."outbox_event" DROP CONSTRAINT "outbox_event_aggregate_kind_one_of";',
      `ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_kind_one_of" CHECK (${ref("outbox_event", "kind")} in (${list(...OUTBOX_KINDS_AS_OF_0040)}));`,
      `ALTER TABLE "wms"."outbox_event" ADD CONSTRAINT "outbox_event_aggregate_kind_one_of" CHECK (${ref("outbox_event", "aggregate_kind")} in (${list(...OUTBOX_AGGREGATES_AS_OF_0040)}));`,
    ])
    assert.equal(OUTBOX_KINDS_AS_OF_0040.at(-1), "application-decided")
    assert.equal(OUTBOX_AGGREGATES_AS_OF_0040.at(-1), "application")
  })
})

describe("the checks", () => {
  test("an Application's kind, status and channel are the Registry's vocabulary, one place at most, and a statement given", () => {
    assert.deepEqual([...checksOf(application).keys()], ["application_kind_one_of", "application_status_one_of", "application_channel_one_of", "application_one_place", "application_statement_given"])
    assert.equal(checksOf(application).get("application_kind_one_of"), `${ref("application", "kind")} in (${list(...APPLICATION_KINDS)})`)
    assert.equal(checksOf(application).get("application_status_one_of"), `${ref("application", "status")} in (${list(...APPLICATION_STATUSES)})`)
    assert.equal(checksOf(application).get("application_channel_one_of"), `${ref("application", "channel")} in (${list(...APPLICATION_CHANNELS)})`)
    assert.equal(checksOf(application).get("application_one_place"), `${ref("application", "property_id")} is null or ${ref("application", "shared_collection_point_id")} is null`)
  })

  test("a Decision's outcome is the vocabulary's, a refusal has no period and a grant its first day, and less than a grant in full says how to appeal", () => {
    assert.deepEqual([...checksOf(applicationDecision).keys()], ["application_decision_outcome_one_of", "application_decision_period_shape", "application_decision_appeal_shape"])
    assert.equal(checksOf(applicationDecision).get("application_decision_outcome_one_of"), `${decision("outcome")} in (${list(...DECISION_OUTCOMES)})`)
    assert.equal(checksOf(applicationDecision).get("application_decision_period_shape"), PERIOD)
    assert.equal(checksOf(applicationDecision).get("application_decision_appeal_shape"), APPEAL)
  })

  test("the Application is audited under its module, the Decisions are a ledger and exempt", () => {
    assert.deepEqual(APPLICATIONS_AUDITED.map((entry) => [entry.table, entry.module, entry.parent]), [[application, "customers.applications", undefined]])
    assert.ok(EXEMPT.some((entry) => entry.table === applicationDecision && /ledger/.test(entry.why)))
  })
})
