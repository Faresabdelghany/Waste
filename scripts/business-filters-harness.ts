// Headless checks for the shared filter model (lib/data/business-filters.ts):
// the one BusinessFilters shape every filter popover variant edits, how a
// record is matched against the active selections (AND across categories,
// OR within one), the free-text query semantics, and the chip label map the
// workspace toolbar and the scheme detail tabs both render from.
// Run: npx tsx scripts/business-filters-harness.ts
import type { BusinessRecord } from "../lib/data/business-modules"
import {
  BUSINESS_FILTER_CHIP_LABELS,
  applyBusinessFilters,
  businessFilterChips,
  emptyBusinessFilters,
  filterKeyForChipLabel,
  matchesBusinessFilters,
  matchesBusinessQuery,
  removeBusinessFilterValue,
  singleFilterValue,
  splitFilterValues,
  type BusinessFilterKey,
  type FilterValueReaders,
} from "../lib/data/business-filters"

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

function stop(
  id: string,
  facts: Record<string, string>,
  status = "Planned",
): BusinessRecord {
  return {
    id,
    name: `Stop · ${id}`,
    context: "RC-1 · Residual",
    status,
    owner: facts.Driver ?? "Unassigned",
    value: "Scheduled",
    updated: "Now",
    description: "Generated stop.",
    facts,
    related: ["Route RC-1"],
    source: "Route generation",
    freshness: "Now",
    recordKind: "Pickup",
  }
}

const adelgade = stop("s1", {
  "Container ID": "BIN-10432",
  "Container Type": "660 L four-wheel",
  "Waste fraction": "Residual",
  Driver: "Mads Jensen",
})
const borgergade = stop(
  "s2",
  {
    "Container ID": "BIN-10471",
    "Container Type": "400 L two-wheel",
    "Waste fraction": "Mixed · Organic",
    Driver: "Lars Møller",
  },
  "Completed",
)
const noFacts = stop("s3", {})

const readers: FilterValueReaders = {
  statuses: (record) => [record.status],
  containerIds: (record) => singleFilterValue(record.facts["Container ID"]),
  containerTypes: (record) => singleFilterValue(record.facts["Container Type"]),
  wasteFractions: (record) => splitFilterValues(record.facts["Waste fraction"]),
  drivers: (record) => singleFilterValue(record.facts.Driver),
}

/* ------------------------------ value readers ---------------------------- */

check("singleFilterValue wraps a present value", singleFilterValue("WH-24"), ["WH-24"])
check("singleFilterValue drops the em-dash placeholder", singleFilterValue("—"), [])
check("singleFilterValue drops undefined", singleFilterValue(undefined), [])
check(
  "splitFilterValues splits the ' · ' multi-value convention",
  splitFilterValues("Mixed · Organic"),
  ["Mixed", "Organic"],
)
check("splitFilterValues drops the placeholder", splitFilterValues("—"), [])

/* --------------------------------- matching ------------------------------ */

check(
  "empty filters match every record",
  [adelgade, borgergade, noFacts].map((record) =>
    matchesBusinessFilters(record, emptyBusinessFilters, readers),
  ),
  [true, true, true],
)
check(
  "one selection filters on that category",
  matchesBusinessFilters(
    adelgade,
    { ...emptyBusinessFilters, drivers: ["Lars Møller"] },
    readers,
  ),
  false,
)
check(
  "selections within one category OR together",
  matchesBusinessFilters(
    adelgade,
    { ...emptyBusinessFilters, drivers: ["Lars Møller", "Mads Jensen"] },
    readers,
  ),
  true,
)
check(
  "selections across categories AND together",
  matchesBusinessFilters(
    adelgade,
    {
      ...emptyBusinessFilters,
      drivers: ["Mads Jensen"],
      statuses: ["Completed"],
    },
    readers,
  ),
  false,
)
check(
  "a multi-value fact matches on any of its parts",
  matchesBusinessFilters(
    borgergade,
    { ...emptyBusinessFilters, wasteFractions: ["Organic"] },
    readers,
  ),
  true,
)
check(
  "a record without the fact never matches a selection on it",
  matchesBusinessFilters(
    noFacts,
    { ...emptyBusinessFilters, containerIds: ["BIN-10432"] },
    readers,
  ),
  false,
)
check(
  "a selection on a category the readers do not cover is ignored",
  matchesBusinessFilters(
    noFacts,
    { ...emptyBusinessFilters, vehicles: ["WH-24"] },
    readers,
  ),
  true,
)

