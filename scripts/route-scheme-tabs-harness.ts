// Headless checks for the scheme detail Routes/Stops tab seam
// (lib/route-schemes/scheme-tabs.ts): a generated route's waste fractions
// derived live from the Stops still in its plan (never a stamped display
// copy), the render-time projections that expose fractions and the route's
// operating date to the shared filter model, the Stop's container label and
// type, and the filter reader sets each tab's popover and matching share —
// in the order the popover shows them.
// Run: npx tsx scripts/route-scheme-tabs-harness.ts
import type { BusinessRecord } from "../lib/data/business-modules"
import {
  applyBusinessFilters,
  emptyBusinessFilters,
} from "../lib/data/business-filters"
import { staleGenerationPickup } from "../lib/route-schemes/generation"
import {
  SCHEME_ROUTE_FILTER_READERS,
  SCHEME_STOP_FILTER_READERS,
  routeWasteFractions,
  routeWasteFractionsLabel,
  schemeStopContainerLabel,
  schemeStopContainerType,
  withRouteWasteFractions,
  withStopServiceDate,
} from "../lib/route-schemes/scheme-tabs"

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

function route(
  id: string,
  name: string,
  facts: Record<string, string>,
): BusinessRecord {
  return {
    id,
    name,
    context: "Copenhagen Harbor · Nordhavn",
    status: "Planned",
    owner: facts.Driver ?? "Unassigned",
    value: "2 stops",
    updated: "Now",
    description: "Generated route.",
    facts,
    related: [],
    source: "Route scheme Harbor",
    freshness: "Now",
    recordKind: "Route",
  }
}

function pickup(
  id: string,
  facts: Record<string, string>,
  submittedValues?: Record<string, string>,
  name = `Stop ${facts.Stop ?? "1"} · ${facts.Address?.split(",")[0] ?? id}`,
): BusinessRecord {
  return {
    id,
    name,
    context: `${facts.Route ?? "—"} · ${facts["Waste fraction"] ?? "Collection"}`,
    status: "Planned",
    owner: facts.Driver ?? "Unassigned",
    value: "Scheduled",
    updated: "Now",
    description: "Generated stop.",
    facts,
    related: [],
    source: "Route generation",
    freshness: "Now",
    recordKind: "Pickup",
    submittedValues,
  }
}

const wedRoute = route("route-wed", "RC-9001", { Vehicle: "WH-24", Driver: "Mads Jensen" })
const sunRoute = route("route-sun", "RC-9002", { Vehicle: "WH-29", Driver: "Unassigned" })
const fixtureRoute = route("route-legacy", "RC-1042", { Vehicle: "WH-24", Driver: "Mads Jensen" })
const bareRoute = route("route-bare", "RC-0000", { Vehicle: "WH-11", Driver: "Lars Møller" })

const pickups: BusinessRecord[] = [
  pickup(
    "p1",
    {
      Route: "RC-9001",
      Stop: "1",
      Address: "Adelgade 12, 1304 København K",
      "Container ID": "BIN-10432",
      "Container Type": "660 L four-wheel",
      "Waste fraction": "Residual",
      Driver: "Mads Jensen",
    },
    { routeId: "route-wed", schemeId: "scheme-1" },
  ),
  pickup(
    "p2",
    {
      Route: "RC-9001",
      Stop: "2",
      Address: "Borgergade 41, 1300 København K",
      "Container ID": "BIN-10471",
      "Container Type": "400 L two-wheel",
      "Waste fraction": "Organic · Residual",
      Driver: "Mads Jensen",
    },
    { routeId: "route-wed", schemeId: "scheme-1" },
  ),
  pickup(
    "p3",
    {
      Route: "RC-9002",
      Stop: "1",
      "Container ID": "BIN-11305",
      "Container type": "240 L two-wheel",
      "Waste fraction": "Glass",
      Driver: "Unassigned",
    },
    { routeId: "route-sun", schemeId: "scheme-1" },
    "Stop 1 · BIN-11305",
  ),
  // A fixture-era pickup linked by route name only (no structured routeId).
  pickup("p4", {
    Route: "RC-1042",
    Stop: "2",
    Address: "Adelgade 12, 1304 København K",
    "Container ID": "BIN-10432",
    "Container Type": "660 L four-wheel",
    "Waste fraction": "Mixed",
    Driver: "Mads Jensen",
  }),
]

