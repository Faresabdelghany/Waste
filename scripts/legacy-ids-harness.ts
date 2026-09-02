// Headless checks for the Contractor → Service provider / Contract area →
// Service area legacy-id migration (lib/data/legacy-ids.ts): module-key and id
// mapping, idempotence, term-prefixed free text rewritten and other free text
// left untouched, href rewriting, and a
// pre-rename business-record-store payload migrated the way the store does it
// on load (components/wastehero/business-record-store.tsx).
// Run: npx tsx scripts/legacy-ids-harness.ts
import {
  LEGACY_ENUM_VALUES,
  LEGACY_FACT_LABELS,
  LEGACY_FIELD_IDS,
  LEGACY_MODULE_IDS,
  LEGACY_MODULE_KEYS,
  LEGACY_TERM_PREFIXES,
  LEGACY_TERM_VALUES,
  hasLegacyIds,
  migrateLegacyHref,
  migrateLegacyId,
  migrateLegacyModuleId,
  migrateLegacyModuleKey,
  migrateLegacyRecordBuckets,
  migrateLegacyState,
  migrateLegacyWorkspaceId,
} from "../lib/data/legacy-ids"

let passed = 0
let failed = 0
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) passed += 1
  else failed += 1
  console.log(
    `${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`,
  )
}

/* ------------------------------ module keys ------------------------------- */

for (const [legacy, current] of Object.entries(LEGACY_MODULE_KEYS)) {
  check(`module key ${legacy} → ${current}`, migrateLegacyModuleKey(legacy), current)
  check(`module key ${current} is stable`, migrateLegacyModuleKey(current), current)
}
check(
  "an unlisted legacy bucket key still resolves token-wise",
  migrateLegacyModuleKey("contractors.settlements"),
  "service-providers.settlements",
)
check(
  "an unrelated bucket key is untouched",
  migrateLegacyModuleKey("operate.route-schemes"),
  "operate.route-schemes",
)
for (const [legacy, current] of Object.entries(LEGACY_MODULE_IDS)) {
  check(`module id ${legacy} → ${current}`, migrateLegacyModuleId(legacy), current)
}
check("module id routes is untouched", migrateLegacyModuleId("routes"), "routes")
check(
  "workspace id contractors → service-providers",
  migrateLegacyWorkspaceId("contractors"),
  "service-providers",
)

/* ------------------------------- record ids ------------------------------- */

const ID_CASES: ReadonlyArray<readonly [string, string]> = [
  ["contractor-nordren", "service-provider-nordren"],
  ["contractor-cityhaul", "service-provider-cityhaul"],
  ["contract-area-amager-1", "service-area-amager-1"],
  ["contract-area-osterbro-2", "service-area-osterbro-2"],
  ["role-contractor-manager", "role-service-provider-manager"],
  ["role-contractor-foreman", "role-service-provider-foreman"],
  ["contractor-price-nordren-res", "service-provider-price-nordren-res"],
  ["contractor-access-nordren-manager", "service-provider-access-nordren-manager"],
  ["contractor-activity-proposal-88", "service-provider-activity-proposal-88"],
  // Legacy tokens in the middle or at the end of an id.
  ["dashboard-contractor", "dashboard-service-provider"],
  ["organization-user-contractor", "organization-user-service-provider"],
  ["contractors-active", "service-providers-active"],
  ["no-contractors", "no-service-providers"],
  ["contractor-users", "service-provider-users"],
  ["commercial.contractor-prices.apply-index", "commercial.service-provider-prices.apply-index"],
  // Ids the workspace generates for user-created records: `${moduleId}-${kind}-${timestamp}`.
  ["contract-areas-service-area-1725000000000", "service-areas-service-area-1725000000000"],
  ["contractor-prices-event-1725000000000", "service-provider-prices-event-1725000000000"],
  ["contractors-company-1725000000000", "service-providers-company-1725000000000"],
]
for (const [legacy, current] of ID_CASES) {
  check(`id ${legacy} → ${current}`, migrateLegacyId(legacy), current)
}
for (const [legacy, current] of Object.entries(LEGACY_ENUM_VALUES)) {
  check(`enum ${legacy} → ${current}`, migrateLegacyId(legacy), current)
}

