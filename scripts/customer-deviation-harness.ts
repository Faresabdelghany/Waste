// Headless checks for customer-scoped Collection Deviations
// (docs/specs/PLAN_SIMPLIFICATION.md Q8 follow-up 1, issue #10): the portal
// notice derivation (scope + customer matching, status visibility, date
// parsing, ordering) and the Q8 guard that route generation keeps ignoring
// customer scope.
// Run: npx tsx scripts/customer-deviation-harness.ts
import type { BusinessRecord } from "../lib/data/business-modules"
import { businessWorkspaces } from "../lib/data/business-modules"
import { customerDeviationNotices } from "../lib/route-schemes/customer-deviations"
import {
  approvedDeviationsFromRecords,
  deviationMatchesScheme,
} from "../lib/route-schemes/generation"

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

const CUSTOMER = "company-osterbro-housing"

function deviation(
  id: string,
  status: string,
  submittedValues: Record<string, unknown>,
  facts: Record<string, string> = {},
): BusinessRecord {
  return {
    id,
    name: id,
    context: "Harness · deviation",
    status,
    owner: "Harness",
    value: "",
    updated: "Now",
    description: "",
    facts,
    related: [],
    source: "Harness",
    freshness: "Now",
    companyId: "company-wastehero",
    projectIds: ["project-central"],
    recordKind: "Collection deviation",
    submittedValues: submittedValues as BusinessRecord["submittedValues"],
  }
}

const notified = deviation("dev-notified", "Notified", {
  scopeType: "customer",
  customerId: CUSTOMER,
  originalDate: "2026-10-08",
  replacementDate: "2026-10-09",
  deviationReason: "Street repaving",
})
const approved = deviation("dev-approved", "Approved", {
  scopeType: "customer",
  customerId: CUSTOMER,
  originalDate: "2026-09-17",
  replacementDate: "2026-09-18",
  deviationReason: "Gate replacement",
})
const draft = deviation("dev-draft", "Draft", {
  scopeType: "customer",
  customerId: CUSTOMER,
  originalDate: "2026-09-24",
  replacementDate: "2026-09-25",
})
const executed = deviation("dev-executed", "Executed", {
  scopeType: "customer",
  customerId: CUSTOMER,
  originalDate: "2026-08-06",
  replacementDate: "2026-08-07",
})
const otherCustomer = deviation("dev-other-customer", "Notified", {
  scopeType: "customer",
  customerId: "contact-mikkel",
  originalDate: "2026-09-17",
  replacementDate: "2026-09-18",
})
const projectScope = deviation("dev-project", "Notified", {
  scopeType: "project",
  originalDate: "2026-12-24",
  replacementDate: "2026-12-27",
})
const factDates = deviation(
  "dev-fact-dates",
  "Approved",
  { scopeType: "customer", customerId: CUSTOMER },
  {
    "Original date": "5 Nov 2026",
    "Replacement date": "6 Nov 2026",
    Reason: "Harbor bridge closure",
  },
)
// Edits update submittedValues while the fixture Reason fact survives the
// generic facts merge — the submitted value must win.
const bothReason = deviation(
  "dev-both-reason",
  "Approved",
  {
    scopeType: "customer",
    customerId: CUSTOMER,
    originalDate: "2026-12-03",
    replacementDate: "2026-12-04",
    deviationReason: "Updated via edit",
  },
  { Reason: "Stale fixture reason" },
)
const all = [notified, approved, draft, executed, otherCustomer, projectScope, factDates, bothReason]

/* ------------------------------ derivation -------------------------------- */

const notices = customerDeviationNotices(all, CUSTOMER)

check(
  "only Approved/Notified customer-scoped records for the customer, sorted by original date",
  notices.map((notice) => notice.recordId),
  ["dev-approved", "dev-notified", "dev-fact-dates", "dev-both-reason"],
)
check(
  "submittedValues ISO dates read directly",
  notices.find((notice) => notice.recordId === "dev-notified")?.originalDate,
  "2026-10-08",
)
check(
  "facts fallback parses '5 Nov 2026' dates and the Reason fact",
  (({ originalDate, replacementDate, reason }) => ({ originalDate, replacementDate, reason }))(
    notices.find((notice) => notice.recordId === "dev-fact-dates")!,
  ),
  { originalDate: "2026-11-05", replacementDate: "2026-11-06", reason: "Harbor bridge closure" },
)
check(
  "notified flag follows record status",
  notices.map((notice) => [notice.recordId, notice.notified]),
  [["dev-approved", false], ["dev-notified", true], ["dev-fact-dates", false], ["dev-both-reason", false]],
)
check(
  "deviationReason submittedValue used when no Reason fact",
  notices.find((notice) => notice.recordId === "dev-approved")?.reason,
  "Gate replacement",
)
check(
  "deviationReason submittedValue outranks a stale Reason fact",
  notices.find((notice) => notice.recordId === "dev-both-reason")?.reason,
  "Updated via edit",
)
check("another customer sees nothing", customerDeviationNotices(all, "contact-anna"), [])
check("empty customer id sees nothing", customerDeviationNotices(all, ""), [])

/* ---------------------------- shipped fixtures ---------------------------- */

const fixtureDeviations =
  businessWorkspaces.plan.modules.find((module) => module.id === "collection-deviations")
    ?.records ?? []
const fixtureNotices = customerDeviationNotices(fixtureDeviations, CUSTOMER)

check(
  "the shipped access-works fixture surfaces on the Østerbro Housing portal",
  fixtureNotices.map((notice) => [notice.recordId, notice.originalDate, notice.replacementDate, notice.notified]),
  [["deviation-osterbro-access", "2026-09-10", "2026-09-11", true]],
)

/* ------------------------- Q8 generation guard ---------------------------- */

const fixtureSchemes =
  businessWorkspaces["route-studio"].modules.find((module) => module.id === "schemes")
    ?.records ?? []
const accessDeviation = approvedDeviationsFromRecords(fixtureDeviations).find(
  (candidate) => candidate.name === "Østerbro Housing access works",
)

check("the customer fixture still parses as an ApprovedDeviation with customer scope", accessDeviation?.scopeType, "customer")
check(
  "route generation ignores the customer-scoped fixture for every scheme (Q8)",
  fixtureSchemes.map((scheme) =>
    accessDeviation ? deviationMatchesScheme(accessDeviation, scheme) : null,
  ),
  fixtureSchemes.map(() => false),
)

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
