// The quota table (#171, #132 §5) as drizzle-kit writes it: one row per
// company, provider and family — the provider's key is one account every
// company shares, so with the Pilot's one company it is one row per provider
// and family (ADR-0009) — holding what the provider last said and what the
// quota engine made of it. Then migration 0014, which has to begin with
// exactly those statements and to carry below them what the helpers write for
// a current-state table: the fence and the trigger. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { ROUTING_QUOTA_FAMILIES } from "@waste/domain/routing/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { routingQuota } from "../schema/routing"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, companyFk, createTable, oneOfCheck, ref, uniqueKey } from "./rendering"
import { statementsFor } from "./specimen"

const MIGRATION = "0014_routing_quota.sql"
const INSTANT = "timestamp with time zone"

const expected = [
  createTable("routing_quota", "tenant", [
    '"provider" text NOT NULL',
    '"family" text NOT NULL',
    '"remaining" integer',
    '"limit" integer',
    `"reset_at" ${INSTANT}`,
    `"exhausted_at" ${INSTANT}`,
    `"key_refused_at" ${INSTANT}`,
    uniqueKey("routing_quota_provider_family_key", "company_id", "provider", "family"),
    oneOfCheck("routing_quota", "family", ...ROUTING_QUOTA_FAMILIES),
    `CONSTRAINT "routing_quota_counts_shape" CHECK ((${ref("routing_quota", "remaining")} is null or ${ref("routing_quota", "remaining")} >= 0) and (${ref("routing_quota", "limit")} is null or ${ref("routing_quota", "limit")} >= 0))`,
  ]),
  companyFk("routing_quota"),
]

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

describe("the quota table as drizzle-kit writes it", () => {
  test("one table: the reading, the engine's two instants, one row per company, provider and family", async () => {
    assert.deepEqual(await statementsFor({ routingQuota }), expected)
  })

  test("migration 0014 is exactly that, then the fence and the trigger of a current-state table", async () => {
    const statements = await fileStatements()
    assert.deepEqual(statements, [...expected, ...handWrittenStatements(routingQuota)].map(normalised))
    assert.equal(statements.filter((statement) => statement.startsWith("CREATE POLICY")).length, 1)
    assert.equal(statements.filter((statement) => statement.startsWith("CREATE TRIGGER")).length, 1, "the row changes after every response: it has an updated_at to touch")
  })
})

describe("the checks of this table", () => {
  test("the family reads the routing vocabulary, and a count is never negative", () => {
    assert.deepEqual([...checksOf(routingQuota).keys()], ["routing_quota_family_one_of", "routing_quota_counts_shape"])
    for (const family of ROUTING_QUOTA_FAMILIES) assert.ok(checksOf(routingQuota).get("routing_quota_family_one_of")?.includes(`'${family}'`), family)
  })

  test("the instants are instants, the counts whole numbers, every reading nullable: the fake reports no limit", () => {
    for (const column of [routingQuota.resetAt, routingQuota.exhaustedAt, routingQuota.keyRefusedAt]) {
      assert.deepEqual({ dataType: column.dataType, sqlType: column.getSQLType(), notNull: column.notNull }, { dataType: "date", sqlType: INSTANT, notNull: false })
    }
    for (const column of [routingQuota.remaining, routingQuota.limit]) assert.deepEqual({ sqlType: column.getSQLType(), notNull: column.notNull }, { sqlType: "integer", notNull: false })
  })
})