const STABLE_IDS = [
  "service-provider-nordren",
  "service-area-amager-1",
  "service-providers.service-provider-workspace",
  "role-service-provider-manager",
  "contract-manager",
  "subcontractor-review",
  "route-day-1052",
  "2026-09-02",
  "constructor",
  "toString",
]
for (const id of STABLE_IDS) {
  check(`id ${id} is never rewritten`, migrateLegacyId(id), id)
}

/* ------------------------------ idempotence ------------------------------- */

for (const [legacy] of ID_CASES) {
  const once = migrateLegacyId(legacy)
  check(`migrateLegacyId is idempotent for ${legacy}`, migrateLegacyId(once), once)
}
for (const [legacy] of Object.entries(LEGACY_MODULE_KEYS)) {
  const once = migrateLegacyModuleKey(legacy)
  check(`migrateLegacyModuleKey is idempotent for ${legacy}`, migrateLegacyModuleKey(once), once)
}

/* ---------------------------- free text untouched ------------------------- */

const FREE_TEXT = [
  "NordRen ApS",
  "CityHaul A/S",
  "Previous contractor NordRen ApS",
  "Subcontractor review pending",
  "Subcontractor NordRen ApS",
  "Contract assignment CA-Ø-2",
  "Office contract manager",
  "12 routes · 3 contractors",
  "contractor manager",
  "2h ago",
  "Contract Team",
]
for (const text of FREE_TEXT) {
  check(`free text "${text}" is untouched`, migrateLegacyState(text), text)
}
check(
  "free text inside a record is untouched while its keys migrate",
  migrateLegacyState({
    Contractor: "NordRen ApS",
    description: "Awarded to the contractor after the 2024 tender.",
  }),
  {
    "Service provider": "NordRen ApS",
    description: "Awarded to the contractor after the 2024 tender.",
  },
)
for (const [legacy, current] of Object.entries(LEGACY_TERM_VALUES)) {
  check(`exact term value ${legacy} → ${current}`, migrateLegacyState(legacy), current)
}

/* ------------------------- term-prefixed free text ------------------------ */

const PREFIX_CASES: ReadonlyArray<readonly [string, string]> = [
  // `related` chips carried by pre-rename fixtures and kept by records edited before the rename.
  ["Contractor NordRen ApS", "Service provider NordRen ApS"],
  ["Contractor CityHaul A/S", "Service provider CityHaul A/S"],
  ["Contract area CA-Ø-2", "Service area CA-Ø-2"],
  ["Contract areas CA-Ø-2 and CA-AM-1", "Service areas CA-Ø-2 and CA-AM-1"],
  // Descriptions and helper copy.
  ["Contractors see only their own users and fleet.", "Service providers see only their own users and fleet."],
  ["Contractor-owned paper compactor serving Østerbro.", "Service provider-owned paper compactor serving Østerbro."],
  ["Contractor owned since 2024", "Service provider owned since 2024"],
]
for (const [legacy, current] of PREFIX_CASES) {
  check(`prefixed text "${legacy}" → "${current}"`, migrateLegacyState(legacy), current)
  check(`prefix rewrite is idempotent for "${legacy}"`, migrateLegacyState(current), current)
}
for (const [legacy, current] of LEGACY_TERM_PREFIXES) {
  check(`prefix ${JSON.stringify(legacy)} → ${JSON.stringify(current)}`, migrateLegacyState(`${legacy}X`), `${current}X`)
}
check(
  "exact Title Case role names win over the sentence-case prefix rewrite",
  ["Contractor Manager", "Contractor Foreman"].map((name) => migrateLegacyState(name)),
  ["Service Provider Manager", "Service Provider Foreman"],
)
check(
  "a prefix only counts at the string start",
  migrateLegacyState("Route RC-1052 · Contractor NordRen ApS"),
  "Route RC-1052 · Contractor NordRen ApS",
)
for (const [legacy, current] of Object.entries(LEGACY_FIELD_IDS)) {
  check(
    `camelCase field id ${legacy} is not id-shaped and stays as a plain value`,
    migrateLegacyState(legacy),
    legacy,
  )
  check(
    `camelCase field id ${legacy} → ${current} as a fieldId`,
    migrateLegacyState({ fieldId: legacy }),
    { fieldId: current },
  )
}

