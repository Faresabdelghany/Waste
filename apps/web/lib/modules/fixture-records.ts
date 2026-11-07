// The fixture records of the modules still on the browser's path, and the
// projects each is filed under. A switched module (SERVER_MODULES,
// lib/api/records/modules.ts) has none: its rows are the API's alone.
import type { BusinessRecord } from "@/lib/prototype/prototype-record"

export const FIXTURE_PROJECT_IDS = {
  copenhagen: "project-copenhagen",
  harbor: "project-harbor",
  cairo: "project-cairo",
} as const

export const FIXTURE_SERVICE_PROVIDER_IDS = {
  nordren: "service-provider-nordren",
  cityhaul: "service-provider-cityhaul",
} as const

type FixtureProjectId =
  (typeof FIXTURE_PROJECT_IDS)[keyof typeof FIXTURE_PROJECT_IDS]

const copenhagenFixtureRecordIds = [
  "driver-session-1042",
  "driver-session-1039",
  "driver-session-1048",
  "portal-activity-parkvej",
  "portal-request-8826",
  "insight-441",
  "dashboard-ops",
  "dashboard-service-provider",
  "flow-14",
  "flow-09",
  "suggestion-881",
  "import-771",
  "export-8801",
  "import-779",
  "scorecard-central",
  "finance-defaults",
  "billing-schedule-cph-monthly",
  "routing-organic",
  "integration-gps",
  "integration-digitalpost",
  "portal-copenhagen",
  "subscription-route-studio",
] as const

const harborFixtureRecordIds = [
  "portal-request-container",
  "portal-harbor",
  "offer-2044",
  "subscription-harbor",
  "marketplace-order-2908",
] as const

const companyWideFixtureRecordIds = [
  "report-ads-july",
  "metric-route-cost",
  "compliance-gps",
  "report-mgmt-july",
  "metric-proof",
  "integration-navision",
  "sales-lead-greenloop",
] as const

/** The projects each fixture record is filed under, by id. */
const fixtureProjectsById: Readonly<Record<string, readonly FixtureProjectId[]>> = Object.freeze(
  Object.fromEntries([
    ...copenhagenFixtureRecordIds.map((id) => [id, [FIXTURE_PROJECT_IDS.copenhagen]] as const),
    ...harborFixtureRecordIds.map((id) => [id, [FIXTURE_PROJECT_IDS.harbor]] as const),
    ...companyWideFixtureRecordIds.map((id) => [id, [FIXTURE_PROJECT_IDS.copenhagen, FIXTURE_PROJECT_IDS.harbor]] as const),
  ]),
)

export function record(
  id: string,
  name: string,
  context: string,
  status: string,
  owner: string,
  value: string,
  updated: string,
  description: string,
  facts: Record<string, string>,
  related: string[],
  source = "Kystbyen",
  freshness = "Live",
  allowedTransitions?: string[],
): BusinessRecord {
  const projectIds = fixtureProjectsById[id]
  if (!projectIds) {
    throw new Error(`Missing explicit fixture scope for ${id}`)
  }
  return {
    id,
    name,
    context,
    status,
    owner,
    value,
    updated,
    description,
    facts,
    related,
    source,
    freshness,
    allowedTransitions,
    projectIds: [...projectIds],
  }
}
