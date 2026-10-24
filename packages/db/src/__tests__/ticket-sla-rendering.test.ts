// A ticket's SLA (O4 of #290) as drizzle-kit writes it: one project-scoped
// table of targets, a kind (or every kind) and a priority named once per
// project with nulls as equal, the hours held to a year. Then migration 0026,
// which has to begin with exactly those statements and carry below them the
// table's fence and trigger and its audit trail (`TICKET_SLA_AUDITED`), since
// the office's edits of it are history. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { TICKET_SLA_HOURS_MAX } from "@waste/domain/resolution/sla"
import { TICKET_KINDS, TICKET_PRIORITIES } from "@waste/domain/resolution/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { project } from "../schema/organisation"
import { ticketSla } from "../schema/resolution"
import { TICKET_SLA_AUDITED, auditTrail } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, columns, companyFk, createTable, oneOfCheck, projectFk, ref } from "./rendering"
import { statementsFor } from "./specimen"

const MIGRATION = "0026_ticket_sla.sql"

const HOURS = `${ref("ticket_sla", "hours")} between 1 and ${TICKET_SLA_HOURS_MAX}`

const expected = [
  createTable("ticket_sla", "project", [
    '"kind" text',
    '"priority" text NOT NULL',
    '"hours" integer NOT NULL',
    `CONSTRAINT "ticket_sla_project_id_kind_priority_key" UNIQUE NULLS NOT DISTINCT(${columns("company_id", "project_id", "kind", "priority")})`,
    oneOfCheck("ticket_sla", "kind", ...TICKET_KINDS),
    oneOfCheck("ticket_sla", "priority", ...TICKET_PRIORITIES),
    `CONSTRAINT "ticket_sla_hours_range" CHECK (${HOURS})`,
  ]),
  companyFk("ticket_sla"),
  projectFk("ticket_sla"),
]

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

const [audited] = TICKET_SLA_AUDITED

describe("the SLA as drizzle-kit writes it", () => {
  test("one table of targets: a kind or every kind and a priority once per project, the hours a year at most", async () => {
    assert.deepEqual(await statementsFor({ ticketSla }), expected)
  })

  test("migration 0026 is exactly that, then the table's fence and trigger, then its audit trail", async () => {
    assert.deepEqual(await fileStatements(), [...expected, ...handWrittenStatements(ticketSla), ...TICKET_SLA_AUDITED.flatMap(auditTrail)].map(normalised))
  })
})

describe("the checks", () => {
  test("the kind and the priority read Resolution's vocabulary, and the hours run from one to a year", () => {
    assert.deepEqual([...checksOf(ticketSla).keys()], ["ticket_sla_kind_one_of", "ticket_sla_priority_one_of", "ticket_sla_hours_range"])
    assert.equal(checksOf(ticketSla).get("ticket_sla_hours_range"), HOURS)
  })

  test("0026 audits the one table, its history read under the templates' grant, where the office edits it, as a set of its project", () => {
    assert.deepEqual(TICKET_SLA_AUDITED.map((entry) => entry.table), [ticketSla])
    assert.equal(audited.module, "configure.templates")
    assert.deepEqual(audited.parent, { table: project, column: ticketSla.projectId })
  })
})