/* --------------------------------- hrefs ---------------------------------- */

const HREF_CASES: ReadonlyArray<readonly [string, string]> = [
  ["/contractors", "/service-providers"],
  ["/contractors?module=contractors", "/service-providers?module=service-providers"],
  [
    "/contractors?module=contract-areas&record=contract-area-amager-1",
    "/service-providers?module=service-areas&record=service-area-amager-1",
  ],
  ["/contractor-workspace", "/service-provider-workspace"],
  ["/contractor-workspace/team", "/service-provider-workspace/team"],
  [
    "/contractor-workspace/routes?module=routes&record=route-day-1052",
    "/service-provider-workspace/routes?module=routes&record=route-day-1052",
  ],
  ["/commercial?module=contractor-prices", "/commercial?module=service-provider-prices"],
  [
    "/commercial?module=contractor-prices&record=contractor-price-nordren-res",
    "/commercial?module=service-provider-prices&record=service-provider-price-nordren-res",
  ],
  ["/operate?module=routes&record=contractor-nordren", "/operate?module=routes&record=service-provider-nordren"],
  ["/settings?module=access&record=role-contractor-manager", "/settings?module=access&record=role-service-provider-manager"],
  // Already-migrated and unrelated hrefs are stable.
  ["/service-providers?module=service-areas", "/service-providers?module=service-areas"],
  ["/service-provider-workspace/routes", "/service-provider-workspace/routes"],
  ["/operate?module=routes&record=route-day-1052", "/operate?module=routes&record=route-day-1052"],
  ["/contractors-archive", "/contractors-archive"],
  ["/portal", "/portal"],
  ["https://example.com/contractors", "https://example.com/contractors"],
]
for (const [legacy, current] of HREF_CASES) {
  check(`href ${legacy} → ${current}`, migrateLegacyHref(legacy), current)
  check(`href rewrite is idempotent for ${legacy}`, migrateLegacyHref(current), current)
}

/* ----------------------------- state migration ---------------------------- */

check(
  "hasLegacyIds sees a fact key whose only legacy remnant is capitalised",
  hasLegacyIds(JSON.stringify({ facts: { Contractor: "NordRen ApS" } })),
  true,
)
check("hasLegacyIds sees a legacy bucket key", hasLegacyIds('{"contractors.contract-areas":[]}'), true)
check("hasLegacyIds sees a legacy fact label", hasLegacyIds('{"Contract area":"Amager 1"}'), true)
check("hasLegacyIds sees a camelCase field id", hasLegacyIds('{"contractAreaId":"x"}'), true)
check("hasLegacyIds is quiet on migrated state", hasLegacyIds('{"service-providers.service-areas":[{"serviceAreaId":"service-area-amager-1"}]}'), false)
check("hasLegacyIds leaves contract (agreement) alone", hasLegacyIds('{"role":"Office contract manager"}'), false)

const migratedState = { id: "service-provider-nordren", facts: { "Service provider": "NordRen ApS" } }
check(
  "migrateLegacyState returns the same reference when nothing changes",
  migrateLegacyState(migratedState) === migratedState,
  true,
)
check(
  "stored-new wins when a legacy key and its replacement coexist",
  migrateLegacyState({
    contractorId: "contractor-cityhaul",
    serviceProviderId: "service-provider-nordren",
    facts: { Contractor: "CityHaul A/S", "Service provider": "NordRen ApS" },
  }),
  {
    serviceProviderId: "service-provider-nordren",
    facts: { "Service provider": "NordRen ApS" },
  },
)
check(
  "extraKeys rename the store-specific bare field and its fieldId",
  migrateLegacyState(
    {
      submittedValues: { contractor: "NordRen ApS" },
      relationRefs: [{ fieldId: "contractor", recordId: "contractor-nordren" }],
    },
    { contractor: "serviceProvider" },
  ),
  {
    submittedValues: { serviceProvider: "NordRen ApS" },
    relationRefs: [{ fieldId: "serviceProvider", recordId: "service-provider-nordren" }],
  },
)
check(
  "without extraKeys the bare value contractor is a scope enum",
  migrateLegacyState({ scope: "contractor", persona: "contractor" }),
  { scope: "service-provider", persona: "service-provider" },
)
check(
  "booleans, numbers and null pass through",
  migrateLegacyState({ active: true, count: 3, none: null, list: [1, false] }),
  { active: true, count: 3, none: null, list: [1, false] },
)

