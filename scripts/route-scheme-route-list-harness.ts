// Headless checks for the scheme detail route list and per-route override
// integrity (spec FR-12–FR-13, ticket #9): generatedAt stamping, the
// scheme-scoped route list helpers, single-route reassignment, override
// survival across a scheme-default change, and cancelled-route visibility.
// Run: npx tsx scripts/route-scheme-route-list-harness.ts
import type { BusinessRecord } from "../lib/data/business-modules"
import {
  applySchemeGeneration,
  generatedRouteId,
  lastGeneratedAt,
  planSchemeGeneration,
  reassignRouteAssignment,
  reassignRoutePickups,
  schemeGeneratedRoutes,
} from "../lib/route-schemes/generation"
import { runPlanAhead } from "../lib/route-schemes/plan-ahead"

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

/* ------------------------------- fixtures -------------------------------- */

// Window Tue 2026-09-01 → Mon 2026-09-07: contains Wed 2026-09-02, Sun 2026-09-06.
const WINDOW = { from: "2026-09-01", to: "2026-09-07" }
const WED = "2026-09-02"
const SUN = "2026-09-06"
const RUN_ONE = "2026-08-28T14:00:00.000Z"
const RUN_TWO = "2026-08-29T09:30:00.000Z"

const scheme: BusinessRecord = {
  id: "schemes-route-scheme-909",
  name: "Harbor Wed+Sun",
  context: "Copenhagen Harbor · Nordhavn",
  status: "Validated",
  owner: "Planner",
  value: "3 planned stops",
  updated: "Now",
  description: "",
  facts: {
    Version: "v2",
    Project: "Copenhagen Harbor",
    "Planning area": "Nordhavn",
    Vehicle: "WH-24",
    Driver: "Mads Jensen",
    "Planned start": "06:30",
  },
  related: [],
  source: "Office workspace",
  freshness: "Now",
  companyId: "company-wastehero",
  projectIds: ["project-harbor"],
  recordKind: "Route Scheme",
  submittedValues: {
    schemeName: "Harbor Wed+Sun",
    frequency: "weekly",
    weekRotation: "",
    serviceDays: "wednesday, sunday",
    effectiveFrom: "2026-08-01",
    effectiveTo: "2026-12-31",
    plannedStartTime: "06:30",
    sameAllDays: false,
    containerIds: "",
    containersByDay: JSON.stringify({
      wednesday: ["cont-a", "cont-b"],
      sunday: ["cont-c"],
    }),
  },
}

const containers: BusinessRecord[] = ["cont-a", "cont-b", "cont-c"].map(
  (id, index) => ({
    id,
    name: `BIN-3000${index + 1}`,
    context: "Container",
    status: "Active",
    owner: "",
    value: "",
    updated: "",
    description: "",
    facts: {
      Address: `Sandkaj ${index + 2}, 2150 Nordhavn`,
      "Container type": "660L container",
      "Waste fractions": "Residual",
    },
    related: [],
    source: "",
    freshness: "",
  }),
)

function generate(input: {
  schemeRecord?: BusinessRecord
  existingRoutes: readonly BusinessRecord[]
  generatedAt?: string
}) {
  const plan = planSchemeGeneration({
    containers: [],
    scheme: input.schemeRecord ?? scheme,
    window: WINDOW,
    existingRoutes: input.existingRoutes,
    deviations: [],
  })
  if (!plan) throw new Error("plan expected")
  return applySchemeGeneration({
    plan,
    existingPickups: [],
    containers,
    actorName: "Planner",
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
  })
}

/* --------------------------- generatedAt stamping ------------------------- */

const firstRun = generate({ existingRoutes: [], generatedAt: RUN_ONE })
check(
  "a run stamps generatedAt on every route it writes",
  firstRun.routes.map((route) => route.submittedValues?.generatedAt),
  [RUN_ONE, RUN_ONE],
)
check(
  "a refresh run restamps generatedAt",
  generate({ existingRoutes: firstRun.routes, generatedAt: RUN_TWO }).routes.map(
    (route) => route.submittedValues?.generatedAt,
  ),
  [RUN_TWO, RUN_TWO],
)
check(
  "a run without a timestamp keeps the refreshed route's prior stamp",
  generate({ existingRoutes: firstRun.routes }).routes.map(
    (route) => route.submittedValues?.generatedAt,
  ),
  [RUN_ONE, RUN_ONE],
)

/* ------------------------- scheme route list (FR-13) ---------------------- */

const foreignRoute: BusinessRecord = {
  ...firstRun.routes[0],
  id: "route-gen-other-scheme-2026-09-02",
  submittedValues: {
    ...firstRun.routes[0].submittedValues,
    schemeId: "schemes-route-scheme-other",
  },
}
const fixtureRoute: BusinessRecord = {
  ...firstRun.routes[0],
  id: "route-rc-1001",
  submittedValues: undefined,
}
check(
  "schemeGeneratedRoutes keeps only this scheme's routes, sorted by service date",
  schemeGeneratedRoutes(scheme.id, [
    firstRun.routes[1],
    foreignRoute,
    fixtureRoute,
    firstRun.routes[0],
  ]).map((route) => route.submittedValues?.serviceDate),
  [WED, SUN],
)
check(
  "lastGeneratedAt is the newest stamp across the scheme's routes",
  lastGeneratedAt([
    firstRun.routes[0],
    { ...firstRun.routes[1], submittedValues: { ...firstRun.routes[1].submittedValues, generatedAt: RUN_TWO } },
  ]),
  RUN_TWO,
)
check("lastGeneratedAt is null when nothing is stamped", lastGeneratedAt([fixtureRoute]), null)

