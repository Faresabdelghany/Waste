// The waste-fraction change (#474, part 4) as drizzle-kit writes it: the
// Activity's kind list grows by `waste-fraction-change`, which carries its
// scheme, group and first day and no other kind's columns, and moves through
// an Approval's statuses as the domain's proposal kinds say; its fractions are
// a set of their own, `service_provider_activity_fraction`, each a fraction of
// the company's, once. Then the migration, which is exactly those statements,
// diffed from the activity as 0065 left it (activity-as-of.ts), then the
// set's fence and trigger and its audit trail as its activity's set
// (`WASTE_FRACTION_PROPOSALS_AUDITED`). No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { getTableName } from "drizzle-orm"

import { PROPOSAL_KINDS } from "@waste/domain/service-providers/activities"
import { SERVICE_PROVIDER_ACTIVITY_KINDS } from "@waste/domain/service-providers/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { userAccount } from "../schema/access"
import { wasteFraction } from "../schema/catalogue"
import { container } from "../schema/containers"
import { serviceArea } from "../schema/finance"
import { driver, vehicle } from "../schema/fleet"
import { company, project, serviceProvider } from "../schema/organisation"
import { collectionGroup, routeScheme } from "../schema/route-schemes"
import { serviceProviderActivity, serviceProviderActivityContainer, serviceProviderActivityFraction } from "../schema/service-provider-activities"
import { auditTrail, WASTE_FRACTION_PROPOSALS_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { serviceProviderActivityAsOf0065 } from "./activity-as-of"
import { checksOf, list, ref } from "./rendering"
import { statementsBetween } from "./specimen"

const MIGRATION = "0066_waste_fraction_proposals.sql"

const referenced = { company, project, serviceProvider, serviceArea, routeScheme, collectionGroup, userAccount, vehicle, driver, container, wasteFraction, serviceProviderActivityContainer }

/** What drizzle-kit writes: the activity from its 0065 spelling to today's, and the set. */
const generated = (): Promise<string[]> => statementsBetween({ ...referenced, serviceProviderActivity: serviceProviderActivityAsOf0065 }, { ...referenced, serviceProviderActivity, serviceProviderActivityFraction })

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

const column = (name: string) => ref("service_provider_activity", name)

describe("the waste-fraction change as drizzle-kit writes it", () => {
  test("the migration is exactly what the schema generates from 0065's activity, then the set's fence, trigger and audit trail", async () => {
    assert.deepEqual(await fileStatements(), [...(await generated()), ...handWrittenStatements(serviceProviderActivityFraction), ...WASTE_FRACTION_PROPOSALS_AUDITED.flatMap(auditTrail)].map(normalised))
  })

  test("the set names its activity within its project and a fraction of the company's, each once", async () => {
    const statements = await generated()
    const keys = statements.filter((statement) => statement.includes("FOREIGN KEY") && statement.startsWith('ALTER TABLE "wms"."service_provider_activity_fraction"'))
    assert.deepEqual(
      keys.map((statement) => statement.match(/FOREIGN KEY \(([^)]*)\) REFERENCES "wms"\."([a-z_]+)"/)?.slice(1, 3).join(" → ")),
      ['"company_id" → company', '"company_id","project_id" → project', '"company_id","project_id","activity_id" → service_provider_activity', '"company_id","waste_fraction_id" → waste_fraction'],
    )
    const table = statements.find((statement) => statement.startsWith('CREATE TABLE "wms"."service_provider_activity_fraction"')) ?? ""
    assert.match(table, /CONSTRAINT "service_provider_activity_fraction_membership_key" UNIQUE\("company_id","activity_id","waste_fraction_id"\)/)
  })

  test("the kind's list grows by the waste-fraction change, a proposal, which carries no days, vehicle or due day", () => {
    const checks = checksOf(serviceProviderActivity)
    assert.equal(SERVICE_PROVIDER_ACTIVITY_KINDS.at(-1), "waste-fraction-change")
    assert.equal(checks.get("service_provider_activity_kind_one_of"), `${column("kind")} in (${list(...SERVICE_PROVIDER_ACTIVITY_KINDS)})`)
    assert.ok(PROPOSAL_KINDS.includes("waste-fraction-change" as never))
    assert.match(checks.get("service_provider_activity_status_shape") ?? "", new RegExp(`in \\(${list(...PROPOSAL_KINDS)}\\) then`))
    const branch = (checks.get("service_provider_activity_kind_shape") ?? "").split("when 'waste-fraction-change' then ")[1]?.split(" when ")[0] ?? ""
    for (const name of ["service_days", "due_on", "vehicle_id", "driver_id"]) assert.ok(branch.includes(`${column(name)} is null`), name)
    for (const name of ["route_scheme_id", "collection_group_id", "effective_from"]) assert.ok(branch.includes(`${column(name)} is not null`), name)
  })

  test("the set is audited as its activity's", () => {
    assert.deepEqual(WASTE_FRACTION_PROPOSALS_AUDITED.map((entry) => [getTableName(entry.table), entry.module]), [["service_provider_activity_fraction", "service-providers.activities"]])
  })
})
