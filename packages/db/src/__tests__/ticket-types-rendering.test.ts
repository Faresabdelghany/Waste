// Ticket Types (#545 of #544) as the migration writes them: the company's
// types, each name once, each of one kind, one default per kind and the
// default offered; a type's fields, each key and each place once, choices on
// a choice field alone; who may give each command, one row per role; and the
// ticket's type, held to its kind by a key over both, and its fields' values,
// an object. Then the file: drizzle-kit's statements, but for the ticket's
// type added nullable; the seed, the backfill and the NOT NULL
// (src/sql/ticket-types.ts); then the three tables' fences, triggers and
// audit trails. The pre-trip inspection's removal took the `vehicle-defect`
// kind since, so the file's seed is today's with that kind's default
// (`seedAsOfThisFile`). The file is found by its name, not its number. No
// database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { DEFAULT_TICKET_TYPE_NAMES } from "@waste/domain/resolution/ticket-types"
import { TICKET_COMMANDS } from "@waste/domain/resolution/transitions"
import { TICKET_FIELD_INPUTS, TICKET_FIELD_REQUIREMENTS, TICKET_KINDS, TICKET_TYPE_STATUSES } from "@waste/domain/resolution/vocabulary"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { ticket, ticketType, ticketTypeField, ticketTypePermission } from "../schema/resolution"
import { auditTrail, TICKET_TYPES_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { ticketTypesBackfill, ticketTypesRequired, ticketTypesSeed } from "../sql/ticket-types"
import { checksOf, list, ref } from "./rendering"

/** The seed as this file spells it: today's, with the `vehicle-defect` default before `other`, which the pre-trip inspection's removal took since. */
function seedAsOfThisFile(): string {
  const other = "('other', 'Other')"
  const today = ticketTypesSeed()
  assert.ok(today.includes(other), "other is the kind vehicle-defect preceded")
  return today.replace(other, `('vehicle-defect', 'Vehicle defect'), ${other}`)
}

/** drizzle-kit's spelling of the ticket's type, which a database holding tickets refuses, and the file's. */
const REQUIRED_TYPE = 'ALTER TABLE "wms"."ticket" ADD COLUMN "ticket_type_id" uuid NOT NULL;'
const NULLABLE_TYPE = 'ALTER TABLE "wms"."ticket" ADD COLUMN "ticket_type_id" uuid;'

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_ticket_types\.sql$/.test(name))
  assert.ok(file !== undefined, "the ticket types' migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

/** What drizzle-kit writes for the migration, diffing the snapshot before against its own. */
async function generated(): Promise<string[]> {
  const own = (await migrationName()).slice(0, 4)
  return (await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own))).map(normalised)
}

