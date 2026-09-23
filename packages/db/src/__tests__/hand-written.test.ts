// The three SQL helpers by their text, the derivation of what a table's
// migration file must carry, and the gate that holds every table of the
// schema to it (migrations/README.md). No database.
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, test } from "node:test"

import { is } from "drizzle-orm"
import { pgTable, PgTable, text, uuid } from "drizzle-orm/pg-core"

import { MIGRATIONS_FOLDER } from "../migrate"
import * as schema from "../schema"
import { id, tenant, timestamps, validity, validPeriod } from "../schema/columns"
import { wms } from "../schema/wms"
import { excludeOverlapping } from "../sql/exclude-overlapping"
import { createTableStatement, handWrittenStatements, missingHandWritten, overlapConstraintShape } from "../sql/hand-written"
import { tenantFence } from "../sql/tenant-fence"
import { touchUpdatedAt } from "../sql/touch-updated-at"

const TABLE = '"wms"."specimen_hand_written"'

// An effective-dated record keyed by the container it concerns.
const specimen = wms.table(
  "specimen_hand_written",
  { ...id, ...tenant, ...timestamps, ...validity, containerId: uuid().notNull(), note: text() },
  (columns) => [validPeriod(columns)],
)
// A current-state row: tenant and timestamps, no validity.
const current = wms.table("specimen_current", { ...id, ...tenant, ...timestamps, note: text() })
// A ledger: appended, never updated.
const ledger = wms.table("specimen_ledger", { ...id, ...tenant, createdAt: timestamps.createdAt, note: text() })

describe("excludeOverlapping", () => {
  test("one gist exclusion over company_id, the key, and the half-open date range, named <table>_no_overlap", () => {
    assert.deepEqual(excludeOverlapping(specimen, [specimen.containerId]), [
      `ALTER TABLE ${TABLE} ADD CONSTRAINT "specimen_hand_written_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "container_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);`,
    ])
  })

  test("company_id leads whether or not the caller lists it, once", () => {
    assert.deepEqual(excludeOverlapping(specimen, [specimen.companyId, specimen.containerId]), excludeOverlapping(specimen, [specimen.containerId]))
    assert.deepEqual(excludeOverlapping(specimen, []), [
      `ALTER TABLE ${TABLE} ADD CONSTRAINT "specimen_hand_written_no_overlap" EXCLUDE USING gist ("company_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);`,
    ])
  })

  test("refuses a table without validity, without the validPeriod check, or without company_id", () => {
    assert.throws(() => excludeOverlapping(current, []), /excludeOverlapping: "wms"\."specimen_current" has no valid_from and valid_to; spread the validity column set/)
    const unchecked = wms.table("specimen_unchecked", { ...id, ...tenant, ...validity })
    assert.throws(
      () => excludeOverlapping(unchecked, []),
      /excludeOverlapping: "wms"\."specimen_unchecked" has no "specimen_unchecked_validity" check; add validPeriod\(columns\) beside its columns, or an empty period would pass the constraint/,
    )
    const untenanted = wms.table("specimen_untenanted", { ...id, ...validity }, (columns) => [validPeriod(columns)])
    assert.throws(() => excludeOverlapping(untenanted, []), /excludeOverlapping: "wms"\."specimen_untenanted" has no company_id; spread the tenant column set/)
  })

  test("refuses a column of another table, and the period columns as key", () => {
    assert.throws(() => excludeOverlapping(specimen, [current.note]), /excludeOverlapping: column "note" is not a column of "wms"\."specimen_hand_written"/)
    assert.throws(() => excludeOverlapping(specimen, [specimen.validFrom]), /excludeOverlapping: "valid_from" is the period, not the key/)
  })

  test("refuses a table outside wms, and a constraint name Postgres would truncate", () => {
    const elsewhere = pgTable("specimen_public", { ...id, ...tenant, ...validity }, (columns) => [validPeriod(columns)])
    assert.throws(() => excludeOverlapping(elsewhere, []), /excludeOverlapping: "specimen_public" is in schema public; domain tables live in wms/)
    // 54 bytes: room for `_validity` (63), none for `_no_overlap` (65).
    const name = `specimen_${"o".repeat(45)}`
    const long = wms.table(name, { ...id, ...tenant, ...validity }, (columns) => [validPeriod(columns)])
    assert.throws(() => excludeOverlapping(long, []), new RegExp(`excludeOverlapping: "${name}_no_overlap" is 65 bytes; Postgres would truncate it to 63 silently`))
  })
})

