import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../data/business-modules"
import { planSchemeGeneration } from "../generation"
import { holidayListFromDates } from "../holidays"
import { occurrencePreview, type HolidayPolicy } from "../occurrences"
import { REGRESSION_HOLIDAY_DATES, weekdays } from "./holiday-fixture"

const holidays = holidayListFromDates(REGRESSION_HOLIDAY_DATES)

/** A stored Mon–Fri weekly scheme in the legacy single-group manual shape. */
function scheme(holidayPolicy: HolidayPolicy): BusinessRecord {
  return {
    id: "scheme-parity",
    name: "Parity",
    context: "",
    status: "Validated",
    owner: "",
    value: "",
    updated: "Now",
    description: "",
    facts: { Vehicle: "WH-24", Driver: "Mads Jensen" },
    related: [],
    source: "",
    freshness: "Now",
    allowedTransitions: [],
    submittedValues: {
      schemeName: "Parity",
      frequency: weekdays.frequency,
      serviceDays: weekdays.serviceDays.join(", "),
      effectiveFrom: weekdays.effectiveFrom,
      effectiveTo: "",
      holidayPolicy,
      stopSelection: "manual",
      sameAllDays: true,
      containerIds: "container-1",
    },
  }
}

const window = { from: "2026-09-13", to: "2027-09-13" }

describe("generation applies the holiday policy through the shared occurrence generator", () => {
  for (const policy of ["shift-next", "shift-prev", "skip", "collect"] as const) {
    test(`${policy}: generated (serviceDate, actualDate) pairs equal the preview rows`, () => {
      const plan = planSchemeGeneration({
        scheme: scheme(policy),
        window,
        existingRoutes: [],
        containers: [],
        holidays,
      })
      assert.ok(plan)
      const preview = occurrencePreview({ recurrence: weekdays, holidayPolicy: policy, holidays })
      const generated = plan.routes
        .filter((route) => route.action === "create")
        .map((route) => [route.serviceDate, route.actualDate])
        .sort()
      const previewed = preview.rows
        .filter((row) => row.status !== "skipped")
        .map((row) => [row.plannedDate, row.date])
        .sort()
      assert.deepEqual(generated, previewed)
      assert.equal(generated.length, preview.count)
    })
  }

  test("shift-next: 261 routes, 24 and 25 Dec operate on Mon 28 Dec, Easter 2027 on Tue 30 Mar", () => {
    const plan = planSchemeGeneration({
      scheme: scheme("shift-next"),
      window,
      existingRoutes: [],
      containers: [],
      holidays,
    })
    assert.ok(plan)
    const creates = plan.routes.filter((route) => route.action === "create")
    assert.equal(creates.length, 261)
    assert.equal(creates[0].serviceDate, "2026-09-14")
    const on = (serviceDate: string) => creates.find((route) => route.serviceDate === serviceDate)
    assert.equal(on("2026-12-24")?.actualDate, "2026-12-28")
    assert.equal(on("2026-12-25")?.actualDate, "2026-12-28")
    assert.equal(on("2026-12-24")?.holidayNote, "Shifted from Thu 24 Dec · Christmas Eve")
    for (const date of ["2027-03-25", "2027-03-26", "2027-03-29"]) {
      assert.equal(on(date)?.actualDate, "2027-03-30", date)
    }
    assert.equal(plan.routes.filter((route) => route.action === "omit").length, 0)
  })

  test("skip: 9 holiday rows are omitted, 252 routes are created", () => {
    const plan = planSchemeGeneration({
      scheme: scheme("skip"),
      window,
      existingRoutes: [],
      containers: [],
      holidays,
    })
    assert.ok(plan)
    const omitted = plan.routes.filter((route) => route.action === "omit")
    assert.equal(omitted.length, 9)
    assert.equal(omitted[0].note, "Skipped · Christmas Eve")
    assert.equal(plan.routes.filter((route) => route.action === "create").length, 252)
  })

  test("collect: the route stays on the holiday with a note", () => {
    const plan = planSchemeGeneration({
      scheme: scheme("collect"),
      window: { from: "2026-12-21", to: "2026-12-31" },
      existingRoutes: [],
      containers: [],
      holidays,
    })
    assert.ok(plan)
    const eve = plan.routes.find((route) => route.serviceDate === "2026-12-24")
    assert.equal(eve?.action, "create")
    assert.equal(eve?.actualDate, "2026-12-24")
    assert.equal(eve?.holidayNote, "Collects on a holiday · Christmas Eve")
  })

  test("a record without a stored policy skips holidays, as it always did", () => {
    const legacy = scheme("skip")
    delete legacy.submittedValues!.holidayPolicy
    const plan = planSchemeGeneration({
      scheme: legacy,
      window: { from: "2026-12-21", to: "2026-12-31" },
      existingRoutes: [],
      containers: [],
      holidays,
    })
    assert.ok(plan)
    assert.equal(plan.routes.filter((route) => route.action === "omit").length, 3)
  })
})