// A Stop regeneration removed from the Wednesday plan: the engine keeps it as
// a Skipped record with its routeId, so only the structured marker tells it
// apart from a Stop skipped in execution.
const removedFromPlan = staleGenerationPickup(
  pickup(
    "p5",
    {
      Route: "RC-9001",
      Stop: "3",
      Address: "Gothersgade 8, 1123 København K",
      "Container ID": "BIN-10499",
      "Container Type": "240 L two-wheel",
      "Waste fraction": "Glass",
      Driver: "Mads Jensen",
    },
    { routeId: "route-wed", schemeId: "scheme-1" },
  ),
  "Container left the day plan",
)!
const skippedInExecution: BusinessRecord = {
  ...pickup(
    "p6",
    {
      Route: "RC-9001",
      Stop: "4",
      Address: "Store Kongensgade 2, 1264 København K",
      "Container ID": "BIN-10502",
      "Container Type": "240 L two-wheel",
      "Waste fraction": "Paper",
      Driver: "Mads Jensen",
    },
    { routeId: "route-wed", schemeId: "scheme-1" },
  ),
  status: "Skipped",
}

/* --------------------------- route waste fractions ------------------------ */

check(
  "fractions are the sorted union of the route's Stops, split on ' · '",
  routeWasteFractions(wedRoute, pickups),
  ["Organic", "Residual"],
)
check(
  "Stops are linked by structured routeId, not by scheme-wide pickups",
  routeWasteFractions(sunRoute, pickups),
  ["Glass"],
)
check(
  "a Stop linked by route name only does not count — routeId is the one link",
  routeWasteFractions(fixtureRoute, pickups),
  [],
)
check("a route with no Stops has no fractions", routeWasteFractions(bareRoute, pickups), [])
check(
  "a Stop a regeneration removed from the plan no longer contributes",
  routeWasteFractions(wedRoute, [...pickups, removedFromPlan]),
  ["Organic", "Residual"],
)
check(
  "a Stop skipped in execution still counts — it was part of the plan",
  routeWasteFractions(wedRoute, [...pickups, skippedInExecution]),
  ["Organic", "Paper", "Residual"],
)

const projected = withRouteWasteFractions(wedRoute, pickups)
check(
  "projection exposes the derived fractions through routeWasteFractionsLabel",
  routeWasteFractionsLabel(projected),
  "Organic · Residual",
)
check("projection keeps the other facts", projected.facts.Vehicle, "WH-24")
check("projection never mutates the stored route", routeWasteFractionsLabel(wedRoute), undefined)
check(
  "projection adds no fact when there are no fractions",
  routeWasteFractionsLabel(withRouteWasteFractions(bareRoute, pickups)),
  undefined,
)

/* ------------------------------ stop projections -------------------------- */

const datedStop = withStopServiceDate(pickups[0], "2026-09-02")
check("service-date projection exposes the route's operating date", datedStop.facts["Service date"], "2026-09-02")
check("service-date projection never mutates the stored Stop", pickups[0].facts["Service date"], undefined)
check(
  "service-date projection without a date returns the Stop unchanged",
  withStopServiceDate(pickups[0], undefined) === pickups[0],
  true,
)

/* --------------------------- stop container label/type -------------------- */