/* -------------------- single-route reassignment (FR-12) ------------------- */

const wedRoute = firstRun.routes.find(
  (route) => route.submittedValues?.serviceDate === WED,
) as BusinessRecord
const reassignedWed = reassignRouteAssignment(wedRoute, {
  driver: "Freja Nielsen",
})
check(
  "reassigning the driver changes that route's driver and owner",
  [reassignedWed.facts.Driver, reassignedWed.owner],
  ["Freja Nielsen", "Freja Nielsen"],
)
check(
  "reassigning the driver leaves the vehicle and applied assignment untouched",
  [
    reassignedWed.facts.Vehicle,
    reassignedWed.submittedValues?.appliedDriver,
    reassignedWed.submittedValues?.appliedVehicle,
  ],
  ["WH-24", "Mads Jensen", "WH-24"],
)
check(
  "reassigning only the vehicle keeps the driver",
  reassignRouteAssignment(wedRoute, { vehicle: "WH-31" }).facts.Driver,
  "Mads Jensen",
)
check(
  "the input route record is not mutated",
  [wedRoute.facts.Driver, wedRoute.owner],
  ["Mads Jensen", "Mads Jensen"],
)

/* --------------- reassignment cascades to the route's pickups ------------- */

const wedPickupsAll = firstRun.pickups.filter(
  (pickup) => pickup.submittedValues?.routeId === wedRoute.id,
)
const completedPickup: BusinessRecord = {
  ...wedPickupsAll[0],
  status: "Completed",
}
const pickupPool = [
  completedPickup,
  ...wedPickupsAll.slice(1),
  ...firstRun.pickups.filter(
    (pickup) => pickup.submittedValues?.routeId !== wedRoute.id,
  ),
]
const cascaded = reassignRoutePickups(wedRoute.id, pickupPool, "Freja Nielsen")
check(
  "only the route's still-open pickups move to the new driver",
  cascaded.map((pickup) => [pickup.facts.Driver, pickup.owner, pickup.status]),
  [["Freja Nielsen", "Freja Nielsen", "Planned"]],
)
check(
  "completed pickups and other routes' pickups are left untouched",
  cascaded.some(
    (pickup) =>
      pickup.id === completedPickup.id ||
      pickup.submittedValues?.routeId !== wedRoute.id,
  ),
  false,
)
check(
  "a vehicle-only reassignment touches no pickups",
  reassignRoutePickups(wedRoute.id, pickupPool, undefined),
  [],
)

/* ------------- override survives a default change + regeneration ---------- */

const sunRoute = firstRun.routes.find(
  (route) => route.submittedValues?.serviceDate === SUN,
) as BusinessRecord
const rescheduledScheme: BusinessRecord = {
  ...scheme,
  facts: { ...scheme.facts, Driver: "Sofie Holm" },
}
const regenerated = generate({
  schemeRecord: rescheduledScheme,
  existingRoutes: [reassignedWed, sunRoute],
  generatedAt: RUN_TWO,
})
check(
  "the overridden route keeps its override after the default changes",
  regenerated.routes.find((route) => route.submittedValues?.serviceDate === WED)
    ?.facts.Driver,
  "Freja Nielsen",
)
check(
  "non-overridden Planned routes pick up the new default",
  regenerated.routes.find((route) => route.submittedValues?.serviceDate === SUN)
    ?.facts.Driver,
  "Sofie Holm",
)
check(
  "both refreshed routes record the new default as the applied assignment",
  regenerated.routes.map((route) => route.submittedValues?.appliedDriver),
  ["Sofie Holm", "Sofie Holm"],
)

/* ------------- cancelled routes stay listed with their reason ------------- */

const wedOnlyScheme: BusinessRecord = {
  ...scheme,
  submittedValues: { ...scheme.submittedValues, serviceDays: "wednesday" },
}
const cancelRun = generate({
  schemeRecord: wedOnlyScheme,
  existingRoutes: firstRun.routes,
  generatedAt: RUN_TWO,
})
const cancelledSun = cancelRun.routes.find((route) => route.status === "Cancelled")
check(
  "a cancel write stamps the run and keeps the reason",
  [cancelledSun?.submittedValues?.generatedAt, cancelledSun?.facts.Deviation],
  [RUN_TWO, "Scheme no longer serves this date"],
)
check(
  "the cancelled route still belongs to the scheme's route list",
  schemeGeneratedRoutes(scheme.id, cancelRun.routes).map((route) => [
    route.submittedValues?.serviceDate,
    route.status,
  ]),
  [
    [WED, "Planned"],
    [SUN, "Cancelled"],
  ],
)

/* ------------------------ plan-ahead passthrough -------------------------- */

const planAheadScheme: BusinessRecord = {
  ...scheme,
  submittedValues: {
    ...scheme.submittedValues,
    planAhead: true,
    // Effective across the run window derived from "today" below.
  },
}
const planAheadRun = runPlanAhead({
  schemes: [planAheadScheme],
  today: "2026-09-01",
  existingRoutes: [],
  existingPickups: [],
  deviationRecords: [],
  containers,
  actorName: "Plan Ahead (Planner)",
  generatedAt: RUN_ONE,
})
check(
  "runPlanAhead stamps generatedAt on the routes it writes",
  planAheadRun.routes.every(
    (route) => route.submittedValues?.generatedAt === RUN_ONE,
  ) && planAheadRun.routes.length > 0,
  true,
)
check(
  "generated route ids stay deterministic through the list helpers",
  schemeGeneratedRoutes(scheme.id, planAheadRun.routes)[0]?.id,
  generatedRouteId(scheme.id, WED),
)

/* --------------------------------- result --------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
