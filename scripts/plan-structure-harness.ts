// Headless checks for the simplified Plan structure (spec
// docs/specs/PLAN_SIMPLIFICATION.md, decisions Q11/Q12/Q14/Q16): the Plan
// workspace exposes only Deviations / Calendars / Areas, Route Schemes stays
// in Route Studio, the retired modules are gone everywhere, fixtures carry
// the structured data generation needs, and the contract-area selectors
// point at the contractor domain. Importing the schema registry also
// exercises its import-time integrity gates (domain ↔ schema lockstep and
// relation targets).
// Run: npx tsx scripts/plan-structure-harness.ts
import { publicModuleDomains, publicWorkspaceDomains } from "../lib/data/business-domain"
import {
  businessFormSchemas,
  getBusinessFormSchema,
} from "../lib/data/business-form-schemas"
import { businessWorkspaces } from "../lib/data/business-modules"
import { calendarFromRecord } from "../lib/route-schemes/calendar"
import { approvedDeviationsFromRecords } from "../lib/route-schemes/generation"
import { recurrenceFromValues } from "../lib/route-schemes/recurrence"

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
  "Plan exposes exactly Deviations, Calendars, Areas (Q11)",
  businessWorkspaces.plan.modules.map((module) => module.id),
  ["collection-deviations", "calendars", "areas"],
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
  ["collection-deviations", "calendars", "areas"],
)
check(
  "no module domain entry survives for the retired modules",
  publicModuleDomains.filter((module) =>
    ["pickup-settings", "calendar-days", "collection-weeks"].includes(
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
  "Collection Deviations keeps its create form — the one deviation path",
  [
    getBusinessFormSchema("plan", "collection-deviations")?.mode,
    getBusinessFormSchema("plan", "collection-deviations")?.recordKind,
  ],
  ["create", "Collection deviation"],
)
check(
  "no surviving relation points at a retired module",
  businessFormSchemas
    .flatMap((schema) => schema.sections.flatMap((section) => section.fields))
    .filter((field) =>
      ["pickup-settings", "calendar-days", "collection-weeks"].includes(
        field.relation?.moduleId ?? "",
      ),
    ).length,
  0,
)

/* -------------------- contract-area selectors (Q16) ----------------------- */

const relationOf = (key: string, fieldId: string) =>
  businessFormSchemas
    .find((schema) => schema.key === key)
    ?.sections.flatMap((section) => section.fields)
    .find((field) => field.id === fieldId)?.relation

check(
  "settlements' Contract area points at the contractor domain",
  relationOf("commercial.settlements", "contractAreaId"),
  { workspaceId: "contractors", moduleId: "contract-areas" },
)
check(
  "performance's Contract area points at the contractor domain",
  relationOf("improve.performance", "contractAreaId"),
  { workspaceId: "contractors", moduleId: "contract-areas" },
)
check(
  "contract-areas' Planning areas stays a deliberate reference to plan geography (issue #12: kept)",
  relationOf("contractors.contract-areas", "zoneIds"),
  { workspaceId: "plan", moduleId: "areas" },
)

/* -------------- contract-area fixtures exercise zoneIds (issue #12) -------- */

const planAreaIds = new Set(
  (businessWorkspaces.plan.modules.find((module) => module.id === "areas")
    ?.records ?? []).map((record) => record.id),
)
const contractAreaRecords =
  businessWorkspaces.contractors.modules.find(
    (module) => module.id === "contract-areas",
  )?.records ?? []
check(
  "both contract-area fixtures reference existing planning areas via zoneIds",
  contractAreaRecords.map((record) => {
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
    ["contract-area-osterbro-2", true],
    ["contract-area-amager-1", true],
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

const deviationRecords =
  businessWorkspaces.plan.modules.find(
    (module) => module.id === "collection-deviations",
  )?.records ?? []
check(
  "the three actionable fixture deviations parse with calendar and scope; the draft is excluded",
  approvedDeviationsFromRecords(deviationRecords).map((deviation) => [
    deviation.originalDate,
    deviation.replacementDate,
    deviation.calendarId,
    deviation.scopeType,
  ]),
  [
    ["2026-12-24", "2026-12-27", "calendar-central", "project"],
    ["2026-12-26", "2026-12-28", "calendar-central", "project"],
    ["2026-09-10", "2026-09-11", "calendar-central", "customer"],
  ],
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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