check(
  "container label is the street line of the Stop's address",
  schemeStopContainerLabel(pickups[0]),
  "Adelgade 12",
)
check(
  "without an address the label falls back to the Container ID",
  schemeStopContainerLabel(pickups[2]),
  "BIN-11305",
)
check(
  "container type reads the generated 'Container Type' key",
  schemeStopContainerType(pickups[1]),
  "400 L two-wheel",
)
check(
  "container type falls back to the container-fact 'Container type' key",
  schemeStopContainerType(pickups[2]),
  "240 L two-wheel",
)

/* ------------------------------ filter readers ---------------------------- */

check(
  "Routes tab filters on Waste fraction, Vehicle, Driver — in that order",
  Object.keys(SCHEME_ROUTE_FILTER_READERS),
  ["wasteFractions", "vehicles", "drivers"],
)
check(
  "Stops tab filters on Container, Container ID, Container type, Status, Waste fraction, Driver, Route, Service date — in that order",
  Object.keys(SCHEME_STOP_FILTER_READERS),
  [
    "containers",
    "containerIds",
    "containerTypes",
    "statuses",
    "wasteFractions",
    "drivers",
    "routes",
    "serviceDates",
  ],
)

const projectedRoutes = [wedRoute, sunRoute, bareRoute].map((candidate) =>
  withRouteWasteFractions(candidate, pickups),
)
check(
  "Routes tab: a fraction selection keeps only routes whose Stops serve it",
  applyBusinessFilters(
    projectedRoutes,
    { ...emptyBusinessFilters, wasteFractions: ["Residual"] },
    SCHEME_ROUTE_FILTER_READERS,
  ).map((candidate) => candidate.name),
  ["RC-9001"],
)
check(
  "Routes tab: driver and vehicle selections AND together",
  applyBusinessFilters(
    projectedRoutes,
    { ...emptyBusinessFilters, drivers: ["Mads Jensen", "Lars Møller"], vehicles: ["WH-11"] },
    SCHEME_ROUTE_FILTER_READERS,
  ).map((candidate) => candidate.name),
  ["RC-0000"],
)
check(
  "Stops tab: Container reads the address street line",
  SCHEME_STOP_FILTER_READERS.containers?.(pickups[1]),
  ["Borgergade 41"],
)
check(
  "Stops tab: Container ID and Container type read the Stop facts",
  [
    SCHEME_STOP_FILTER_READERS.containerIds?.(pickups[1]),
    SCHEME_STOP_FILTER_READERS.containerTypes?.(pickups[1]),
  ],
  [["BIN-10471"], ["400 L two-wheel"]],
)
check(
  "Stops tab: a multi-fraction Stop matches either fraction",
  applyBusinessFilters(
    pickups,
    { ...emptyBusinessFilters, wasteFractions: ["Organic"] },
    SCHEME_STOP_FILTER_READERS,
  ).map((candidate) => candidate.id),
  ["p2"],
)
check(
  "Stops tab: Route selection keeps the dated route's Stops (D9)",
  applyBusinessFilters(
    pickups,
    { ...emptyBusinessFilters, routes: ["RC-9002"] },
    SCHEME_STOP_FILTER_READERS,
  ).map((candidate) => candidate.id),
  ["p3"],
)
const datedStops = [
  withStopServiceDate(pickups[0], "2026-09-02"),
  withStopServiceDate(pickups[1], "2026-09-02"),
  withStopServiceDate(pickups[2], "2026-09-06"),
]
check(
  "Stops tab: Service date selection keeps that operating date's Stops (D9)",
  applyBusinessFilters(
    datedStops,
    { ...emptyBusinessFilters, serviceDates: ["2026-09-06"] },
    SCHEME_STOP_FILTER_READERS,
  ).map((candidate) => candidate.id),
  ["p3"],
)
check(
  "Stops tab: search reaches the container id",
  applyBusinessFilters(pickups, emptyBusinessFilters, SCHEME_STOP_FILTER_READERS, "bin-113").map(
    (candidate) => candidate.id,
  ),
  ["p3"],
)

/* --------------------------------- summary ------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
