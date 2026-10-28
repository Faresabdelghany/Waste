// Recycling-centre visits (#393, M4 of #293) as drizzle-kit writes them: the
// register of Access Credentials, the Site Visit ledger and its fractions, and
// a project's Visit Rules with their ladders and free fractions, six tables
// with their keys and indexes as the schema spells them; and the ALTER TABLEs
// into the contexts before them — the product's unit grown by `visit`, the
// outbox's two checks by the visit's two kinds about a `site-visit`, and the
// billable event's `visit` kind, its clause of the kind's shape, the
// consumer's `visit-voided` reason, and the visit with its key, its index and
// its shape. The kind's shape is respelt whole, as Postgres has no ALTER for
// a check; finance-rendering.test.ts spells it out, so here it is read from
// the schema. Then the migration, whose head is exactly those statements and
// whose tail is each new table's fence and `updated_at` trigger, the
// credential's and the rule's no-overlap, and the audit triggers. The file is
// found by its name, not its number, which it takes at its turn. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { OUTBOX_AGGREGATES, OUTBOX_KINDS } from "@waste/domain/execution/vocabulary"
import { BILLABLE_EVENT_KINDS, CANCEL_REASONS } from "@waste/domain/finance/vocabulary"
import { PRODUCT_UNITS } from "@waste/domain/registry/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { billableEvent } from "../schema/finance"
import { accessCredential, siteVisit, siteVisitFraction, visitRule, visitRuleFreeFraction, visitRuleStep } from "../schema/site-visits"
import { auditTrail, SITE_VISITS_AUDITED } from "../sql/audit-trail"
import { excludeOverlapping } from "../sql/exclude-overlapping"
import { normalised, statementsOf } from "../sql/hand-written"
import { tenantFence } from "../sql/tenant-fence"
import { touchUpdatedAt } from "../sql/touch-updated-at"
import { checksOf, index, oneOfCheck, projectFkTo, ref } from "./rendering"
import { statementsFor } from "./specimen"

const NEW_TABLES = { accessCredential, siteVisit, siteVisitFraction, visitRule, visitRuleStep, visitRuleFreeFraction }

const alter = (table: string, statement: string): string => `ALTER TABLE "wms"."${table}" ${statement};`

/** The units 0054 wrote: every unit before the item, which a later migration added (#449). */
const UNITS_AS_OF_0054 = PRODUCT_UNITS.filter((unit) => unit !== "item")

/** The clause 0054 adds to the event's kind shape. */
const VISIT_CLAUSE = `when 'visit' then ${ref("billable_event", "visit_id")} is not null and ${ref("billable_event", "pickup_id")} is null and ${ref("billable_event", "ticket_id")} is null and ${ref("billable_event", "reverses_event_id")} is null`

/** What drizzle-kit wrote into the contexts before: the checks dropped, the visit's column, key and index, and the checks added again. */
const ALTERED = (): string[] => {
  const events = checksOf(billableEvent)
  return [
    alter("product", 'DROP CONSTRAINT "product_unit_one_of"'),
    alter("outbox_event", 'DROP CONSTRAINT "outbox_event_kind_one_of"'),
    alter("outbox_event", 'DROP CONSTRAINT "outbox_event_aggregate_kind_one_of"'),
    alter("billable_event", 'DROP CONSTRAINT "billable_event_kind_one_of"'),
    alter("billable_event", 'DROP CONSTRAINT "billable_event_cancel_reason_one_of"'),
    alter("billable_event", 'DROP CONSTRAINT "billable_event_kind_shape"'),
    alter("billable_event", 'ADD COLUMN "visit_id" uuid'),
    projectFkTo("billable_event", "visit_id", "site_visit"),
    index("billable_event", "billable_event_visit_id_idx", "company_id", "visit_id"),
    alter("product", `ADD ${oneOfCheck("product", "unit", ...UNITS_AS_OF_0054)}`),
    alter("outbox_event", `ADD ${oneOfCheck("outbox_event", "kind", ...OUTBOX_KINDS)}`),
    alter("outbox_event", `ADD ${oneOfCheck("outbox_event", "aggregate_kind", ...OUTBOX_AGGREGATES)}`),
    alter("billable_event", `ADD CONSTRAINT "billable_event_visit_shape" CHECK (${events.get("billable_event_visit_shape")})`),
    alter("billable_event", `ADD ${oneOfCheck("billable_event", "kind", ...BILLABLE_EVENT_KINDS)}`),
    alter("billable_event", `ADD ${oneOfCheck("billable_event", "cancel_reason", ...CANCEL_REASONS)}`),
    alter("billable_event", `ADD CONSTRAINT "billable_event_kind_shape" CHECK (${events.get("billable_event_kind_shape")})`),
  ]
}

