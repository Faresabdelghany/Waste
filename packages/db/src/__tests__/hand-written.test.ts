// The five SQL helpers by their text, the derivation of what a table's
// migration file must carry, and the gate that holds every table of the
// schema to it (migrations/README.md). No database.
//
// The gate reads the folder, the files and the schema inside a test, never in
// a describe body: a throw there makes node's runner report no tests and exit
// 0, and a gate that cannot read what it checks has to fail, not vanish.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { is } from "drizzle-orm"
import { pgTable, PgTable, text, uuid } from "drizzle-orm/pg-core"

import { MIGRATIONS_FOLDER } from "../migrate"
import { id, orderedWindow, recorded, tenant, timestamps, validity, validPeriod, window } from "../schema/columns"
import { wms } from "../schema/wms"
import { appendOnly } from "../sql/append-only"
import { excludeOverlapping } from "../sql/exclude-overlapping"
import { excludeOverlappingWindow, WINDOW_RANGE } from "../sql/exclude-overlapping-window"
import {
  createsTable,
  createTableStatement,
  handWrittenStatements,
  isLedger,
  isReservation,
  missingHandWritten,
  overlapConstraintShape,
  statementsOf,
  windowConstraintShape,
} from "../sql/hand-written"
import { tenantFence } from "../sql/tenant-fence"
import { touchUpdatedAt } from "../sql/touch-updated-at"

const TABLE = '"wms"."specimen_hand_written"'
const RESERVATION = '"wms"."specimen_reservation"'

// An effective-dated record keyed by the container it concerns.
const specimen = wms.table(
  "specimen_hand_written",
  { ...id, ...tenant, ...timestamps, ...validity, containerId: uuid().notNull(), note: text() },
  (columns) => [validPeriod(columns)],
)
// A current-state row: tenant and timestamps, no validity.
const current = wms.table("specimen_current", { ...id, ...tenant, ...timestamps, note: text() })
// A ledger: appended, never updated — the one stamp, no updated_at.
const ledger = wms.table("specimen_ledger", { ...id, ...tenant, ...recorded, note: text() })
// Neither stamp: not a ledger and not a current row, which the gate has to refuse rather than guess about.
const unstamped = wms.table("specimen_unstamped", { ...id, ...tenant, note: text() })
// A reservation: a window on a clock with the ordered check, keyed by a vehicle and, where there is one, a driver.
const reservation = wms.table(
  "specimen_reservation",
  { ...id, ...tenant, ...timestamps, ...window, vehicleId: uuid().notNull(), driverId: uuid(), status: text().notNull() },
  (columns) => [orderedWindow(columns)],
)
// A snapshot of a reservation: the window columns copied into a ledger, no check, so not a reservation.
const snapshot = wms.table("specimen_snapshot", { ...id, ...tenant, ...recorded, ...window, vehicleId: uuid().notNull() })

const CONSTRAINT = `ALTER TABLE ${TABLE} ADD CONSTRAINT "specimen_hand_written_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "container_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);`
/** The range as the helper spells it, closing the gist list. */
const RANGE = `${WINDOW_RANGE})`
const VEHICLE_CONSTRAINT = `ALTER TABLE ${RESERVATION} ADD CONSTRAINT "specimen_reservation_vehicle_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "vehicle_id" WITH =, ${RANGE};`