describe("tenantFence", () => {
  test("enables and forces row-level security, and one permissive policy for the API role over company_id", () => {
    assert.deepEqual(tenantFence(specimen), [
      `ALTER TABLE ${TABLE} ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY;`,
      `CREATE POLICY "specimen_hand_written_tenant_fence" ON ${TABLE} AS PERMISSIVE FOR ALL TO wms_api USING ("company_id" = (select wms.current_company_id())) WITH CHECK ("company_id" = (select wms.current_company_id()));`,
    ])
  })

  test("refuses a table without company_id: every domain table carries one", () => {
    const untenanted = wms.table("specimen_no_tenant", { ...id, note: text() })
    assert.throws(() => tenantFence(untenanted), /tenantFence: "wms"\."specimen_no_tenant" has no company_id; every domain table carries one/)
  })
})

describe("touchUpdatedAt", () => {
  test("one BEFORE UPDATE trigger calling the foundation's function", () => {
    assert.deepEqual(touchUpdatedAt(specimen), [
      `CREATE TRIGGER "specimen_hand_written_touch_updated_at" BEFORE UPDATE ON ${TABLE} FOR EACH ROW EXECUTE FUNCTION wms.touch_updated_at();`,
    ])
  })

  test("refuses a table without updated_at", () => {
    assert.throws(() => touchUpdatedAt(ledger), /touchUpdatedAt: "wms"\."specimen_ledger" has no updated_at; spread the timestamps column set/)
  })
})

describe("what a table's migration file must carry", () => {
  test("the fence for every table, the trigger for a table with updated_at, the constraint's shape for an effective-dated one", () => {
    assert.deepEqual(handWrittenStatements(specimen), [...tenantFence(specimen), ...touchUpdatedAt(specimen)])
    assert.deepEqual(handWrittenStatements(current), [...tenantFence(current), ...touchUpdatedAt(current)])
    assert.deepEqual(handWrittenStatements(ledger), tenantFence(ledger))
    assert.deepEqual(overlapConstraintShape(specimen), {
      prefix: `ALTER TABLE ${TABLE} ADD CONSTRAINT "specimen_hand_written_no_overlap" EXCLUDE USING gist ("company_id" WITH =`,
      suffix: `daterange("valid_from", "valid_to", '[)') WITH &&);`,
    })
    assert.equal(overlapConstraintShape(current), undefined)
    assert.equal(createTableStatement(specimen), `CREATE TABLE ${TABLE} (`)
  })

  test("missingHandWritten: a complete file lacks nothing, whatever key the constraint uses", () => {
    const file = [
      `CREATE TABLE ${TABLE} (\n\t"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL\n);`,
      "--> statement-breakpoint",
      ...excludeOverlapping(specimen, [specimen.containerId]),
      "--> statement-breakpoint",
      ...tenantFence(specimen),
      "--> statement-breakpoint",
      ...touchUpdatedAt(specimen),
    ].join("\n")
    assert.deepEqual(missingHandWritten(specimen, file), [])
  })

  test("missingHandWritten names each absent statement verbatim, and the helper for a missing constraint", () => {
    const [enable, policy] = tenantFence(specimen)
    const [trigger] = touchUpdatedAt(specimen)
    const partial = `CREATE TABLE ${TABLE} ();\n--> statement-breakpoint\n${enable}\n`
    assert.deepEqual(missingHandWritten(specimen, partial), [
      policy,
      trigger,
      `-- excludeOverlapping(specimen_hand_written, [...its business key]) writes the exclusion constraint: ${overlapConstraintShape(specimen)!.prefix}, ... ${overlapConstraintShape(specimen)!.suffix}`,
    ])
    // A constraint of another shape (another name, a different range) does not count.
    const wrongShape = `${partial}${policy}\n${trigger}\nALTER TABLE ${TABLE} ADD CONSTRAINT "other" EXCLUDE USING gist ("company_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);`
    assert.equal(missingHandWritten(specimen, wrongShape).length, 1)
  })
})

describe("the migrations carry every table's hand-written statements", () => {
  const files = readdirSync(MIGRATIONS_FOLDER)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => ({ name, text: readFileSync(join(MIGRATIONS_FOLDER, name), "utf8") }))
  const tables = Object.values(schema as Record<string, unknown>).filter((value): value is PgTable => is(value, PgTable))

  test("the migrations folder is read", () => {
    assert.ok(files.length >= 2, `${files.length} files`)
  })

  test("each table of the schema is created by exactly one migration, and that file carries its statements", () => {
    for (const table of tables) {
      const creating = files.filter((file) => file.text.includes(createTableStatement(table)))
      assert.equal(creating.length, 1, `${createTableStatement(table)} appears in ${creating.map((file) => file.name).join(", ") || "no migration"}`)
      const missing = missingHandWritten(table, creating[0].text)
      assert.deepEqual(missing, [], `${creating[0].name} lacks, below drizzle-kit's statements and each after a --> statement-breakpoint line:\n${missing.join("\n")}`)
    }
  })
})