/* ---------------------------------- query -------------------------------- */

check("blank query matches", matchesBusinessQuery(noFacts, "   "), true)
check(
  "query matches fact values case-insensitively",
  matchesBusinessQuery(adelgade, "bin-104"),
  true,
)
check(
  "query matches related labels",
  matchesBusinessQuery(adelgade, "route rc-1"),
  true,
)
check("query misses unrelated text", matchesBusinessQuery(adelgade, "harbor"), false)

check(
  "applyBusinessFilters combines selections and query, preserving order",
  applyBusinessFilters(
    [adelgade, borgergade, noFacts],
    { ...emptyBusinessFilters, statuses: ["Planned", "Completed"] },
    readers,
    "bin",
  ).map((record) => record.id),
  ["s1", "s2"],
)

/* ---------------------------------- chips -------------------------------- */

check(
  "every filter key has a chip label",
  (Object.keys(emptyBusinessFilters) as BusinessFilterKey[]).every(
    (key) => typeof BUSINESS_FILTER_CHIP_LABELS[key] === "string",
  ),
  true,
)
check(
  "chip labels are unique so removal by label is unambiguous",
  new Set(Object.values(BUSINESS_FILTER_CHIP_LABELS)).size,
  Object.keys(BUSINESS_FILTER_CHIP_LABELS).length,
)
check(
  "new scheme-tab categories carry their UI labels",
  [
    BUSINESS_FILTER_CHIP_LABELS.drivers,
    BUSINESS_FILTER_CHIP_LABELS.containers,
    BUSINESS_FILTER_CHIP_LABELS.containerIds,
    BUSINESS_FILTER_CHIP_LABELS.routes,
    BUSINESS_FILTER_CHIP_LABELS.serviceDates,
  ],
  ["Driver", "Container", "Container ID", "Route", "Service date"],
)
check(
  "existing workspace chip labels are unchanged",
  [
    BUSINESS_FILTER_CHIP_LABELS.statuses,
    BUSINESS_FILTER_CHIP_LABELS.containerTypes,
    BUSINESS_FILTER_CHIP_LABELS.wasteFractions,
    BUSINESS_FILTER_CHIP_LABELS.reliabilityBands,
    BUSINESS_FILTER_CHIP_LABELS.ticketTypes,
    BUSINESS_FILTER_CHIP_LABELS.teams,
  ],
  ["Status", "Container type", "Waste fraction", "Reliability", "Type", "Assigned team"],
)
check(
  "businessFilterChips lists each active value under its label",
  businessFilterChips({
    ...emptyBusinessFilters,
    statuses: ["Planned"],
    drivers: ["Mads Jensen", "Lars Møller"],
  }),
  [
    { key: "Status", value: "Planned" },
    { key: "Driver", value: "Mads Jensen" },
    { key: "Driver", value: "Lars Møller" },
  ],
)
check("no chips for empty filters", businessFilterChips(emptyBusinessFilters), [])
check(
  "filterKeyForChipLabel round-trips a label",
  filterKeyForChipLabel("Container ID"),
  "containerIds",
)
check(
  "filterKeyForChipLabel ignores non-filter chips",
  filterKeyForChipLabel("Project"),
  undefined,
)
check(
  "removeBusinessFilterValue drops one value and keeps the rest",
  removeBusinessFilterValue(
    { ...emptyBusinessFilters, drivers: ["Mads Jensen", "Lars Møller"] },
    "Driver",
    "Mads Jensen",
  ).drivers,
  ["Lars Møller"],
)
check(
  "removeBusinessFilterValue with an unknown label returns the same filters",
  removeBusinessFilterValue(emptyBusinessFilters, "Project", "Harbor") ===
    emptyBusinessFilters,
  true,
)

/* --------------------------------- summary ------------------------------- */

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
