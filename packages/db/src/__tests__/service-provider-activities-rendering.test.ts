// Service Provider Activities (#474) as drizzle-kit writes them: one table,
// over its project and its provider, its kind and status read off the service
// providers' vocabulary, each kind held to its own columns and statuses, a
// closed row to who closed it, a rejection to its reason and an approval to
// the scheme version it wrote. Then migration 0062, which is exactly those
// statements, then the table's fence and trigger and its audit trail
// (`SERVICE_PROVIDER_ACTIVITIES_AUDITED`). No database.
import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { describe, test } from "node:test"

import { SERVICE_DAYS } from "@waste/domain/planning/vocabulary"
import { PROPOSAL_KINDS } from "@waste/domain/service-providers/activities"
import { SERVICE_PROVIDER_ACTIVITY_KINDS, SERVICE_PROVIDER_ACTIVITY_STATUSES } from "@waste/domain/service-providers/vocabulary"

import { MIGRATIONS_FOLDER } from "../migrate"
import { userAccount } from "../schema/access"
import { serviceArea } from "../schema/finance"
import { company, project, serviceProvider } from "../schema/organisation"
import { collectionGroup, routeScheme } from "../schema/route-schemes"
import { serviceProviderActivity } from "../schema/service-provider-activities"
import { auditTrail, SERVICE_PROVIDER_ACTIVITIES_AUDITED } from "../sql/audit-trail"
import { handWrittenStatements, normalised, statementsOf } from "../sql/hand-written"
import { checksOf, list, ref } from "./rendering"
import { statementsBetween } from "./specimen"

const MIGRATION = "0062_service_provider_activities.sql"

const referenced = { company, project, serviceProvider, serviceArea, routeScheme, collectionGroup, userAccount }

/** What drizzle-kit writes for 0062: the one table. */
const generated = (): Promise<string[]> => statementsBetween(referenced, { ...referenced, serviceProviderActivity })

const fileStatements = async (): Promise<string[]> => statementsOf(await readFile(join(MIGRATIONS_FOLDER, MIGRATION), "utf8"))

const column = (name: string) => ref("service_provider_activity", name)

describe("the activities as drizzle-kit writes them", () => {
  test("migration 0062 is exactly what the schema generates, then the fence, the trigger and the audit trail", async () => {
    assert.deepEqual(await fileStatements(), [...(await generated()), ...handWrittenStatements(serviceProviderActivity), ...SERVICE_PROVIDER_ACTIVITIES_AUDITED.flatMap(auditTrail)].map(normalised))
  })

  test("an Activity names its provider and its accounts within the tenant, and its award, scheme, group and version within its project", async () => {
    const keys = (await generated()).filter((statement) => statement.includes("FOREIGN KEY"))
    assert.deepEqual(
      keys.map((statement) => statement.match(/FOREIGN KEY \(([^)]*)\) REFERENCES "wms"\."([a-z_]+)"/)?.slice(1, 3).join(" → ")),
      [
        '"company_id" → company',
        '"company_id","project_id" → project',
        '"company_id","service_provider_id" → service_provider',
        '"company_id","project_id","service_area_id" → service_area',
        '"company_id","project_id","route_scheme_id" → route_scheme',
        '"company_id","project_id","collection_group_id" → collection_group',
        '"company_id","project_id","successor_scheme_id" → route_scheme',
        '"company_id","opened_by" → user_account',
        '"company_id","closed_by" → user_account',
      ],
    )
  })
})

describe("the checks", () => {
  test("its kind and status are the vocabulary's, its days weekdays, and its subject given", () => {
    const checks = checksOf(serviceProviderActivity)
    assert.equal(checks.get("service_provider_activity_kind_one_of"), `${column("kind")} in (${list(...SERVICE_PROVIDER_ACTIVITY_KINDS)})`)
    assert.equal(checks.get("service_provider_activity_status_one_of"), `${column("status")} in (${list(...SERVICE_PROVIDER_ACTIVITY_STATUSES)})`)
    assert.equal(checks.get("service_provider_activity_service_days_subset_of"), `${column("service_days")} <@ ARRAY[${list(...SERVICE_DAYS)}]::text[]`)
    assert.equal(checks.get("service_provider_activity_subject_given"), `length(btrim(${column("subject")})) > 0`)
  })

  test("a proposal moves through its Approval's statuses, the domain's proposal kinds named once", () => {
    assert.equal(
      checksOf(serviceProviderActivity).get("service_provider_activity_status_shape"),
      `case when ${column("kind")} in (${list(...PROPOSAL_KINDS)}) then ${column("status")} in ('pending-approval', 'approved', 'rejected', 'withdrawn') else ${column("status")} in ('open', 'completed', 'cancelled') end`,
    )
  })

  test("a closed Activity says who closed it, a rejection why, and only an approval names its version", () => {
    assert.equal(
      checksOf(serviceProviderActivity).get("service_provider_activity_closed_shape"),
      `(${column("status")} in ('pending-approval', 'open')) = (${column("closed_by")} is null and ${column("closed_at")} is null) and (${column("status")} <> 'rejected' or ${column("close_reason")} is not null) and (${column("status")} = 'approved') = (${column("successor_scheme_id")} is not null)`,
    )
  })

  test("the Activity is audited under its module", () => {
    assert.deepEqual(SERVICE_PROVIDER_ACTIVITIES_AUDITED.map((entry) => [entry.table, entry.module, entry.parent]), [[serviceProviderActivity, "service-providers.activities", undefined]])
  })
})
