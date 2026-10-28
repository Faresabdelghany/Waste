// The stop-set change (#474, part 3) as drizzle-kit writes it: the
// Activity's kind list grows by `stop-set-change`, which carries its scheme,
// group and first day and no other kind's columns, and moves through an
// Approval's statuses as the domain's proposal kinds say; its containers are
// a set of their own, `service_provider_activity_container`, each the
// activity's project's, once, at its own position in stop order. Then the
// migration, which is exactly those statements, diffed from the activity as
// 0064 left it to the activity as this migration left it (activity-as-of.ts;
// part 4 grew it again), then the set's fence and trigger and its
// audit trail as its activity's set (`STOP_SET_PROPOSALS_AUDITED`). No
// database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { getTableName } from "drizzle-orm"


import { MIGRATIONS_FOLDER } from "../migrate"
import { userAccount } from "../schema/access"
import { container } from "../schema/containers"
import { serviceArea } from "../schema/finance"
import { driver, vehicle } from "../schema/fleet"
import { company, project, serviceProvider } from "../schema/organisation"
import { collectionGroup, routeScheme } from "../schema/route-schemes"
import { serviceProviderActivityContainer } from "../schema/service-provider-activities"
import { auditTrail, STOP_SET_PROPOSALS_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { KINDS_AS_OF_0065, serviceProviderActivityAsOf0064, serviceProviderActivityAsOf0065 as serviceProviderActivity } from "./activity-as-of"
import { checksOf, list, ref } from "./rendering"
import { statementsBetween } from "./specimen"

const MIGRATION = "0065_stop_set_proposals.sql"

const referenced = { company, project, serviceProvider, serviceArea, routeScheme, collectionGroup, userAccount, vehicle, driver, container }

/** What drizzle-kit writes: the activity from its 0064 spelling to today's, and the set. */
const generated = (): Promise<string[]> => statementsBetween({ ...referenced, serviceProviderActivity: serviceProviderActivityAsOf0064 }, { ...referenced, serviceProviderActivity, serviceProviderActivityContainer })

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

const column = (name: string) => ref("service_provider_activity", name)

describe("the stop-set change as drizzle-kit writes it", () => {
  test("the migration is exactly what the schema generates from 0064's activity, then the set's fence, trigger and audit trail", async () => {
    assert.deepEqual(await fileStatements(), [...(await generated()), ...handWrittenStatements(serviceProviderActivityContainer), ...STOP_SET_PROPOSALS_AUDITED.flatMap(auditTrail)].map(normalised))
  })

  test("the set names its activity and its containers within their project, each container once at its own position", async () => {
    const statements = await generated()
    const keys = statements.filter((statement) => statement.includes("FOREIGN KEY") && statement.startsWith('ALTER TABLE "wms"."service_provider_activity_container"'))
    assert.deepEqual(
      keys.map((statement) => statement.match(/FOREIGN KEY \(([^)]*)\) REFERENCES "wms"\."([a-z_]+)"/)?.slice(1, 3).join(" → ")),
      ['"company_id" → company', '"company_id","project_id" → project', '"company_id","project_id","activity_id" → service_provider_activity', '"company_id","project_id","container_id" → container'],
    )
    const table = statements.find((statement) => statement.startsWith('CREATE TABLE "wms"."service_provider_activity_container"')) ?? ""
    assert.match(table, /CONSTRAINT "service_provider_activity_container_membership_key" UNIQUE\("company_id","activity_id","container_id"\)/)
    assert.match(table, /CONSTRAINT "service_provider_activity_container_activity_id_position_key" UNIQUE\("company_id","activity_id","position"\)/)
  })

  test("the kind's list grows by the stop-set change, a proposal, which carries no days, vehicle or due day", () => {
    const checks = checksOf(serviceProviderActivity)
    assert.equal(KINDS_AS_OF_0065.at(-1), "stop-set-change")
    assert.equal(checks.get("service_provider_activity_kind_one_of"), `${column("kind")} in (${list(...KINDS_AS_OF_0065)})`)
    assert.match(checks.get("service_provider_activity_status_shape") ?? "", new RegExp(`in \\(${list("route-day-change", "vehicle-change", "stop-set-change")}\\) then`))
    const branch = (checks.get("service_provider_activity_kind_shape") ?? "").split("when 'stop-set-change' then ")[1]?.split(" when ")[0] ?? ""
    for (const name of ["service_days", "due_on", "vehicle_id", "driver_id"]) assert.ok(branch.includes(`${column(name)} is null`), name)
    for (const name of ["route_scheme_id", "collection_group_id", "effective_from"]) assert.ok(branch.includes(`${column(name)} is not null`), name)
  })

  test("the set is audited as its activity's", () => {
    assert.deepEqual(
      STOP_SET_PROPOSALS_AUDITED.map((entry) => [getTableName(entry.table), entry.module]),
      [["service_provider_activity_container", "service-providers.activities"]],
    )
  })
})