/* --------------------- sample record-store payload (legacy) --------------- */

type StoreRecord = { id: string; name: string; [key: string]: unknown }

const legacyPayload: Record<string, StoreRecord[]> = {
  "fleet.drivers": [
    {
      id: "drivers-driver-1725000000001",
      name: "Jonas Friis",
      facts: { Contractor: "NordRen ApS", Employment: "Contractor workforce" },
      submittedValues: { employmentType: "contractor", contractorId: "contractor-nordren" },
      relationRefs: [
        {
          fieldId: "contractorId",
          workspaceId: "contractors",
          moduleId: "contractors",
          recordId: "contractor-nordren",
          label: "NordRen ApS",
        },
      ],
      contractorId: "contractor-nordren",
    },
  ],
  "contractors.contract-areas": [
    {
      id: "contract-areas-contract-area-1725000000002",
      name: "Valby 3",
      recordKind: "Contract area",
      facts: { Contractor: "CityHaul A/S", "Contract area name": "Valby 3", "Record kind": "Contract area" },
      submittedValues: { areaName: "Valby 3", contractorId: "contractor-cityhaul" },
      related: ["contractor-cityhaul", "Awarded after the 2026 tender"],
      contractorId: "contractor-cityhaul",
    },
    {
      // Also stored under the new key below — the new copy must win.
      id: "service-area-amager-1",
      name: "Amager 1 (stale edit)",
      facts: { Contractor: "CityHaul A/S" },
    },
  ],
  "service-providers.service-areas": [
    { id: "service-area-amager-1", name: "Amager 1", facts: { "Service provider": "CityHaul A/S" } },
  ],
  "contractors.contractor-workspace": [
    {
      id: "contractor-workspace-user-1725000000003",
      name: "Mette Holm",
      recordKind: "Contractor user",
      facts: { Contractor: "NordRen ApS", "Allowed contract area": "Østerbro 2", "Contractor role": "Foreman" },
      submittedValues: { contractor: "NordRen ApS", role: "role-contractor-foreman" },
      deepLink: "/contractor-workspace/team?module=contractor-workspace&record=contractor-workspace-user-1725000000003",
    },
  ],
  "commercial.contractor-prices": [
    {
      id: "contractor-prices-contractor-price-1725000000004",
      name: "NordRen ApS · Residual 240 L",
      recordKind: "Contractor price",
      facts: { Contractor: "NordRen ApS", "Contract area": "Østerbro 2", Product: "Residual 240 L" },
      submittedValues: { contractorId: "contractor-nordren", contractAreaId: "contract-area-osterbro-2", subjectType: "contract-area" },
    },
  ],
  "resources.depots": [
    {
      id: "depots-depot-1725000000005",
      name: "Sydhavn yard",
      facts: { Ownership: "Contractor owned" },
      submittedValues: { ownership: "contractor", contractorId: "contractor-cityhaul" },
    },
  ],
  "operate.routes": [{ id: "route-day-1052", name: "Route 1052", facts: { Vehicle: "AB 12 345" } }],
  "route-studio.schemes": [
    {
      // A fixture scheme edited before the rename: the bucket key is current,
      // but its `related` chips and description still start with the old terms.
      id: "scheme-osterbro-b",
      name: "RS-Østerbro-B",
      description: "Contractor-operated organic route generated from route scheme RS-Østerbro-B.",
      related: ["2 under-served frequency promises", "Contract area CA-Ø-2", "Contractor NordRen ApS"],
    },
  ],
}

