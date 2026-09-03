// Headless checks for the simplified Plan structure (spec
// docs/specs/PLAN_SIMPLIFICATION.md, decisions Q11/Q12/Q14/Q16): the Plan
// workspace exposes only Calendars / Areas, Route Schemes stays
// in Route Studio, the retired modules are gone everywhere, fixtures carry
// the structured data generation needs, and the service-area selectors
// point at the service provider domain. Importing the schema registry also
// exercises its import-time integrity gates (domain ↔ schema lockstep and
// relation targets).
// Run: npx tsx scripts/plan-structure-harness.ts
import { readFileSync } from "node:fs"

import { publicModuleDomains, publicWorkspaceDomains } from "../lib/data/business-domain"
import {
  businessFormSchemas,
  getBusinessFormSchema,
} from "../lib/data/business-form-schemas"
import { businessWorkspaces, FIXTURE_PROJECT_IDS } from "../lib/data/business-modules"
import {
  LEGACY_FREQUENCY_OPTION_IDS,
  SERVICE_FREQUENCIES,
  serviceFrequencyById,
  serviceFrequencyOfRecord,
} from "../lib/data/service-frequencies"
import { calendarFromRecord } from "../lib/route-schemes/calendar"
import { effectiveStopPlans } from "../lib/route-schemes/groups"
import { stopSelectionMode } from "../lib/route-schemes/matching"
import {
  RECURRENCE_FREQUENCY_LABELS,
  recurrenceFromValues,
} from "../lib/route-schemes/recurrence"

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

/* ------------------------------- navigation ------------------------------- */

check(
  "Plan exposes exactly Calendars, Areas (Q11; Collection Deviations removed 2026-09-03)",
  businessWorkspaces.plan.modules.map((module) => module.id),
  ["calendars", "areas"],
)
check(
  "Route Schemes stays in Route Studio, not reintroduced into Plan",
  businessWorkspaces["route-studio"].modules.map((module) => module.id),
  ["live", "schemes", "routes", "pickups", "weights"],
)
check(
  "Vehicle Planning stays in Fleet",
  businessWorkspaces.fleet.modules.map((module) => module.id),
  ["vehicles", "drivers", "vehicle-planning"],
)
check(
  "the domain registry agrees with the Plan module list",
  publicWorkspaceDomains.find((workspace) => workspace.workspaceId === "plan")
    ?.moduleIds,
  ["calendars", "areas"],
)
check(
  "no module domain entry survives for the retired modules",
  publicModuleDomains.filter((module) =>
    ["pickup-settings", "calendar-days", "collection-weeks", "collection-deviations"].includes(
      module.moduleId,
    ),
  ).length,
  0,
)

/* ------------------------------ form schemas ------------------------------ */

check(
  "no form schema survives for the retired modules",
  businessFormSchemas.filter((schema) =>
    [
      "plan.pickup-settings",
      "plan.calendar-days",
      "plan.collection-weeks",
      "plan.collection-deviations",
    ].includes(schema.key),
  ).length,
  0,
)
check(
  "Collection Calendars now has a real create form, not a deviation action (Q12)",
  [
    getBusinessFormSchema("plan", "calendars")?.mode,
    getBusinessFormSchema("plan", "calendars")?.recordKind,
  ],
  ["create", "Collection Calendar"],
)
check(
  "the calendar form carries the structured generation fields",
  ["workingDays", "holidayDates", "validFrom", "validTo"].every((fieldId) =>
    getBusinessFormSchema("plan", "calendars")
      ?.sections.flatMap((section) => section.fields)
      .some((field) => field.id === fieldId),
  ),
  true,
)
check(
  "no Collection Deviations form survives (removed 2026-09-03)",
  getBusinessFormSchema("plan", "collection-deviations") === undefined,
  true,
)
check(
  "no surviving relation points at a retired module",
  businessFormSchemas
    .flatMap((schema) => schema.sections.flatMap((section) => section.fields))
    .filter((field) =>
      ["pickup-settings", "calendar-days", "collection-weeks", "collection-deviations"].includes(
        field.relation?.moduleId ?? "",
      ),
    ).length,
  0,
)

