// The vehicle change (#474, part 2) as drizzle-kit writes it: the Activity
// gains the vehicle and the driver a vehicle change names, each within its
// project, and its three checks are replaced — the kind's list grows by
// `vehicle-change`, each kind still carries its own columns and none of
// another's, and the vehicle change moves through an Approval's statuses as
// the domain's proposal kinds say. Migration 0064 is exactly those
// statements, diffed from the table as 0063 left it (activity-as-of.ts): a
// column on an audited table owes no hand-written statement. No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { PROPOSAL_KINDS } from "@waste/domain/service-providers/activities"
import { SERVICE_PROVIDER_ACTIVITY_KINDS } from "@waste/domain/service-providers/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { userAccount } from "../schema/access"
import { serviceArea } from "../schema/finance"
import { driver, vehicle } from "../schema/fleet"
import { company, project, serviceProvider } from "../schema/organisation"
import { collectionGroup, routeScheme } from "../schema/route-schemes"
import { serviceProviderActivity } from "../schema/service-provider-activities"
import { normalised, statementsOf } from "../sql/hand-written"
import { serviceProviderActivityAsOf0063 } from "./activity-as-of"
import { checksOf, list, ref } from "./rendering"
import { statementsBetween } from "./specimen"

const MIGRATION = "0064_vehicle_change_proposals.sql"

const referenced = { company, project, serviceProvider, serviceArea, routeScheme, collectionGroup, userAccount, vehicle, driver }

/** What drizzle-kit writes for 0064: the activity from its 0063 spelling to today's. */
const generated = (): Promise<string[]> => statementsBetween({ ...referenced, serviceProviderActivity: serviceProviderActivityAsOf0063 }, { ...referenced, serviceProviderActivity })

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

const column = (name: string) => ref("service_provider_activity", name)

describe("the vehicle change as drizzle-kit writes it", () => {
  test("migration 0064 is exactly what the schema generates from 0063's table, and nothing hand-written", async () => {
    assert.deepEqual(await fileStatements(), (await generated()).map(normalised))
  })

  test("the vehicle and the driver are the activity's project's", async () => {
    const keys = (await generated()).filter((statement) => statement.includes("FOREIGN KEY"))
    assert.deepEqual(
      keys.map((statement) => statement.match(/FOREIGN KEY \(([^)]*)\) REFERENCES "wms"\."([a-z_]+)"/)?.slice(1, 3).join(" → ")),
      ['"company_id","project_id","vehicle_id" → vehicle', '"company_id","project_id","driver_id" → driver'],
    )
  })

  test("the kind's list grows by the vehicle change, and it moves through an Approval's statuses", () => {
    const checks = checksOf(serviceProviderActivity)
    assert.equal(SERVICE_PROVIDER_ACTIVITY_KINDS.at(-1), "vehicle-change")
    assert.equal(checks.get("service_provider_activity_kind_one_of"), `${column("kind")} in (${list(...SERVICE_PROVIDER_ACTIVITY_KINDS)})`)
    assert.deepEqual([...PROPOSAL_KINDS], ["route-day-change", "vehicle-change"])
    assert.match(checks.get("service_provider_activity_status_shape") ?? "", new RegExp(`in \\(${list(...PROPOSAL_KINDS)}\\) then`))
  })

  test("a vehicle change carries its vehicle and no days; no other kind carries a vehicle or a driver", () => {
    const shape = checksOf(serviceProviderActivity).get("service_provider_activity_kind_shape") ?? ""
    assert.match(shape, new RegExp(`when 'vehicle-change' then .*${column("vehicle_id").replace(/[".]/g, "\\$&")} is not null.*${column("service_days").replace(/[".]/g, "\\$&")} is null`))
    for (const kind of ["route-day-change", "compliance-follow-up"]) {
      const branch = shape.split(`when '${kind}' then `)[1]?.split(" when ")[0] ?? ""
      assert.match(branch, /"vehicle_id" is null and "wms"\."service_provider_activity"\."driver_id" is null/, kind)
    }
  })
})
