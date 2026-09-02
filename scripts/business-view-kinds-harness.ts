// Headless checks for the module view-kind rules (lib/data/business-view-kinds.ts):
// which workspace modules render as the triage queue vs the rich record table,
// the fact columns seeded when a rich module opens, the fact labels offered as
// extra table columns, and which rich modules expose generic row Edit/Delete.
// Pins the 2026-09-03 decision that Tickets render as the rich record table for
// every persona — the operator's /tickets page and the service provider
// workspace share one UI — without gaining generic row actions.
// Run: npx tsx scripts/business-view-kinds-harness.ts
import { businessWorkspaces } from "../lib/data/business-modules"
import {
  QUEUE_MODULE_IDS,
  RICH_MODULE_TABLES,
  collectFactColumnOptions,
  defaultFactColumns,
  moduleOffersRowActions,
  resolveModuleViewKind,
} from "../lib/data/business-view-kinds"

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

/* ------------------------------- view kinds ------------------------------- */

check("tickets render as the rich record table", resolveModuleViewKind("tickets"), "rich")
check("tickets are not a queue module", QUEUE_MODULE_IDS.has("tickets"), false)
check("exceptions keep the triage queue", resolveModuleViewKind("exceptions"), "queue")
check("routes are a rich module", resolveModuleViewKind("routes"), "rich")
check("service provider users are a rich module", resolveModuleViewKind("service-provider-workspace"), "rich")
check("live operations is a standard table", resolveModuleViewKind("live"), "standard")
check("containers are a standard table", resolveModuleViewKind("containers"), "standard")
check("unknown module falls back to standard", resolveModuleViewKind("nope"), "standard")

/* ---------------------------- seeded fact columns -------------------------- */

// Deliberately unlike any real default so a fallback leaking through is visible.
const FALLBACK = ["Fallback column"] as const

check("tickets seed Type / Priority / Team", defaultFactColumns("tickets", FALLBACK), ["Type", "Priority", "Team"])
check("routes seed Vehicle / Driver", defaultFactColumns("routes", FALLBACK), ["Vehicle", "Driver"])
check("schemes seed no fact columns", defaultFactColumns("schemes", FALLBACK), [])
check("non-rich module uses the fallback", defaultFactColumns("exceptions", FALLBACK), ["Fallback column"])
check(
  "seeded defaults are a fresh array, never the registry entry",
  defaultFactColumns("tickets", FALLBACK) !== RICH_MODULE_TABLES.tickets.seededFactColumns,
  true,
)

/* --------------------------- offered fact columns -------------------------- */

const ticketRecords: { facts: Record<string, string> }[] = [
  {
    facts: {
      Type: "Missed collection",
      Priority: "High",
      Subject: "Blocked access",
      "Case description": "Long free text",
      Scope: "Copenhagen Central",
    },
  },
  {
    facts: {
      Priority: "Medium",
      Team: "Dispatch",
      Attachments: "2 files",
      "Attachment references": "a, b",
      "All linked records and content visibility were checked": "Yes",
      "Record kind": "ticket",
    },
  },
]

check(
  "ticket columns: form duplicates, long text and governance facts excluded, deduped in first-seen order",
  collectFactColumnOptions("tickets", ticketRecords),
  ["Type", "Priority", "Team"],
)
check("queue module offers no fact columns", collectFactColumnOptions("exceptions", ticketRecords), [])
check("standard module offers no fact columns", collectFactColumnOptions("live", ticketRecords), [])
check(
  "service provider users table is fixed — no fact columns offered",
  collectFactColumnOptions("service-provider-workspace", [{ facts: { Email: "x", Role: "y" } }]),
  [],
)
check(
  "routes never offer Project / Area (dedicated columns)",
  collectFactColumnOptions("routes", [{ facts: { Project: "P", Area: "A", Vehicle: "V" } }]),
  ["Vehicle"],
)
check(
  "schemes never offer derived Recurrence / Collection calendar / Planning area",
  collectFactColumnOptions("schemes", [
    { facts: { Recurrence: "Weekly", "Collection calendar": "Std", "Planning area": "Ø", Zone: "Z1" } },
  ]),
  ["Zone"],
)
check(
  "governance facts are excluded for every rich module",
  collectFactColumnOptions("vehicles", [
    { facts: { Ownership: "Own", "Execution policy": "x", "Deleted by": "y", "Registry visibility": "z" } },
  ]),
  ["Ownership"],
)
check("empty records offer nothing", collectFactColumnOptions("tickets", []), [])

/* ------------------------------ row actions -------------------------------- */

// Tickets are worked through their lifecycle transitions and details dialog;
// neither persona gets generic row Edit/Delete on them.
check("tickets expose no generic row actions", moduleOffersRowActions("tickets"), false)
check("routes expose row actions", moduleOffersRowActions("routes"), true)
check("vehicles expose row actions", moduleOffersRowActions("vehicles"), true)
check("service provider users expose row actions", moduleOffersRowActions("service-provider-workspace"), true)
check("queue module exposes no row actions", moduleOffersRowActions("exceptions"), false)
check("standard module exposes no row actions", moduleOffersRowActions("live"), false)

/* --------------------------- fixture consistency --------------------------- */

const ticketsModule = businessWorkspaces.operate.modules.find((module) => module.id === "tickets")
check("operate.tickets fixture module exists", Boolean(ticketsModule), true)
if (ticketsModule) {
  const offered = collectFactColumnOptions("tickets", ticketsModule.records)
  for (const column of defaultFactColumns("tickets", FALLBACK)) {
    check(`seeded ticket column "${column}" is offered by the fixture records`, offered.includes(column), true)
  }
  check("fixture tickets never offer Subject as a column", offered.includes("Subject"), false)
}

for (const moduleId of Object.keys(RICH_MODULE_TABLES)) {
  check(`rich registry entry ${moduleId} resolves as rich`, resolveModuleViewKind(moduleId), "rich")
  check(`rich registry entry ${moduleId} is not also a queue`, QUEUE_MODULE_IDS.has(moduleId), false)
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
