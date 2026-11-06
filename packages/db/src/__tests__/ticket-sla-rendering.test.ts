// A ticket's SLA (O4 of #290) as drizzle-kit writes it: one project-scoped
// table of targets, a kind (or every kind) and a priority named once per
// project with nulls as equal, the hours held to a year. Then migration 0026,
// which has to begin with exactly those statements and carry below them the
// table's fence and trigger and its audit trail (`TICKET_SLA_AUDITED`), since
// the office's edits of it are history. Migration 0075 (O13 of #290) grew
// the kinds by `vehicle-defect` and the pre-trip inspection's removal took it
// again, so today's list is 0026's; pre-trip-rendering.test.ts and
// pre-trip-removal-rendering.test.ts pin the two replacements. A ticket
// type's own targets (#548 of #544) gave the table a type beside the kind, so
// the table is spelled here as 0026 wrote it (`ticketSlaAsOf0026`);
// ticket-type-settings-rendering.test.ts pins that migration. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { TICKET_SLA_HOURS_MAX } from "@waste/domain/resolution/sla"
import { TICKET_KINDS, TICKET_PRIORITIES } from "@waste/domain/resolution/vocabulary"
import { sql } from "drizzle-orm"
import { check, integer, text } from "drizzle-orm/pg-core"

import { MIGRATIONS_FOLDER } from "../migrate"
import { tableObjectName } from "../names"
import { oneOf } from "../schema/checks"
import { id, projectScoped, timestamps } from "../schema/columns"
import { company, project } from "../schema/organisation"
import { companyReference, tenantReference, tenantUnique } from "../schema/references"
import { ticketSla } from "../schema/resolution"
import { wms } from "../schema/wms"
import { TICKET_SLA_AUDITED, auditTrail } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, columns, companyFk, createTable, oneOfCheck, projectFk, ref } from "./rendering"
import { statementsFor } from "./specimen"

const MIGRATION = "0026_ticket_sla.sql"

const HOURS = `${ref("ticket_sla", "hours")} between 1 and ${TICKET_SLA_HOURS_MAX}`

/** The targets as 0026 wrote them: a kind or every kind, before a ticket type could have its own (#548 of #544). */
const ticketSlaAsOf0026 = wms.table("ticket_sla", { ...id, ...projectScoped, ...timestamps, kind: text(), priority: text().notNull(), hours: integer().notNull() }, (t) => [
  companyReference(t, company),
  tenantReference(t, [t.projectId], project),
  tenantUnique(t, t.projectId, t.kind, t.priority).nullsNotDistinct(),
  oneOf(t.kind, TICKET_KINDS),
  oneOf(t.priority, TICKET_PRIORITIES),
  check(tableObjectName(t.id.table, "hours_range", "ticketSla"), sql`${t.hours} between 1 and ${sql.raw(String(TICKET_SLA_HOURS_MAX))}`),
])

/** What drizzle-kit writes for the table, with its kind's check over the list given. */
const expectedWith = (kinds: readonly string[]) => [
  createTable("ticket_sla", "project", [
    '"kind" text',
    '"priority" text NOT NULL',
    '"hours" integer NOT NULL',
    `CONSTRAINT "ticket_sla_project_id_kind_priority_key" UNIQUE NULLS NOT DISTINCT(${columns("company_id", "project_id", "kind", "priority")})`,
    oneOfCheck("ticket_sla", "kind", ...kinds),
    oneOfCheck("ticket_sla", "priority", ...TICKET_PRIORITIES),
    `CONSTRAINT "ticket_sla_hours_range" CHECK (${HOURS})`,
  ]),
  companyFk("ticket_sla"),
  projectFk("ticket_sla"),
]

const expected = expectedWith(TICKET_KINDS)

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

const [audited] = TICKET_SLA_AUDITED

describe("the SLA as drizzle-kit writes it", () => {
  test("one table of targets: a kind or every kind and a priority once per project, the hours a year at most", async () => {
    assert.deepEqual(await statementsFor({ ticketSla: ticketSlaAsOf0026 }), expected)
  })

  test("migration 0026 is exactly that, then the table's fence and trigger, then its audit trail", async () => {
    assert.deepEqual(await fileStatements(), [...expected, ...handWrittenStatements(ticketSlaAsOf0026), ...TICKET_SLA_AUDITED.flatMap(auditTrail)].map(normalised))
  })
})

describe("the checks", () => {
  test("the kind and the priority read Resolution's vocabulary, a target names its kind or its type (#548 of #544), and the hours run from one to a year", () => {
    assert.deepEqual([...checksOf(ticketSla).keys()], ["ticket_sla_kind_one_of", "ticket_sla_priority_one_of", "ticket_sla_scope_shape", "ticket_sla_hours_range"])
    assert.equal(checksOf(ticketSla).get("ticket_sla_hours_range"), HOURS)
  })

  test("0026 audits the one table, its history read under the templates' grant, where the office edits it, as a set of its project", () => {
    assert.deepEqual(TICKET_SLA_AUDITED.map((entry) => entry.table), [ticketSla])
    assert.equal(audited.module, "configure.templates")
    assert.deepEqual(audited.parent, { table: project, column: ticketSla.projectId })
  })
})