/** What the file owes below drizzle-kit's statements, in the order migrations/README.md lays out. */
const handWritten = (): string[] => [
  ...Object.values(NEW_TABLES).flatMap((table) => [...tenantFence(table), ...touchUpdatedAt(table)]),
  ...excludeOverlapping(accessCredential, [accessCredential.projectId, accessCredential.kind, accessCredential.value]),
  ...excludeOverlapping(visitRule, [visitRule.projectId]),
  ...SITE_VISITS_AUDITED.flatMap(auditTrail),
]

/** The migration, by its name: it takes its number at its turn. */
async function migration(): Promise<string[]> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_site_visits\.sql$/.test(name))
  assert.ok(file !== undefined, "the site visits' migration")
  return statementsOf(await readFile(join(MIGRATIONS_FOLDER, file), "utf8"))
}

describe("recycling-centre visits as drizzle-kit writes them", () => {
  test("the migration's head is exactly drizzle-kit's statements: the six tables with their keys and indexes, and the ALTERs into the contexts before them", async () => {
    const statements = await migration()
    const generated = [...(await statementsFor(NEW_TABLES)), ...ALTERED()].map(normalised)
    // The same statements, whatever order drizzle-kit's loader gave them.
    assert.deepEqual([...statements.slice(0, generated.length)].sort(), [...generated].sort())
  })

  test("and its tail is each new table's fence and trigger, the two no-overlaps and the audit triggers, in that order", async () => {
    const statements = await migration()
    const tail = handWritten().map(normalised)
    assert.deepEqual(statements.slice(statements.length - tail.length), tail)
    assert.equal(statements.length, (await statementsFor(NEW_TABLES)).length + ALTERED().length + tail.length, "nothing else in the file")
    assert.deepEqual(
      tail.filter((statement) => statement.includes("EXCLUDE USING gist")).map((statement) => /ADD CONSTRAINT "([a-z_]+)"/.exec(statement)?.[1]),
      ["access_credential_no_overlap", "visit_rule_no_overlap"],
    )
  })

  test("the vocabularies the checks spell grew by the visit, last of each", () => {
    assert.equal(UNITS_AS_OF_0054.at(-1), "visit")
    assert.deepEqual(OUTBOX_KINDS.slice(-2), ["site-visit-recorded", "site-visit-voided"])
    assert.equal(OUTBOX_AGGREGATES.at(-1), "site-visit")
    assert.equal(BILLABLE_EVENT_KINDS.at(-1), "visit")
    assert.deepEqual(CANCEL_REASONS.slice(0, 2), ["pickup-corrected", "visit-voided"], "the consumer's two reasons first")
    assert.ok(checksOf(billableEvent).get("billable_event_kind_shape")?.includes(VISIT_CLAUSE))
  })
})

describe("the checks of the visits", () => {
  const credential = (column: string) => ref("access_credential", column)
  const visit = (column: string) => ref("site_visit", column)

  test("a credential is held by a business's customer with its agreement or by a household's Property, its value normalised, blocked with a reason", () => {
    const checks = checksOf(accessCredential)
    assert.equal(checks.get("access_credential_holder_shape"), `case when ${credential("property_id")} is not null then ${credential("customer_id")} is null and ${credential("agreement_id")} is null else ${credential("customer_id")} is not null and ${credential("agreement_id")} is not null end`)
    assert.equal(checks.get("access_credential_value_shape"), `${credential("value")} ~ '^[A-Z0-9]+$'`)
    assert.equal(checks.get("access_credential_blocked_shape"), `(${credential("blocked_at")} is null) = (${credential("blocked_reason")} is null)`)
  })

  test("a visit refused carries its reason, a read value its value, the attendant's its person, an admitted one its agreement and what it was charged at, a void its reason", () => {
    const checks = checksOf(siteVisit)
    assert.equal(checks.get("site_visit_outcome_shape"), `(${visit("outcome")} = 'refused') = (${visit("refusal_reason")} is not null)`)
    assert.equal(checks.get("site_visit_identifier_shape"), `(${visit("identification")} = 'property') = (${visit("identifier_value")} is null)`)
    assert.equal(checks.get("site_visit_source_shape"), `case ${visit("source")} when 'staff' then ${visit("recorded_by")} is not null and ${visit("external_id")} is null else ${visit("recorded_by")} is null end`)
    assert.equal(
      checks.get("site_visit_holder_shape"),
      `not (${visit("property_id")} is not null and ${visit("customer_id")} is not null) and (${visit("customer_id")} is null or ${visit("agreement_id")} is not null) and (${visit("outcome")} <> 'admitted' or ${visit("agreement_id")} is not null)`,
    )
    assert.equal(checks.get("site_visit_charge_shape"), `(${visit("outcome")} = 'admitted') = (${visit("charge_basis")} is not null) and (${visit("charge_product_id")} is null or ${visit("charge_basis")} in ('ladder', 'per-visit'))`)
    assert.equal(checks.get("site_visit_void_shape"), `(${visit("voided_at")} is null) = (${visit("void_reason")} is null) and (${visit("voided_by")} is null or ${visit("voided_at")} is not null)`)
  })
})