/* -------------------- service-area selectors (Q16) ----------------------- */

const relationOf = (key: string, fieldId: string) =>
  businessFormSchemas
    .find((schema) => schema.key === key)
    ?.sections.flatMap((section) => section.fields)
    .find((field) => field.id === fieldId)?.relation

check(
  "settlements' Service area points at the service provider domain",
  relationOf("commercial.settlements", "serviceAreaId"),
  { workspaceId: "service-providers", moduleId: "service-areas" },
)
check(
  "performance's Service area points at the service provider domain",
  relationOf("improve.performance", "serviceAreaId"),
  { workspaceId: "service-providers", moduleId: "service-areas" },
)
check(
  "service-areas' Planning areas stays a deliberate reference to plan geography (issue #12: kept)",
  relationOf("service-providers.service-areas", "zoneIds"),
  { workspaceId: "plan", moduleId: "areas" },
)

/* -------------- service-area fixtures exercise zoneIds (issue #12) -------- */

const planAreaIds = new Set(
  (businessWorkspaces.plan.modules.find((module) => module.id === "areas")
    ?.records ?? []).map((record) => record.id),
)
const serviceAreaRecords =
  businessWorkspaces["service-providers"].modules.find(
    (module) => module.id === "service-areas",
  )?.records ?? []