describe("the ticket types as drizzle-kit writes them", () => {
  test("a type is the company's, named once, of one kind, active or retired, one default per kind and that one offered", async () => {
    const statements = await generated()
    const created = statements.find((statement) => statement.startsWith('CREATE TABLE "wms"."ticket_type" ('))
    assert.match(created ?? "", /CONSTRAINT "ticket_type_name_key" UNIQUE\("company_id","name"\)/)
    assert.match(created ?? "", /CONSTRAINT "ticket_type_kind_key" UNIQUE\("company_id","id","kind"\)/)
    assert.ok(statements.includes(normalised('CREATE UNIQUE INDEX "ticket_type_default_kind_key" ON "wms"."ticket_type" USING btree ("company_id","kind") WHERE "wms"."ticket_type"."is_default";')))
    const checks = checksOf(ticketType)
    assert.equal(checks.get("ticket_type_kind_one_of"), `${ref("ticket_type", "kind")} in (${list(...TICKET_KINDS)})`)
    assert.equal(checks.get("ticket_type_status_one_of"), `${ref("ticket_type", "status")} in (${list(...TICKET_TYPE_STATUSES)})`)
    assert.equal(checks.get("ticket_type_default_shape"), `not ${ref("ticket_type", "is_default")} or ${ref("ticket_type", "status")} = 'active'`)
  })

  test("a field is its type's, by a lowercase key and a place each once, of one input and one requirement, offering choices exactly when it is a choice", async () => {
    const created = (await generated()).find((statement) => statement.startsWith('CREATE TABLE "wms"."ticket_type_field"'))
    assert.match(created ?? "", /CONSTRAINT "ticket_type_field_ticket_type_id_key_key" UNIQUE\("company_id","ticket_type_id","key"\)/)
    assert.match(created ?? "", /CONSTRAINT "ticket_type_field_ticket_type_id_position_key" UNIQUE\("company_id","ticket_type_id","position"\)/)
    const checks = checksOf(ticketTypeField)
    assert.equal(checks.get("ticket_type_field_input_one_of"), `${ref("ticket_type_field", "input")} in (${list(...TICKET_FIELD_INPUTS)})`)
    assert.equal(checks.get("ticket_type_field_requirement_one_of"), `${ref("ticket_type_field", "requirement")} in (${list(...TICKET_FIELD_REQUIREMENTS)})`)
    assert.equal(checks.get("ticket_type_field_choices_shape"), `(${ref("ticket_type_field", "input")} = 'choice') = (cardinality(${ref("ticket_type_field", "choices")}) > 0)`)
  })

  test("a permission names a role of the company for one of the six commands, once", async () => {
    const statements = await generated()
    assert.match(statements.find((statement) => statement.startsWith('CREATE TABLE "wms"."ticket_type_permission"')) ?? "", /CONSTRAINT "ticket_type_permission_grant_key" UNIQUE\("company_id","ticket_type_id","command","role_id"\)/)
    assert.ok(statements.includes(normalised('ALTER TABLE "wms"."ticket_type_permission" ADD CONSTRAINT "ticket_type_permission_role_id_fk" FOREIGN KEY ("company_id","role_id") REFERENCES "wms"."role"("company_id","id") ON DELETE no action ON UPDATE no action;')))
    assert.equal(checksOf(ticketTypePermission).get("ticket_type_permission_command_one_of"), `${ref("ticket_type_permission", "command")} in (${list(...TICKET_COMMANDS)})`)
  })

  test("a ticket's type is one of its kind, through a key carrying the kind on both sides, and its values an object", async () => {
    const statements = await generated()
    assert.ok(statements.includes(normalised(REQUIRED_TYPE)))
    assert.ok(statements.includes(normalised('ALTER TABLE "wms"."ticket" ADD COLUMN "field_values" jsonb DEFAULT \'{}\'::jsonb NOT NULL;')))
    assert.ok(statements.includes(normalised('ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_ticket_type_id_kind_fk" FOREIGN KEY ("company_id","ticket_type_id","kind") REFERENCES "wms"."ticket_type"("company_id","id","kind") ON DELETE no action ON UPDATE no action;')))
    assert.equal(checksOf(ticket).get("ticket_field_values_shape"), `jsonb_typeof(${ref("ticket", "field_values")}) = 'object'`)
  })
})

describe("the ticket types' migration", () => {
  test("is drizzle-kit's statements with the type added nullable; then the seed, the backfill and the NOT NULL; then the fences, the triggers and the audit trails", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    const statements = statementsOf(text)
    const head = (await generated()).map((statement) => (statement === normalised(REQUIRED_TYPE) ? normalised(NULLABLE_TYPE) : statement))
    assert.deepEqual([...statements.slice(0, head.length)].sort(), [...head].sort())
    assert.deepEqual(
      statements.slice(head.length),
      [seedAsOfThisFile(), ticketTypesBackfill(), ticketTypesRequired(), ...[ticketType, ticketTypeField, ticketTypePermission].flatMap(handWrittenStatements), ...TICKET_TYPES_AUDITED.flatMap(auditTrail)].map(normalised),
    )
    assert.match(text, /^-- Ticket Types \(#545 of #544\)/)
  })

  test("the seed gives every company a default type per kind under the domain's names; the backfill gives a ticket without a type its kind's default", () => {
    const seed = ticketTypesSeed()
    for (const kind of TICKET_KINDS) assert.ok(seed.includes(`('${kind}', '${DEFAULT_TICKET_TYPE_NAMES[kind]}')`), kind)
    assert.match(seed, /SELECT c\."id", v\."kind", v\."name", true FROM "wms"\."company" AS c CROSS JOIN/)
    assert.match(ticketTypesBackfill(), /y\."kind" = t\."kind" AND y\."is_default" AND t\."ticket_type_id" IS NULL;$/)
  })

  test("the three are audited under the templates' grant, the fields and the permissions sets of their type", () => {
    assert.deepEqual(
      TICKET_TYPES_AUDITED.map((entry) => [entry.table, entry.module, entry.parent]),
      [
        [ticketType, "configure.templates", undefined],
        [ticketTypeField, "configure.templates", { table: ticketType, column: ticketTypeField.ticketTypeId }],
        [ticketTypePermission, "configure.templates", { table: ticketType, column: ticketTypePermission.ticketTypeId }],
      ],
    )
  })
})
