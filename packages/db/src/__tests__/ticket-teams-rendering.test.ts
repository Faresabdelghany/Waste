// Ticket teams (O30 of #290, row 7.20) as the migration writes them: the
// company's teams, each name once, active or retired; a team's members, one
// row per account; the ticket's team; and a project's default team per kind,
// one per kind. Then the file: drizzle-kit's statements, then the three
// tables' fences and triggers and their audit trails. The file is found by
// its name, not its number. No database.
import assert from "node:assert/strict"
import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { TEAM_STATUSES, TICKET_KINDS } from "@waste/domain/resolution/vocabulary"
import { generateMigration } from "drizzle-kit/api"

import { MIGRATIONS_FOLDER } from "../migrate"
import { project } from "../schema/organisation"
import { team, teamMember, ticketTeamDefault } from "../schema/resolution"
import { auditTrail, TEAMS_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, list, ref } from "./rendering"

async function migrationName(): Promise<string> {
  const file = (await readdir(MIGRATIONS_FOLDER)).find((name) => /^\d{4}_ticket_teams\.sql$/.test(name))
  assert.ok(file !== undefined, "the ticket teams' migration")
  return file
}

type Snapshot = Parameters<typeof generateMigration>[0]
const snapshot = async (n: string): Promise<Snapshot> => JSON.parse(await readFile(join(MIGRATIONS_FOLDER, "meta", `${n}_snapshot.json`), "utf8")) as Snapshot

/** What drizzle-kit writes for the migration, diffing the snapshot before against its own. */
async function generated(): Promise<string[]> {
  const own = (await migrationName()).slice(0, 4)
  return (await generateMigration(await snapshot(String(Number(own) - 1).padStart(4, "0")), await snapshot(own))).map(normalised)
}

describe("the ticket teams as drizzle-kit writes them", () => {
  test("a team is the company's, named once, active or retired; a member is one of its accounts once; a ticket names a team of its company; a project names one team per kind", async () => {
    const statements = await generated()
    for (const statement of [
      'ALTER TABLE "wms"."ticket" ADD COLUMN "team_id" uuid;',
      'ALTER TABLE "wms"."ticket" ADD CONSTRAINT "ticket_team_id_fk" FOREIGN KEY ("company_id","team_id") REFERENCES "wms"."team"("company_id","id") ON DELETE no action ON UPDATE no action;',
      'CREATE INDEX "ticket_team_id_status_idx" ON "wms"."ticket" USING btree ("company_id","team_id","status");',
      'ALTER TABLE "wms"."team_member" ADD CONSTRAINT "team_member_user_account_id_fk" FOREIGN KEY ("company_id","user_account_id") REFERENCES "wms"."user_account"("company_id","id") ON DELETE no action ON UPDATE no action;',
      'ALTER TABLE "wms"."ticket_team_default" ADD CONSTRAINT "ticket_team_default_team_id_fk" FOREIGN KEY ("company_id","team_id") REFERENCES "wms"."team"("company_id","id") ON DELETE no action ON UPDATE no action;',
    ]) {
      assert.ok(statements.includes(normalised(statement)), statement)
    }
    const created = statements.find((statement) => statement.startsWith('CREATE TABLE "wms"."ticket_team_default"'))
    assert.match(created ?? "", /CONSTRAINT "ticket_team_default_project_id_kind_key" UNIQUE\("company_id","project_id","kind"\)/)
    assert.match(statements.find((statement) => statement.startsWith('CREATE TABLE "wms"."team_member"')) ?? "", /CONSTRAINT "team_member_membership_key" UNIQUE\("company_id","team_id","user_account_id"\)/)
    assert.equal(checksOf(team).get("team_status_one_of"), `${ref("team", "status")} in (${list(...TEAM_STATUSES)})`)
    assert.equal(checksOf(ticketTeamDefault).get("ticket_team_default_kind_one_of"), `${ref("ticket_team_default", "kind")} in (${list(...TICKET_KINDS)})`)
  })
})

describe("the ticket teams' migration", () => {
  test("is drizzle-kit's statements, then the three tables' fences and triggers, then their audit trails", async () => {
    const text = await readFile(join(MIGRATIONS_FOLDER, await migrationName()), "utf8")
    const statements = statementsOf(text)
    const drizzle = await generated()
    assert.deepEqual([...statements.slice(0, drizzle.length)].sort(), [...drizzle].sort())
    assert.deepEqual(statements.slice(drizzle.length), [...[team, teamMember, ticketTeamDefault].flatMap(handWrittenStatements), ...TEAMS_AUDITED.flatMap(auditTrail)].map(normalised))
    assert.match(text, /^-- Ticket teams \(O30 of #290, row 7\.20\)/)
  })

  test("the three are audited under the templates' grant, the members a set of their team and the defaults a set of their project", () => {
    assert.deepEqual(
      TEAMS_AUDITED.map((entry) => [entry.table, entry.module, entry.parent]),
      [
        [team, "configure.templates", undefined],
        [teamMember, "configure.templates", { table: team, column: teamMember.teamId }],
        [ticketTeamDefault, "configure.templates", { table: project, column: ticketTeamDefault.projectId }],
      ],
    )
  })
})