check(
  "both service-area fixtures reference existing planning areas via zoneIds",
  serviceAreaRecords.map((record) => {
    const zoneRefs = (record.relationRefs ?? []).filter(
      (ref) => ref.fieldId === "zoneIds",
    )
    // The edit form prefills from submittedValues, and facts/refs are
    // re-derived from that string on save — so it must agree with the refs.
    const submittedZoneIds = String(record.submittedValues?.zoneIds ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
    return [
      record.id,
      zoneRefs.length > 0 &&
        zoneRefs.every(
          (ref) =>
            ref.workspaceId === "plan" &&
            ref.moduleId === "areas" &&
            planAreaIds.has(ref.recordId),
        ) &&
        JSON.stringify(submittedZoneIds) ===
          JSON.stringify(zoneRefs.map((ref) => ref.recordId)),
    ]
  }),
  [
    ["service-area-osterbro-2", true],
    ["service-area-amager-1", true],
  ],
)

/* ----------------------------- fixtures (Q14/Q5) --------------------------- */

const schemes =
  businessWorkspaces["route-studio"].modules.find(
    (module) => module.id === "schemes",
  )?.records ?? []
check(
  "both fixture schemes carry structured recurrence and can generate",
  schemes.map((record) => [
    record.id,
    recurrenceFromValues(record.submittedValues ?? {}) !== null,
  ]),
  [
    ["scheme-central-a", true],
    ["scheme-osterbro-b", true],
  ],
)
check(
  "fixture schemes reference the central calendar",
  schemes.every(
    (record) => record.submittedValues?.calendarId === "calendar-central",
  ),
  true,
)

const calendars =
  businessWorkspaces.plan.modules.find((module) => module.id === "calendars")
    ?.records ?? []
const centralCalendar = calendarFromRecord(
  calendars.find((record) => record.id === "calendar-central"),
)
check(
  "the central calendar fixture parses with 11 Danish holidays and Mon–Fri working days",
  [
    centralCalendar?.holidayDates.length,
    centralCalendar?.workingDays,
    centralCalendar?.validFrom,
    centralCalendar?.validTo,
  ],
  [
    11,
    ["monday", "tuesday", "wednesday", "thursday", "friday"],
    "2026-01-01",
    "2026-12-31",
  ],
)
check(
  "the draft harbor calendar parses too (status warnings, not blockers)",
  calendarFromRecord(
    calendars.find((record) => record.id === "calendar-harbor"),
  )?.workingDays,
  ["tuesday", "friday"],
)


/* ------------- container facts renamed off retired terminology ------------ */
// Issue #13 (spec follow-up 3): the container cadence fact is "Service
// frequency" — "Pickup setting" survives only as a read-side legacy
// fallback for pre-rename localStorage records, never in fixtures.

const containerRecords =
  businessWorkspaces.resources.modules.find(
    (module) => module.id === "containers",
  )?.records ?? []
check(
  "no container fixture carries the retired 'Pickup setting' fact key",
  containerRecords.filter((record) => "Pickup setting" in record.facts).length,
  0,
)
check(
  "every container fixture carries a 'Service frequency' fact",
  containerRecords.every((record) => "Service frequency" in record.facts),
  true,
)
check(
  "the container form keeps field id pickupSetting (localStorage compat) under the new label",
  getBusinessFormSchema("resources", "containers")
    ?.sections.flatMap((section) => section.fields)
    .find((field) => field.id === "pickupSetting")?.label,
  "Service frequency",
)
check(
  "no container fixture references the drifted 'Copenhagen 2026' calendar name",
  containerRecords.filter(
    (record) => record.facts["Collection calendar"] === "Copenhagen 2026",
  ).length,
  0,
)
check(
  "Copenhagen containers name the real central calendar record",
  containerRecords.some(
    (record) =>
      record.facts["Collection calendar"] ===
      calendars.find((calendar) => calendar.id === "calendar-central")?.name,
  ),
  true,
)

/* ---------- pickup facts renamed off retired terminology (issue #16) ------- */
// Spec follow-up 7 execution note: Route Studio pickup fixtures predate the
// #13 container rename and carried capital-S "Pickup Setting" facts. The key
// was fixture-only — pickups have no create/edit form (schema mode
// "disabled"), so unlike containers no read-side legacy fallback exists or
// is needed for either casing.

const pickupRecords =
  businessWorkspaces["route-studio"].modules.find(
    (module) => module.id === "pickups",
  )?.records ?? []
check(
  "no pickup fixture carries the retired 'Pickup Setting' fact key (either casing)",
  pickupRecords.filter(
    (record) =>
      "Pickup Setting" in record.facts || "Pickup setting" in record.facts,
  ).length,
  0,
)
check(
  "the 12 collection pickup fixtures carry a 'Service frequency' fact; depot/unloading stops carry none",
  pickupRecords.filter((record) => "Service frequency" in record.facts).length,
  12,
)

/* ------------- typed service-frequency re-sourcing (issue #20) ------------- */
// Spec follow-up 3's deferred half: the cadence promise is a small reusable,
// project-scoped frequency record (lib/data/service-frequencies.ts) in the
// real product's vocabulary. Containers reference it via typed
// submittedValues.serviceFrequencyId with the display fact DERIVED from it;
// agreements carry a typed containerId relation and display the frequency
// they inherit from that container — never a frequency of their own.

check(
  "frequency catalog ids are unique",
  new Set(SERVICE_FREQUENCIES.map((definition) => definition.id)).size,
  SERVICE_FREQUENCIES.length,
)
check(
  "every catalog schemeFrequency is a real scheme cadence or null (label link + monthly rate fallback)",
  SERVICE_FREQUENCIES.every(
    (definition) =>
      definition.schemeFrequency === null ||
      definition.schemeFrequency in RECURRENCE_FREQUENCY_LABELS,
  ),
  true,
)
check(
  "catalog project scoping names only real fixture projects",
  SERVICE_FREQUENCIES.every((definition) =>
    definition.projectIds.every((projectId) =>
      Object.values(FIXTURE_PROJECT_IDS).includes(
        projectId as (typeof FIXTURE_PROJECT_IDS)[keyof typeof FIXTURE_PROJECT_IDS],
      ),
    ),
  ),
  true,
)
check(
  "every legacy container-form option id folds onto an existing definition",
  Object.values(LEGACY_FREQUENCY_OPTION_IDS).every((id) => serviceFrequencyById.has(id)),
  true,
)
check(
  "every serviced container fixture derives its fact from its typed frequency reference",
  containerRecords
    .filter((record) => record.facts["Service frequency"] !== "—")
    .every((record) => {
      const id = record.submittedValues?.serviceFrequencyId
      const definition = typeof id === "string" ? serviceFrequencyById.get(id) : undefined
      return Boolean(definition) && record.facts["Service frequency"] === definition?.name
    }),
  true,
)
check(
  "out-of-service container fixtures promise no cadence (no typed reference, '—' fact)",
  containerRecords
    .filter((record) => record.facts["Service frequency"] === "—")
    .every((record) => record.submittedValues?.serviceFrequencyId === undefined),
  true,
)
check(
  "no container fixture stores a fused pre-#20 frequency string",
  containerRecords.filter((record) =>
    (record.facts["Service frequency"] ?? "").includes(" · "),
  ).length,
  0,
)

const agreementRecords =
  businessWorkspaces.customers.modules.find((module) => module.id === "agreements")
    ?.records ?? []
const containerIdsInFixtures = new Set(containerRecords.map((record) => record.id))
check(
  "both agreement fixtures carry an agreeing typed containerId relation to a real container",
  agreementRecords.map((record) => {
    const refs = (record.relationRefs ?? []).filter((ref) => ref.fieldId === "containerId")
    return [
      record.id,
      refs.length === 1 &&
        refs.every(
          (ref) =>
            ref.workspaceId === "resources" &&
            ref.moduleId === "containers" &&
            containerIdsInFixtures.has(ref.recordId),
        ) &&
        // The edit form prefills from submittedValues, and facts/refs are
        // re-derived from it on save — so it must agree with the ref.
        record.submittedValues?.containerId === refs[0]?.recordId,
    ]
  }),
  [
    ["agreement-2408", true],
    ["agreement-2512", true],
  ],
)
check(
  "each agreement's 'Service frequency' fact is the one its assigned container derives",
  agreementRecords.every((record) => {
    const containerId = record.submittedValues?.containerId
    const container = containerRecords.find((candidate) => candidate.id === containerId)
    return (
      Boolean(container) &&
      record.facts["Service frequency"] === serviceFrequencyOfRecord(container!)?.name
    )
  }),
  true,
)
check(
  "agreements store no frequency of their own — the free-text form field is gone",
  getBusinessFormSchema("customers", "agreements")
    ?.sections.flatMap((section) => section.fields)
    .some((field) => field.id === "serviceFrequency"),
  false,
)
check(
  "the agreement form's assigned-container field is the typed containers relation",
  (() => {
    const field = getBusinessFormSchema("customers", "agreements")
      ?.sections.flatMap((section) => section.fields)
      .find((candidate) => candidate.id === "containerId")
    return field?.relation?.workspaceId === "resources" && field.relation.moduleId === "containers"
  })(),
  true,
)
check(
  "the container form's retained pickupSetting field offers exactly the catalog",
  getBusinessFormSchema("resources", "containers")
    ?.sections.flatMap((section) => section.fields)
    .find((field) => field.id === "pickupSetting")
    ?.options?.map((option) => option.value),
  SERVICE_FREQUENCIES.map((definition) => definition.id),
)
check(
  "the product form carries the typed catalogue-side frequency reference",
  getBusinessFormSchema("commercial", "products")
    ?.sections.flatMap((section) => section.fields)
    .find((field) => field.id === "serviceFrequencyId")
    ?.options?.map((option) => option.value),
  SERVICE_FREQUENCIES.map((definition) => definition.id),
)
check(
  "the exemplar product derives its frequency fact from its typed reference",
  (() => {
    const product = businessWorkspaces.commercial.modules
      .find((module) => module.id === "products")
      ?.records.find((record) => record.id === "product-res-240")
    const id = product?.submittedValues?.serviceFrequencyId
    const definition = typeof id === "string" ? serviceFrequencyById.get(id) : undefined
    return Boolean(definition) && product?.facts["Service frequency"] === definition?.name
  })(),
  true,
)

/* -------- container planning-area links + rule-mode fixture (issue #19) ---- */
// Declarative stop matching resolves containers by planning area: every
// serviceable container fixture carries the typed planningAreaId (mirrored as
// the "Planning area" fact); storage/ended/in-transit units carry none.
// scheme-central-a is the rule-mode fixture and must resolve real containers.

const OUT_OF_SERVICE = new Set(["In storage", "Ended", "In transit"])
check(
  "every serviceable container fixture carries a planningAreaId into plan.areas",
  containerRecords
    .filter((record) => !OUT_OF_SERVICE.has(record.status))
    .every(
      (record) =>
        typeof record.submittedValues?.planningAreaId === "string" &&
        planAreaIds.has(record.submittedValues.planningAreaId) &&
        typeof record.facts["Planning area"] === "string" &&
        record.facts["Planning area"] !== "—",
    ),
  true,
)
check(
  "out-of-service container fixtures carry no planning area",
  containerRecords
    .filter((record) => OUT_OF_SERVICE.has(record.status))
    .every(
      (record) =>
        record.submittedValues?.planningAreaId === undefined &&
        record.facts["Planning area"] === "—",
    ),
  true,
)
check(
  "the harbor planning area exists for the harbor containers",
  planAreaIds.has("area-harbor-1"),
  true,
)
check(
  "the container form links containers to plan.areas",
  relationOf("resources.containers", "planningAreaId"),
  { workspaceId: "plan", moduleId: "areas" },
)

check(
  "scheme-central-a selects stops by rule; scheme-osterbro-b stays manual",
  schemes.map((record) => [
    record.id,
    stopSelectionMode(record.submittedValues),
  ]),
  [
    ["scheme-central-a", "rule"],
    ["scheme-osterbro-b", "manual"],
  ],
)
const centralScheme = schemes.find((record) => record.id === "scheme-central-a")
check(
  "scheme-central-a's rule resolves fixture containers in its planning area",
  centralScheme
    ? effectiveStopPlans(centralScheme, ["monday"], containerRecords)[0]
        .containerIds.length > 0
    : false,
  true,
)
check(
  "the scheme quick-create form carries the stop-matching fields",
  ["stopSelection", "matchFractions", "matchVehicleType"].every((fieldId) =>
    getBusinessFormSchema("route-studio", "schemes")
      ?.sections.flatMap((section) => section.fields)
      .some((field) => field.id === fieldId),
  ),
  true,
)

/* ---------- Settings pane reconciled off retired terminology (issue #14) --- */
// Spec Q18 / follow-up 7: Settings keeps owning configuration *defaults*
// (localStorage "wastehero.settings.v1"); only the naming was reconciled.
// Text-scan, not import: the pane copy lives in a client component.

const settingsDialogSource = readFileSync(
  new URL("../components/settings/SettingsDialog.tsx", import.meta.url),
  "utf8",
)
check(
  "SettingsDialog carries no retired 'pickup setting' / 'collection week' / 'pickup rules' copy",
  [
    /pickup[ -]setting/i.test(settingsDialogSource),
    /collection[ -]week/i.test(settingsDialogSource),
    /pickup[ -]rules/i.test(settingsDialogSource),
  ],
  [false, false, false],
)
check(
  "no Settings control id collides with the retired plan.calendar-days module",
  settingsDialogSource.includes('id: "calendar-days"'),
  false,
)
check(
  "the renamed working-days control keeps a legacy read mapping for saved settings",
  settingsDialogSource.includes('"calendar-days": "calendar-working-days"'),
  true,
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