const expectedPayload: Record<string, StoreRecord[]> = {
  "fleet.drivers": [
    {
      id: "drivers-driver-1725000000001",
      name: "Jonas Friis",
      facts: { "Service provider": "NordRen ApS", Employment: "Service provider workforce" },
      submittedValues: { employmentType: "service-provider", serviceProviderId: "service-provider-nordren" },
      relationRefs: [
        {
          fieldId: "serviceProviderId",
          workspaceId: "service-providers",
          moduleId: "service-providers",
          recordId: "service-provider-nordren",
          label: "NordRen ApS",
        },
      ],
      serviceProviderId: "service-provider-nordren",
    },
  ],
  "service-providers.service-areas": [
    { id: "service-area-amager-1", name: "Amager 1", facts: { "Service provider": "CityHaul A/S" } },
    {
      id: "service-areas-service-area-1725000000002",
      name: "Valby 3",
      recordKind: "Service area",
      facts: { "Service provider": "CityHaul A/S", "Service area name": "Valby 3", "Record kind": "Service area" },
      submittedValues: { areaName: "Valby 3", serviceProviderId: "service-provider-cityhaul" },
      related: ["service-provider-cityhaul", "Awarded after the 2026 tender"],
      serviceProviderId: "service-provider-cityhaul",
    },
  ],
  "resources.depots": [
    {
      id: "depots-depot-1725000000005",
      name: "Sydhavn yard",
      facts: { Ownership: "Service provider owned" },
      submittedValues: { ownership: "service-provider", serviceProviderId: "service-provider-cityhaul" },
    },
  ],
  "operate.routes": [{ id: "route-day-1052", name: "Route 1052", facts: { Vehicle: "AB 12 345" } }],
  "route-studio.schemes": [
    {
      id: "scheme-osterbro-b",
      name: "RS-Østerbro-B",
      description: "Service provider-operated organic route generated from route scheme RS-Østerbro-B.",
      related: ["2 under-served frequency promises", "Service area CA-Ø-2", "Service provider NordRen ApS"],
    },
  ],
  "service-providers.service-provider-workspace": [
    {
      id: "service-provider-workspace-user-1725000000003",
      name: "Mette Holm",
      recordKind: "Service provider user",
      facts: { "Service provider": "NordRen ApS", "Allowed service area": "Østerbro 2", "Service provider role": "Foreman" },
      submittedValues: { serviceProvider: "NordRen ApS", role: "role-service-provider-foreman" },
      deepLink:
        "/service-provider-workspace/team?module=service-provider-workspace&record=service-provider-workspace-user-1725000000003",
    },
  ],
  "commercial.service-provider-prices": [
    {
      id: "service-provider-prices-service-provider-price-1725000000004",
      name: "NordRen ApS · Residual 240 L",
      recordKind: "Service provider price",
      facts: { "Service provider": "NordRen ApS", "Service area": "Østerbro 2", Product: "Residual 240 L" },
      submittedValues: {
        serviceProviderId: "service-provider-nordren",
        serviceAreaId: "service-area-osterbro-2",
        subjectType: "service-area",
      },
    },
  ],
}

const STORE_EXTRA_KEYS = { contractor: "serviceProvider" }
const migratedPayload = migrateLegacyRecordBuckets(legacyPayload, STORE_EXTRA_KEYS)

check("legacy record-store payload migrates bucket keys and record contents", migratedPayload, expectedPayload)
check(
  "the migrated payload has no legacy remnants",
  hasLegacyIds(JSON.stringify(migratedPayload)),
  false,
)
check(
  "the raw legacy payload is detected by the cheap pre-check",
  hasLegacyIds(JSON.stringify(legacyPayload)),
  true,
)
check(
  "the source payload is not mutated",
  Object.keys(legacyPayload).includes("contractors.contract-areas") &&
    (legacyPayload["fleet.drivers"][0].facts as Record<string, string>).Contractor === "NordRen ApS",
  true,
)
check(
  "migrating the migrated payload again changes nothing",
  migrateLegacyRecordBuckets(migratedPayload, STORE_EXTRA_KEYS),
  expectedPayload,
)
check(
  "migrating the migrated payload again returns the same reference",
  migrateLegacyRecordBuckets(migratedPayload, STORE_EXTRA_KEYS) === migratedPayload,
  true,
)
check(
  "a payload without legacy ids comes back as the same reference",
  migrateLegacyRecordBuckets(expectedPayload, STORE_EXTRA_KEYS) === expectedPayload,
  true,
)
check(
  "merged bucket keeps one record per id with the stored-new record first",
  migratedPayload["service-providers.service-areas"].map((record) => `${record.id}:${record.name}`),
  ["service-area-amager-1:Amager 1", "service-areas-service-area-1725000000002:Valby 3"],
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