describe("excludeOverlapping", () => {
  test("one gist exclusion over company_id, the key, and the half-open date range, named <table>_no_overlap", () => {
    assert.deepEqual(excludeOverlapping(specimen, [specimen.containerId]), [CONSTRAINT])
  })

  test("company_id leads whether or not the caller lists it, once", () => {
    assert.deepEqual(excludeOverlapping(specimen, [specimen.companyId, specimen.containerId]), [CONSTRAINT])
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

  test("refuses a column of another table, the period columns as key, and a nullable key column", () => {
    assert.throws(() => excludeOverlapping(specimen, [current.note]), /excludeOverlapping: column "note" is not a column of "wms"\."specimen_hand_written"/)
    assert.throws(() => excludeOverlapping(specimen, [specimen.validFrom]), /excludeOverlapping: "valid_from" is the period, not the key/)
    // A null never equals anything in an exclusion constraint: rows with a null key would overlap freely.
    assert.throws(
      () => excludeOverlapping(specimen, [specimen.note]),
      /excludeOverlapping: "note" is nullable; a null never equals anything in an exclusion constraint, so rows with a null there would overlap freely\. Make it NOT NULL or leave it out of the key\./,
    )
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

describe("appendOnly", () => {
  test("takes UPDATE and DELETE on the ledger back from the API role, and from nobody else", () => {
    assert.deepEqual(appendOnly(ledger), [`REVOKE UPDATE, DELETE ON "wms"."specimen_ledger" FROM wms_api;`])
  })

  test("refuses a table with updated_at, whose rows change, and one without recorded_at, which is not a ledger", () => {
    assert.throws(() => appendOnly(specimen), /appendOnly: "wms"\."specimen_hand_written" has updated_at; a ledger spreads recorded, not timestamps, since its rows are never updated/)
    assert.throws(() => appendOnly(current), /appendOnly: "wms"\."specimen_current" has updated_at/)
    assert.throws(() => appendOnly(unstamped), /appendOnly: "wms"\."specimen_unstamped" has no recorded_at; a ledger spreads the recorded column set/)
  })
})

describe("excludeOverlappingWindow", () => {
  test("one gist exclusion over company_id, the key and the half-open tstzrange, named by its key with a trailing _id dropped", () => {
    assert.deepEqual(excludeOverlappingWindow(reservation, [reservation.vehicleId]), [VEHICLE_CONSTRAINT])
  })

  test("takes which rows are live as a structured predicate, so a released reservation frees its window, and spells the null-exclusion of a nullable key itself", () => {
    const live = { live: { column: reservation.status, not: "released" } }
    assert.deepEqual(excludeOverlappingWindow(reservation, [reservation.vehicleId], live), [`${VEHICLE_CONSTRAINT.slice(0, -1)} WHERE ("status" <> 'released');`])
    // A null never equals anything in an exclusion constraint, so a nullable key column's nulls are kept out of the index by the helper, not by the caller's text.
    assert.deepEqual(excludeOverlappingWindow(reservation, [reservation.driverId]), [
      `ALTER TABLE ${RESERVATION} ADD CONSTRAINT "specimen_reservation_driver_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "driver_id" WITH =, ${RANGE} WHERE ("driver_id" is not null);`,
    ])
    assert.deepEqual(excludeOverlappingWindow(reservation, [reservation.driverId], live), [
      `ALTER TABLE ${RESERVATION} ADD CONSTRAINT "specimen_reservation_driver_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "driver_id" WITH =, ${RANGE} WHERE ("driver_id" is not null and "status" <> 'released');`,
    ])
    // The value is a literal with its quotes doubled, like a check's.
    assert.match(excludeOverlappingWindow(reservation, [reservation.vehicleId], { live: { column: reservation.status, not: "it's over" } })[0], /WHERE \("status" <> 'it''s over'\);$/)
    // A key of two columns is named by both.
    assert.match(excludeOverlappingWindow(reservation, [reservation.vehicleId, reservation.status])[0], /"specimen_reservation_vehicle_status_no_overlap" EXCLUDE USING gist \("company_id" WITH =, "vehicle_id" WITH =, "status" WITH =, tstzrange/)
  })

  test("company_id leads whether or not the caller lists it, once, and a column listed twice is once — the same key resolution as the validity sibling", () => {
    assert.deepEqual(excludeOverlappingWindow(reservation, [reservation.companyId, reservation.vehicleId]), [VEHICLE_CONSTRAINT])
    assert.deepEqual(excludeOverlappingWindow(reservation, [reservation.vehicleId, reservation.vehicleId]), [VEHICLE_CONSTRAINT])
    assert.deepEqual(excludeOverlapping(specimen, [specimen.containerId, specimen.containerId]), [CONSTRAINT])
    assert.throws(() => excludeOverlappingWindow(reservation, [reservation.companyId]), /excludeOverlappingWindow: "wms"\."specimen_reservation" names no key beside company_id; a reservation is of something/)
    assert.throws(() => excludeOverlappingWindow(reservation, [reservation.vehicleId], { live: { column: current.note, not: "x" } }), /excludeOverlappingWindow: live column "note" is not a column of "wms"\."specimen_reservation"/)
  })

  test("refuses a table without the window, without the orderedWindow check, or without company_id", () => {
    assert.throws(() => excludeOverlappingWindow(current, [current.note]), /excludeOverlappingWindow: "wms"\."specimen_current" has no planned_from and planned_to; spread the window column set/)
    assert.throws(
      () => excludeOverlappingWindow(snapshot, [snapshot.vehicleId]),
      /excludeOverlappingWindow: "wms"\."specimen_snapshot" has no "specimen_snapshot_window" check; add orderedWindow\(columns\) beside its columns, or an empty window would pass the constraint/,
    )
    const untenanted = wms.table("specimen_window_untenanted", { ...id, ...window, vehicleId: uuid().notNull() }, (columns) => [orderedWindow(columns)])
    assert.throws(() => excludeOverlappingWindow(untenanted, [untenanted.vehicleId]), /excludeOverlappingWindow: "wms"\."specimen_window_untenanted" has no company_id; spread the tenant column set/)
  })

  test("refuses a column of another table and the window columns as key", () => {
    assert.throws(() => excludeOverlappingWindow(reservation, [current.note]), /excludeOverlappingWindow: column "note" is not a column of "wms"\."specimen_reservation"/)
    assert.throws(() => excludeOverlappingWindow(reservation, [reservation.plannedTo]), /excludeOverlappingWindow: "planned_to" is the window, not the key/)
  })

  test("refuses a constraint name Postgres would truncate", () => {
    // 43 bytes: room for `_window` (50) and none for `_vehicle_no_overlap` (62)? 43 + 19 = 62 fits; 45 does not.
    const name = `specimen_${"o".repeat(36)}`
    const long = wms.table(name, { ...id, ...tenant, ...window, vehicleId: uuid().notNull() }, (columns) => [orderedWindow(columns)])
    assert.throws(() => excludeOverlappingWindow(long, [long.vehicleId]), new RegExp(`excludeOverlappingWindow: "${name}_vehicle_no_overlap" is 64 bytes; Postgres would truncate it to 63 silently`))
  })
})

describe("what a table's migration file must carry", () => {
  test("the fence for every table, the trigger for a table with updated_at, the revoke for a ledger, the constraint's shape for an effective-dated one", () => {
    assert.deepEqual(handWrittenStatements(specimen), [...tenantFence(specimen), ...touchUpdatedAt(specimen)])
    assert.deepEqual(handWrittenStatements(current), [...tenantFence(current), ...touchUpdatedAt(current)])
    assert.deepEqual(handWrittenStatements(ledger), [...tenantFence(ledger), ...appendOnly(ledger)])
    assert.deepEqual([isLedger(specimen), isLedger(current), isLedger(ledger), isLedger(snapshot), isLedger(unstamped)], [false, false, true, true, false], "a ledger is a table with recorded_at")
    assert.throws(() => handWrittenStatements(unstamped), /touchUpdatedAt: "wms"\."specimen_unstamped" has no updated_at/, "neither stamp is neither kind of table, and the gate says so rather than guessing")
    assert.deepEqual(overlapConstraintShape(specimen), {
      prefix: `ALTER TABLE ${TABLE} ADD CONSTRAINT "specimen_hand_written_no_overlap" EXCLUDE USING gist ("company_id" WITH =`,
      suffix: `daterange("valid_from", "valid_to", '[)') WITH &&);`,
    })
    assert.equal(overlapConstraintShape(current), undefined)
    assert.equal(createTableStatement(specimen), `CREATE TABLE ${TABLE} (`)
  })

  test("a reservation is a table with the window check; a snapshot of one is not, and neither is anything else", () => {
    assert.deepEqual([isReservation(reservation), isReservation(snapshot), isReservation(specimen), isReservation(ledger)], [true, false, false, false])
    assert.deepEqual(windowConstraintShape(reservation), { prefix: `ALTER TABLE ${RESERVATION} ADD CONSTRAINT "specimen_reservation_`, infix: RANGE }, "the range is the helper's own, read from it")
    assert.equal(windowConstraintShape(snapshot), undefined)
    // Every constraint the window helper writes begins with the prefix and carries the range, whatever its key and predicate.
    const { prefix, infix } = windowConstraintShape(reservation)!
    for (const [statement] of [
      excludeOverlappingWindow(reservation, [reservation.vehicleId]),
      excludeOverlappingWindow(reservation, [reservation.driverId]),
      excludeOverlappingWindow(reservation, [reservation.vehicleId, reservation.status], { live: { column: reservation.status, not: "released" } }),
    ]) {
      assert.ok(statement.startsWith(prefix), statement)
      assert.ok(statement.includes(infix), statement)
    }
  })

  test("a reservation's file lacks the window constraint until one of the helper's shape is there, with any key and predicate", () => {
    const [enable, policy] = tenantFence(reservation)
    const [trigger] = touchUpdatedAt(reservation)
    const withoutConstraint = [`CREATE TABLE ${RESERVATION} ();`, enable, policy, trigger].join("\n--> statement-breakpoint\n")
    assert.deepEqual(missingHandWritten(reservation, withoutConstraint), [
      `-- excludeOverlappingWindow(specimen_reservation, [...its key], { live? }) writes the exclusion constraint: ALTER TABLE ${RESERVATION} ADD CONSTRAINT "specimen_reservation_..._no_overlap" EXCLUDE USING gist ("company_id" WITH =, ..., ${RANGE}`,
    ])
    const [driverConstraint] = excludeOverlappingWindow(reservation, [reservation.driverId], { live: { column: reservation.status, not: "released" } })
    assert.deepEqual(missingHandWritten(reservation, `${withoutConstraint}\n--> statement-breakpoint\n${driverConstraint}`), [])
    // A constraint of another table or over another range does not count.
    const other = `ALTER TABLE "wms"."other" ADD CONSTRAINT "other_vehicle_no_overlap" EXCLUDE USING gist ("company_id" WITH =, "vehicle_id" WITH =, ${RANGE};`
    assert.equal(missingHandWritten(reservation, `${withoutConstraint}\n--> statement-breakpoint\n${other}`).length, 1)
    // A ledger's file is complete with its fence and its revoke, and a snapshot's window asks for nothing.
    const [ledgerEnable, ledgerPolicy] = tenantFence(snapshot)
    const [revoke] = appendOnly(snapshot)
    assert.deepEqual(missingHandWritten(snapshot, [`CREATE TABLE "wms"."specimen_snapshot" ();`, ledgerEnable, ledgerPolicy, revoke].join("\n--> statement-breakpoint\n")), [])
    assert.deepEqual(missingHandWritten(snapshot, [`CREATE TABLE "wms"."specimen_snapshot" ();`, ledgerEnable, ledgerPolicy].join("\n--> statement-breakpoint\n")), [revoke])
  })

  test("the shape is the helper's own spelling: every key the helper writes begins and ends with it", () => {
    const { prefix, suffix } = overlapConstraintShape(specimen)!
    for (const [statement] of [excludeOverlapping(specimen, []), excludeOverlapping(specimen, [specimen.containerId])]) {
      assert.ok(statement.startsWith(prefix), statement)
      assert.ok(statement.endsWith(suffix), statement)
    }
  })

  test("statementsOf reads a file as the migrator runs it: split at breakpoints, on their own line or at the end of a statement's, comments dropped, whitespace collapsed", () => {
    const [enable, policy] = tenantFence(specimen)
    const file = [
      "-- The table.",
      `CREATE TABLE ${TABLE} (`,
      '\t"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL -- minted',
      ");",
      "--> statement-breakpoint",
      `ALTER TABLE ${TABLE} ADD CONSTRAINT "specimen_hand_written_no_overlap"`,
      '  EXCLUDE USING gist ("company_id" WITH =, "container_id" WITH =,',
      `                      daterange("valid_from", "valid_to", '[)') WITH &&);`,
      "--> statement-breakpoint",
      // drizzle-kit writes the marker at the end of an ALTER TABLE or CREATE INDEX line.
      `${enable}--> statement-breakpoint`,
      `${policy}--> statement-breakpoint`,
      "",
      "--> statement-breakpoint   ",
      "-- ALTER TABLE disabled while debugging;",
    ].join("\n")
    assert.deepEqual(statementsOf(file), [
      `CREATE TABLE ${TABLE} ( "id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL );`,
      CONSTRAINT,
      enable,
      policy,
    ])
  })

  test("missingHandWritten: a complete file lacks nothing, whatever key the constraint uses and however its lines are wrapped", () => {
    const [enable, policy] = tenantFence(specimen)
    const file = [
      `CREATE TABLE ${TABLE} (\n\t"id" uuid PRIMARY KEY DEFAULT wms.uuidv7() NOT NULL\n);`,
      "--> statement-breakpoint",
      CONSTRAINT.replace(" EXCLUDE USING gist (", "\n  EXCLUDE USING gist (").replace(", daterange(", ",\n    daterange("),
      "--> statement-breakpoint",
      enable,
      "--> statement-breakpoint",
      policy.replace(" USING (", "\n  USING (").replace(" WITH CHECK (", "\n  WITH CHECK ("),
      "--> statement-breakpoint",
      ...touchUpdatedAt(specimen),
    ].join("\n")
    assert.deepEqual(missingHandWritten(specimen, file), [])
    assert.equal(createsTable(specimen, file), true)
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
    const wrongShape = `${partial}--> statement-breakpoint\n${policy}\n--> statement-breakpoint\n${trigger}\n--> statement-breakpoint\nALTER TABLE ${TABLE} ADD CONSTRAINT "other" EXCLUDE USING gist ("company_id" WITH =, daterange("valid_from", "valid_to", '[)') WITH &&);`
    assert.equal(missingHandWritten(specimen, wrongShape).length, 1)
  })

  test("a statement commented out is not there, a commented-out CREATE TABLE does not create, two statements in one piece are neither", () => {
    const [enable, policy] = tenantFence(specimen)
    const [trigger] = touchUpdatedAt(specimen)
    const disabled = [
      `CREATE TABLE ${TABLE} ();`,
      "--> statement-breakpoint",
      CONSTRAINT,
      "--> statement-breakpoint",
      `-- ${enable}`,
      "--> statement-breakpoint",
      policy,
      "--> statement-breakpoint",
      trigger,
    ].join("\n")
    assert.deepEqual(missingHandWritten(specimen, disabled), [enable])
    assert.equal(createsTable(specimen, `-- ${createTableStatement(specimen)}\n--   "id" uuid\n-- );`), false)
    // Without a breakpoint between them the migrator would run them as one statement, which is neither.
    assert.deepEqual(missingHandWritten(specimen, disabled.replace(`-- ${enable}`, `${enable}\n${trigger}`)), [enable])
  })
})

describe("the migrations carry every table's hand-written statements", () => {
  const migrations = async (): Promise<{ name: string; text: string }[]> => {
    const names = (await readdir(MIGRATIONS_FOLDER)).filter((name) => name.endsWith(".sql")).sort()
    return Promise.all(names.map(async (name) => ({ name, text: await readFile(join(MIGRATIONS_FOLDER, name), "utf8") })))
  }
  const tables = async (): Promise<PgTable[]> => {
    const schema: Record<string, unknown> = await import("../schema")
    return Object.values(schema).filter((value): value is PgTable => is(value, PgTable))
  }

  test("the migrations folder and the schema are read", async () => {
    const files = await migrations()
    assert.ok(files.length >= 2, `${files.length} files`)
    assert.match(files[0].name, /^0000_/)
    assert.ok(Array.isArray(await tables()))
  })

  test("each table of the schema is created by exactly one migration, and that file carries its statements", async () => {
    const files = await migrations()
    for (const table of await tables()) {
      const creating = files.filter((file) => createsTable(table, file.text))
      assert.equal(creating.length, 1, `${createTableStatement(table)} appears in ${creating.map((file) => file.name).join(", ") || "no migration"}`)
      const missing = missingHandWritten(table, creating[0].text)
      assert.deepEqual(missing, [], `${creating[0].name} lacks, below drizzle-kit's statements and each after a --> statement-breakpoint line:\n${missing.join("\n")}`)
    }
  })

  test("the schema has exactly eleven ledgers and one reservation, and no ledger carries a trigger anywhere", async () => {
    const all = await tables()
    const ledgers = all.filter(isLedger).map((table) => createTableStatement(table))
    // Resources' two, Execution's three, Resolution's one and Finance's five (Issue #112): the run's exclusions, the invoice and its lines, the settlement's history, the weight review.
    const LEDGERS = ["billing_run_exclusion", "driver_command", "invoice", "invoice_line", "proof_of_service", "settlement_event", "stock_movement", "ticket_event", "unload", "vehicle_allocation_event", "weight_review"]
    assert.deepEqual(
      ledgers.sort(),
      LEDGERS.map((name) => `CREATE TABLE "wms"."${name}" (`),
    )
    assert.deepEqual(
      all.filter(isReservation).map((table) => createTableStatement(table)),
      ['CREATE TABLE "wms"."vehicle_allocation" ('],
    )
    const text = (await migrations()).map((file) => file.text).join("\n")
    for (const name of LEDGERS) {
      assert.equal(text.includes(`"${name}_touch_updated_at"`), false, `${name} has no updated_at to touch`)
    }
  })
})
