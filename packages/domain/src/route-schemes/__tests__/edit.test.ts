// The edit policy — "Changes to a running scheme" (issue #38) — through the
// edit-save planner and the engine that honours what it writes: ask asks only
// when there is something to ask about, future regenerates the window and
// releases every one-off hold, single pins the next collection to the edit
// while the scheme keeps its configuration, and every later run leaves a
// pinned route as edited.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { BusinessRecord } from "../../prototype-record"
import {
  SCHEME_EDIT_APPLICATION_OPTIONS,
  SCHEME_INVALID_CANCEL_NOTE,
  editChangesGeneration,
  futureRefreshableRoutes,
  nextCollectionDate,
  planSchemeEditReconciliation,
  schemeAfterOneOff,
  schemeEditPolicy,
  thisCollectionWindow,
} from "../edit"
import {
  THIS_COLLECTION_ONLY_NOTE,
  applySchemeGeneration,
  planSchemeGeneration,
  releaseThisCollectionOnly,
  routeDeviationNote,
  routeEditedForThisCollectionOnly,
  thisCollectionOnlyRoute,
} from "../generation"
import { runPlanAhead } from "../plan-ahead"
import { DEFAULT_WEEKEND } from "../project-calendar"
import { NO_HOLIDAYS, type SchemeCalendar } from "../occurrences"

/* --------------------------------- fixtures -------------------------------- */

const AREA = "area-indreby"
const TODAY = "2026-09-25" // a Friday
const TOMORROW = "2026-09-26"
const GENERATED_AT = "2026-09-20T06:00:00.000Z"
const EDITED_AT = "2026-09-25T09:00:00.000Z"
const NO_CALENDAR: SchemeCalendar = { holidays: NO_HOLIDAYS, weekend: DEFAULT_WEEKEND }

const container = (id: string): BusinessRecord => ({
  id,
  name: id.toUpperCase(),
  context: "",
  status: "Available",
  owner: "",
  value: "",
  updated: "",
  description: "",
  facts: {
    "Waste fractions": "Residual",
    "Container type": "Two-wheel bin · 240 L",
    Address: `${id} Street 1, Copenhagen`,
  },
  related: [],
  source: "",
  freshness: "",
  allowedTransitions: [],
  submittedValues: { planningAreaId: AREA },
})
const containers = [container("c1"), container("c2")]

/** A Scheduled weekly Mon/Wed manual scheme that has generated before; the stored record an edit starts from. */
function scheme(values: Record<string, string | boolean> = {}, facts: Record<string, string> = {}): BusinessRecord {
  return {
    id: "scheme-38",
    name: "RS-38",
    context: "",
    status: "Scheduled",
    owner: "",
    value: "",
    updated: "Now",
    description: "",
    facts: { Vehicle: "WH-24", Driver: "Mads Jensen", ...facts },
    related: [],
    source: "",
    freshness: "Now",
    allowedTransitions: [],
    submittedValues: {
      schemeName: "RS-38",
      planningAreaId: AREA,
      frequency: "weekly",
      serviceDays: "monday, wednesday",
      effectiveFrom: "2026-09-01",
      effectiveTo: "",
      holidayPolicy: "skip",
      plannedVehicleId: "vehicle-wh24",
      plannedDriverId: "driver-mads",
      stopSelection: "manual",
      sameAllDays: true,
      containerIds: "c1, c2",
      planAhead: true,
      lastGeneratedAt: GENERATED_AT,
      editPolicy: "ask",
      ...values,
    },
  }
}

/** The scheme's routes and pickups as its last generation wrote them: Mon 28 Sep, Wed 30 Sep, Mon 5 Oct, Wed 7 Oct. */
function generated(stored: BusinessRecord = scheme()) {
  const plan = planSchemeGeneration({
    scheme: stored,
    window: { from: TOMORROW, to: "2026-10-09" },
    existingRoutes: [],
    containers,
  })
  assert.ok(plan)
  return applySchemeGeneration({
    plan,
    existingPickups: [],
    containers,
    actorName: "Generation",
    generatedAt: GENERATED_AT,
  })
}

const dates = (routes: readonly BusinessRecord[]) =>
  routes.map((route) => route.submittedValues?.serviceDate).sort()

const related = (stored: BusinessRecord, routes: readonly BusinessRecord[], pickups: readonly BusinessRecord[]) => ({
  schemes: [stored],
  existingRoutes: routes,
  existingPickups: pickups,
  containers,
})

/** The record with some stored values changed — the shape the edit dialog hands the planner. */
const edited = (stored: BusinessRecord, values: Record<string, string | boolean>): BusinessRecord => ({
  ...stored,
  submittedValues: { ...stored.submittedValues, ...values },
})

/** An edit of the planned start time — a value generation reads (the routes' Time window). */
const startAt = (stored: BusinessRecord, time: string) => edited(stored, { plannedStartTime: time })

const input = (before: BusinessRecord, after: BusinessRecord) => ({
  before,
  after,
  today: TODAY,
  actorName: "Planner",
  generatedAt: EDITED_AT,
})

/* ------------------------------ the stored policy ------------------------------ */

describe("schemeEditPolicy", () => {
  test("reads the stored choice and asks for a record that predates the field or carries a stray value", () => {
    assert.equal(schemeEditPolicy({ editPolicy: "future" }), "future")
    assert.equal(schemeEditPolicy({ editPolicy: "single" }), "single")
    assert.equal(schemeEditPolicy({ editPolicy: "ask" }), "ask")
    assert.equal(schemeEditPolicy({}), "ask")
    assert.equal(schemeEditPolicy(undefined), "ask")
    assert.equal(schemeEditPolicy({ editPolicy: "always" }), "ask")
    assert.equal(schemeEditPolicy({ editPolicy: true }), "ask")
  })
})

/* ------------------------------ what an edit shapes ------------------------------ */

describe("editChangesGeneration", () => {
  const stored = scheme()

  test("a value generation reads — the start time, a service day, the stops, the effective period — shapes a collection", () => {
    assert.equal(editChangesGeneration(stored, startAt(stored, "08:00")), true)
    assert.equal(editChangesGeneration(stored, edited(stored, { serviceDays: "monday" })), true)
    assert.equal(editChangesGeneration(stored, edited(stored, { effectiveTo: "2026-12-31" })), true)
    assert.equal(editChangesGeneration(stored, edited(stored, { containerIds: "c1" })), true)
    assert.equal(editChangesGeneration(stored, edited(stored, { plannedDriverId: "driver-anna" })), true)
  })

  test("a fact the routes carry — the vehicle, the depot — shapes a collection", () => {
    assert.equal(editChangesGeneration(stored, { ...stored, facts: { ...stored.facts, Vehicle: "WH-25" } }), true)
    assert.equal(
      editChangesGeneration(stored, { ...stored, facts: { ...stored.facts, "Departure depot": "Nord" } }),
      true,
    )
  })

  test("the name, the policy itself and Plan Ahead shape none", () => {
    assert.equal(editChangesGeneration(stored, { ...stored, name: "RS-38 renamed" }), false)
    assert.equal(editChangesGeneration(stored, edited(stored, { editPolicy: "future" })), false)
    assert.equal(editChangesGeneration(stored, edited(stored, { planAhead: false })), false)
  })

  test("an absent value and an empty one are the same value", () => {
    const { plannedStartTime: _absent, ...rest } = { ...stored.submittedValues, plannedStartTime: "" }
    assert.equal(
      editChangesGeneration(
        { ...stored, submittedValues: rest },
        { ...stored, submittedValues: { ...rest, plannedStartTime: "" } },
      ),
      false,
    )
  })

  test("an absent boolean and the value its readers take for it are the same value", () => {
    // sameAllDays is read `!== false` everywhere: a record that never stored
    // it IS same-all-days, so the `true` the groups editor writes is no
    // change — and neither is an absent key against an explicit true.
    const { sameAllDays: _absent, ...rest } = stored.submittedValues ?? {}
    const never = { ...stored, submittedValues: rest }
    assert.equal(editChangesGeneration(never, { ...stored, submittedValues: { ...rest, sameAllDays: true } }), false)
    assert.equal(editChangesGeneration({ ...stored, submittedValues: { ...rest, sameAllDays: true } }, never), false)
    // Only an explicit false is the other value.
    assert.equal(editChangesGeneration(never, { ...stored, submittedValues: { ...rest, sameAllDays: false } }), true)
    assert.equal(editChangesGeneration(stored, edited(stored, { sameAllDays: false })), true)
  })
})

/* ------------------------------ the next collection ------------------------------ */

describe("nextCollectionDate and thisCollectionWindow", () => {
  test("the next collection is the first recurrence date on or after the day asked", () => {
    assert.equal(nextCollectionDate(scheme(), TOMORROW, NO_CALENDAR), "2026-09-28")
    assert.equal(nextCollectionDate(scheme(), "2026-09-28", NO_CALENDAR), "2026-09-28")
    assert.equal(nextCollectionDate(scheme(), "2026-09-29", NO_CALENDAR), "2026-09-30")
  })

  test("a holiday the policy skips is no collection; a shifted one keeps its recurrence date", () => {
    const holiday: SchemeCalendar = { holidays: new Map([["2026-09-28", "Test day"]]), weekend: DEFAULT_WEEKEND }
    assert.equal(nextCollectionDate(scheme(), TOMORROW, holiday), "2026-09-30")
    assert.equal(nextCollectionDate(scheme({ holidayPolicy: "shift-next" }), TOMORROW, holiday), "2026-09-28")
    assert.equal(nextCollectionDate(scheme({ holidayPolicy: "collect" }), TOMORROW, holiday), "2026-09-28")
  })

  test("null past the effective period and for a record without structured recurrence", () => {
    assert.equal(nextCollectionDate(scheme({ effectiveTo: TODAY }), TOMORROW, NO_CALENDAR), null)
    assert.equal(nextCollectionDate(scheme({ frequency: "" }), TOMORROW, NO_CALENDAR), null)
  })

  test("the one-off window runs from tomorrow through the later of the stored and the edited next collection", () => {
    const stored = scheme()
    assert.deepEqual(thisCollectionWindow(TODAY, stored, startAt(stored, "08:00"), NO_CALENDAR), {
      from: TOMORROW,
      to: "2026-09-28",
    })
    // Moved later: cancelled where it was, created where it goes.
    assert.deepEqual(thisCollectionWindow(TODAY, stored, edited(stored, { serviceDays: "wednesday" }), NO_CALENDAR), {
      from: TOMORROW,
      to: "2026-09-30",
    })
    // Moved earlier: the stored date still bounds the window.
    assert.deepEqual(thisCollectionWindow(TODAY, stored, edited(stored, { serviceDays: "saturday" }), NO_CALENDAR), {
      from: TOMORROW,
      to: "2026-09-28",
    })
    assert.equal(
      thisCollectionWindow(TODAY, scheme({ effectiveTo: TODAY }), scheme({ effectiveTo: TODAY }), NO_CALENDAR),
      null,
    )
  })

  test("the one-off window walks each record against its own calendar when given two", () => {
    const holiday: SchemeCalendar = { holidays: new Map([["2026-09-28", "Test day"]]), weekend: DEFAULT_WEEKEND }
    const stored = scheme()
    const same = startAt(stored, "08:00")
    // One calendar for both, as before.
    assert.deepEqual(thisCollectionWindow(TODAY, stored, same, holiday), { from: TOMORROW, to: "2026-09-30" })
    // The stored scheme's Monday is a holiday only on ITS project: its next is Wed 30 Sep, the edit's Mon 28 Sep — the window reaches the later.
    assert.deepEqual(thisCollectionWindow(TODAY, stored, same, { stored: holiday, edited: NO_CALENDAR }), {
      from: TOMORROW,
      to: "2026-09-30",
    })
    assert.deepEqual(thisCollectionWindow(TODAY, stored, same, { stored: NO_CALENDAR, edited: holiday }), {
      from: TOMORROW,
      to: "2026-09-30",
    })
    assert.deepEqual(thisCollectionWindow(TODAY, stored, same, { stored: NO_CALENDAR, edited: NO_CALENDAR }), {
      from: TOMORROW,
      to: "2026-09-28",
    })
  })
})

/* ------------------------- each record against its own project's calendar ------------------------- */

const stub = (id: string, name: string, extra: Partial<BusinessRecord> = {}): BusinessRecord => ({
  id,
  name,
  context: "Project",
  status: "Active",
  owner: "",
  value: "",
  updated: "",
  description: "",
  facts: {},
  related: [],
  source: "",
  freshness: "",
  allowedTransitions: [],
  ...extra,
})

/** Two projects: one with no holiday list, one whose list skips Mon 28 Sep — the scheme's next Monday. */
const PROJECT_CALENDARS = {
  projectRecords: [
    stub("project-open", "Open"),
    stub("project-holiday", "Holiday", { submittedValues: { holidayList: "Test days" } }),
  ],
  calendarRecords: [
    stub("cal-holiday", "Holiday 2026", {
      context: "Collection calendar",
      projectIds: ["project-holiday"],
      submittedValues: { holidayDates: "2026-09-28" },
    }),
  ],
}

describe("edit policy · a scheme moved to another project", () => {
  test("a one-off's window still reaches the stored scheme's next collection, judged by the stored project's calendar", () => {
    // Stored where Mon 28 Sep is skipped, so its next collection is Wed 30
    // Sep; the edit moves it where Monday collects, so the edit's is Mon 28
    // Sep. The window reaches the later of the two — which only the stored
    // project's calendar knows.
    const stored = scheme({ editPolicy: "single", projectId: "project-holiday" })
    const { routes, pickups } = generated(stored)
    const plan = planSchemeEditReconciliation(
      input(stored, edited(stored, { projectId: "project-open" })),
      { ...related(stored, routes, pickups), ...PROJECT_CALENDARS },
    )
    assert.equal(plan.outcome, "single")
    assert.deepEqual(plan.window, { from: TOMORROW, to: "2026-09-30" })
  })

  test("the question's next collection is the stored scheme's Monday, which its own calendar collects on", () => {
    const stored = scheme({ projectId: "project-open" })
    const { routes, pickups } = generated(stored)
    const plan = planSchemeEditReconciliation(
      input(stored, edited(stored, { projectId: "project-holiday" })),
      { ...related(stored, routes, pickups), ...PROJECT_CALENDARS },
    )
    assert.equal(plan.outcome, "ask")
    assert.equal(plan.question?.nextCollectionDate, "2026-09-28")
  })
})

/* ---------------------------------- ask ---------------------------------- */

describe("edit policy · ask", () => {
  test("an edit that shapes a collection, with future routes to reshape, asks and writes nothing", () => {
    const stored = scheme()
    const { routes, pickups } = generated(stored)
    const plan = planSchemeEditReconciliation(input(stored, startAt(stored, "08:00")), related(stored, routes, pickups))
    assert.equal(plan.outcome, "ask")
    assert.deepEqual(plan.routes, [])
    assert.deepEqual(plan.pickups, [])
    assert.equal(plan.window, null)
    assert.equal(plan.summary, null)
    assert.ok(plan.question)
    assert.equal(plan.question.futureRoutes, 4)
    assert.equal(plan.question.nextCollectionDate, "2026-09-28")
    assert.equal(plan.question.options, SCHEME_EDIT_APPLICATION_OPTIONS)
    assert.equal(plan.message, "4 future routes can still follow this edit — choose how it applies.")
    // The scheme comes back validated as a valid save would leave it; the caller saves once the choice is made.
    assert.equal(plan.scheme.status, "Scheduled")
    assert.equal(plan.scheme.submittedValues?.plannedStartTime, "08:00")
  })

  test("the question's next collection is the earlier of the stored and the edited one", () => {
    const stored = scheme()
    const { routes, pickups } = generated(stored)
    const plan = planSchemeEditReconciliation(
      input(stored, edited(stored, { serviceDays: "saturday" })),
      related(stored, routes, pickups),
    )
    assert.equal(plan.outcome, "ask")
    assert.equal(plan.question?.nextCollectionDate, TOMORROW)
  })

  test("an edit that shapes no collection — a rename — saves as D31 always did, without asking", () => {
    const stored = scheme()
    const { routes, pickups } = generated(stored)
    const plan = planSchemeEditReconciliation(
      input(stored, { ...stored, name: "RS-38 renamed" }),
      related(stored, routes, pickups),
    )
    assert.equal(plan.outcome, "reconciled")
    assert.equal(plan.question, undefined)
    // The window is regenerated: the routes carry the new name.
    assert.equal(plan.routes.length, 4)
    for (const route of plan.routes) assert.equal(route.facts["Route scheme"], "RS-38 renamed")
  })

  test("a rename does not release a one-off hold", () => {
    const stored = scheme()
    const { routes, pickups } = generated(stored)
    const held = routes.map((route) =>
      route.submittedValues?.serviceDate === "2026-09-30" ? thisCollectionOnlyRoute(route) : route,
    )
    const plan = planSchemeEditReconciliation(
      input(stored, { ...stored, name: "RS-38 renamed" }),
      related(stored, held, pickups),
    )
    assert.equal(plan.outcome, "reconciled")
    assert.deepEqual(dates(plan.routes), ["2026-09-28", "2026-10-05", "2026-10-07"])
    assert.equal(plan.summary?.skipped, 1)
  })

  test("a scheme with no future route a run may still reshape saves without asking", () => {
    const stored = scheme()
    const { routes, pickups } = generated(stored)
    const ready = routes.map((route) => ({ ...route, status: "Ready" }))
    const plan = planSchemeEditReconciliation(input(stored, startAt(stored, "08:00")), related(stored, ready, pickups))
    assert.equal(plan.outcome, "reconciled")
    assert.equal(plan.question, undefined)
    // Nothing refreshable, nothing written: the Ready routes are operational history.
    assert.deepEqual(plan.routes, [])
  })

  test("a scheme that never generated is not running and saves without asking", () => {
    const validated = { ...scheme({ lastGeneratedAt: "" }), status: "Validated" }
    const plan = planSchemeEditReconciliation(input(validated, startAt(validated, "08:00")), related(validated, [], []))
    assert.equal(plan.outcome, "reconciled")
    assert.equal(plan.question, undefined)
    assert.equal(plan.routes.length, 2, "the edit window's two collections are created")
    assert.equal(plan.scheme.status, "Scheduled")
  })

  test("a Draft whose future planning stopped is not running: the fixing save re-materializes without asking", () => {
    const stored = scheme()
    const { routes, pickups } = generated(stored)
    const broken = planSchemeEditReconciliation(
      input(stored, edited(stored, { containerIds: "" })),
      related(stored, routes, pickups),
    )
    assert.equal(broken.outcome, "draft")
    const cancelled = routes.map((route) => broken.routes.find((written) => written.id === route.id) ?? route)
    const fixed = planSchemeEditReconciliation(
      input(broken.scheme, edited(broken.scheme, { containerIds: "c1, c2" })),
      related(broken.scheme, cancelled, pickups),
    )
    assert.equal(fixed.outcome, "reconciled")
    assert.equal(fixed.question, undefined)
    assert.equal(fixed.routes.length, 4)
    for (const route of fixed.routes) assert.equal(route.status, "Planned")
  })

  test("the answer outranks the stored policy: the caller plans again with apply", () => {
    const stored = scheme()
    const { routes, pickups } = generated(stored)
    const asked = input(stored, startAt(stored, "08:00"))
    assert.equal(planSchemeEditReconciliation({ ...asked, apply: "future" }, related(stored, routes, pickups)).outcome, "reconciled")
    assert.equal(planSchemeEditReconciliation({ ...asked, apply: "single" }, related(stored, routes, pickups)).outcome, "single")
  })

  test("futureRefreshableRoutes counts the scheme's Draft and Planned routes from tomorrow and nothing else", () => {
    const stored = scheme()
    const { routes } = generated(stored)
    const other = { ...routes[0], id: "route-other", submittedValues: { ...routes[0].submittedValues, schemeId: "scheme-other" } }
    const today = { ...routes[1], id: "route-today", submittedValues: { ...routes[1].submittedValues, serviceDate: TODAY } }
    const active = { ...routes[2], status: "Active" }
    const draft = { ...routes[3], status: "Draft" }
    assert.deepEqual(
      futureRefreshableRoutes(stored.id, TODAY, [other, today, active, draft, routes[0]]).map((route) => route.id),
      [draft.id, routes[0].id],
    )
  })
})

/* --------------------------------- future --------------------------------- */

describe("edit policy · future", () => {
  test("saves the scheme as edited and regenerates the whole future window, as D31 always did", () => {
    const stored = scheme({ editPolicy: "future" })
    const { routes, pickups } = generated(stored)
    const plan = planSchemeEditReconciliation(input(stored, startAt(stored, "08:00")), related(stored, routes, pickups))
    assert.equal(plan.outcome, "reconciled")
    assert.equal(plan.question, undefined)
    assert.deepEqual(plan.window, { from: TOMORROW, to: "2026-10-07" })
    assert.deepEqual(dates(plan.routes), ["2026-09-28", "2026-09-30", "2026-10-05", "2026-10-07"])
    for (const route of plan.routes) {
      assert.equal(route.facts["Time window"], "08:00–08:59")
      assert.equal(routeEditedForThisCollectionOnly(route), false)
    }
    assert.equal(plan.scheme.submittedValues?.plannedStartTime, "08:00")
    assert.equal(plan.scheme.submittedValues?.lastGeneratedAt, EDITED_AT)
    assert.equal(plan.message, "Saved — 4 future routes updated to match the edited scheme.")
  })

  test("releases every one-off hold on the scheme: a held route follows the template again", () => {
    const stored = scheme({ editPolicy: "future" })
    const { routes, pickups } = generated(stored)
    const held = routes.map((route) =>
      route.submittedValues?.serviceDate === "2026-09-30" ? thisCollectionOnlyRoute(route) : route,
    )
    const plan = planSchemeEditReconciliation(input(stored, startAt(stored, "08:00")), related(stored, held, pickups))
    assert.equal(plan.outcome, "reconciled")
    const wednesday = plan.routes.find((route) => route.submittedValues?.serviceDate === "2026-09-30")
    assert.ok(wednesday, "the held route is rewritten")
    assert.equal(wednesday.facts["Time window"], "08:00–08:59")
    assert.equal(routeEditedForThisCollectionOnly(wednesday), false)
    assert.equal(routeDeviationNote(wednesday), null)
  })
})

/* --------------------------------- single --------------------------------- */

describe("edit policy · single", () => {
  test("regenerates the next collection from the edit, held, and the scheme keeps its configuration", () => {
    const stored = scheme({ editPolicy: "single" })
    const { routes, pickups } = generated(stored)
    const plan = planSchemeEditReconciliation(input(stored, startAt(stored, "08:00")), related(stored, routes, pickups))
    assert.equal(plan.outcome, "single")
    assert.deepEqual(plan.window, { from: TOMORROW, to: "2026-09-28" })
    assert.deepEqual(dates(plan.routes), ["2026-09-28"])
    const [monday] = plan.routes
    assert.equal(monday.facts["Time window"], "08:00–08:59")
    assert.equal(routeEditedForThisCollectionOnly(monday), true)
    assert.equal(routeDeviationNote(monday), THIS_COLLECTION_ONLY_NOTE)
    assert.equal(
      plan.message,
      "Saved for this collection only — 1 route updated through Mon 28 Sept and left as edited by later runs. The scheme itself is unchanged.",
    )
    // The deviation lives on the route; the scheme's configuration and its generation history stand.
    assert.equal(plan.scheme.submittedValues?.plannedStartTime, undefined)
    assert.equal(plan.scheme.submittedValues?.lastGeneratedAt, GENERATED_AT)
    assert.equal(plan.scheme.status, "Scheduled")
  })

  test("what shapes no collection — the name, Plan Ahead — lands on the scheme even in a one-off save", () => {
    const stored = scheme({ editPolicy: "single" })
    const { routes, pickups } = generated(stored)
    const after = {
      ...startAt(stored, "08:00"),
      name: "RS-38 renamed",
      submittedValues: { ...stored.submittedValues, plannedStartTime: "08:00", planAhead: false },
    }
    const plan = planSchemeEditReconciliation(input(stored, after), related(stored, routes, pickups))
    assert.equal(plan.outcome, "single")
    assert.equal(plan.scheme.name, "RS-38 renamed")
    assert.equal(plan.scheme.submittedValues?.planAhead, false)
    assert.equal(plan.scheme.submittedValues?.plannedStartTime, undefined)
    assert.equal(plan.routes[0].facts["Time window"], "08:00–08:59")
  })

  test("the stored policy decides; the one picked in the same save is an edit that lands for next time", () => {
    // Stored `single`, switched to `future` while the start time changes: the
    // save is a one-off — the scheme cannot be flipped and reshaped whole in
    // one go — and the new policy lands on the scheme for the edit after.
    const stored = scheme({ editPolicy: "single" })
    const { routes, pickups } = generated(stored)
    const plan = planSchemeEditReconciliation(
      input(stored, edited(stored, { plannedStartTime: "08:00", editPolicy: "future" })),
      related(stored, routes, pickups),
    )
    assert.equal(plan.outcome, "single")
    assert.deepEqual(dates(plan.routes), ["2026-09-28"])
    assert.equal(plan.scheme.submittedValues?.editPolicy, "future")
    assert.equal(plan.scheme.submittedValues?.plannedStartTime, undefined)
    // The next shaping edit is then judged by the saved `future`.
    const next = planSchemeEditReconciliation(
      input(plan.scheme, startAt(plan.scheme, "09:00")),
      related(plan.scheme, routes.map((route) => plan.routes.find((written) => written.id === route.id) ?? route), pickups),
    )
    assert.equal(next.outcome, "reconciled")
    assert.equal(next.routes.length, 4)
  })

  test("a scheme stored as ask asks even when the same save switches it off asking", () => {
    const stored = scheme()
    const { routes, pickups } = generated(stored)
    const plan = planSchemeEditReconciliation(
      input(stored, edited(stored, { plannedStartTime: "08:00", editPolicy: "future" })),
      related(stored, routes, pickups),
    )
    assert.equal(plan.outcome, "ask")
    assert.deepEqual(plan.routes, [])
    // The answer saves the edit, the new policy with it.
    const answered = planSchemeEditReconciliation(
      { ...input(stored, edited(stored, { plannedStartTime: "08:00", editPolicy: "future" })), apply: "future" },
      related(stored, routes, pickups),
    )
    assert.equal(answered.outcome, "reconciled")
    assert.equal(answered.scheme.submittedValues?.editPolicy, "future")
  })

  test("a scheme stored as future is reshaped whole even when the same save switches it to single", () => {
    const stored = scheme({ editPolicy: "future" })
    const { routes, pickups } = generated(stored)
    const plan = planSchemeEditReconciliation(
      input(stored, edited(stored, { plannedStartTime: "08:00", editPolicy: "single" })),
      related(stored, routes, pickups),
    )
    assert.equal(plan.outcome, "reconciled")
    assert.equal(plan.routes.length, 4)
    assert.equal(plan.scheme.submittedValues?.editPolicy, "single")
    assert.equal(plan.scheme.submittedValues?.plannedStartTime, "08:00")
  })

  test("a later run — Plan Ahead included — leaves the held route as edited and reshapes the rest from the scheme", () => {
    const stored = scheme({ editPolicy: "single" })
    const { routes, pickups } = generated(stored)
    const oneOff = planSchemeEditReconciliation(input(stored, startAt(stored, "08:00")), related(stored, routes, pickups))
    const afterEdit = routes.map((route) => oneOff.routes.find((written) => written.id === route.id) ?? route)

    const plan = planSchemeGeneration({
      scheme: oneOff.scheme,
      window: { from: TOMORROW, to: "2026-10-09" },
      existingRoutes: afterEdit,
      containers,
    })
    assert.ok(plan)
    const byDate = new Map(plan.routes.map((row) => [row.serviceDate, row]))
    assert.equal(byDate.get("2026-09-28")?.action, "skip")
    assert.equal(byDate.get("2026-09-28")?.note, "Planned — edited for this collection only, left as edited")
    assert.equal(byDate.get("2026-09-30")?.action, "refresh")
    assert.equal(byDate.get("2026-10-05")?.action, "refresh")

    const run = runPlanAhead({
      schemes: [oneOff.scheme],
      today: TODAY,
      existingRoutes: afterEdit,
      existingPickups: pickups,
      containers,
      actorName: "Plan Ahead",
      generatedAt: "2026-09-26T03:00:00.000Z",
    })
    assert.equal(run.routes.some((route) => route.submittedValues?.serviceDate === "2026-09-28"), false, "the held route is not written")
    const wednesday = run.routes.find((route) => route.submittedValues?.serviceDate === "2026-09-30")
    assert.ok(wednesday, "the rest of the window is refreshed")
    assert.equal(wednesday?.facts["Time window"], undefined, "from the scheme's own configuration, not the one-off's")
    assert.equal(run.summary.skipped, 1)
  })

  test("a hold is left alone by a holiday that joins the list and by the unserved-date cleanup", () => {
    const stored = scheme({ editPolicy: "single" })
    const { routes } = generated(stored)
    const held = routes.map((route) =>
      route.submittedValues?.serviceDate === "2026-09-28" ? thisCollectionOnlyRoute(route) : route,
    )
    // Both Mondays become skipped holidays: the unheld one cancels; the held one is left.
    const holiday = planSchemeGeneration({
      scheme: stored,
      window: { from: TOMORROW, to: "2026-10-09" },
      existingRoutes: held,
      containers,
      calendar: { holidays: new Map([["2026-09-28", "Test day"], ["2026-10-05", "Test day"]]), weekend: DEFAULT_WEEKEND },
    })
    assert.ok(holiday)
    assert.equal(holiday.routes.find((row) => row.serviceDate === "2026-09-28")?.action, "skip")
    assert.equal(holiday.routes.find((row) => row.serviceDate === "2026-10-05")?.action, "cancel")
    // Monday leaves the service days: the unheld Monday cancels as no longer served; the held one stays.
    const wednesdays = planSchemeGeneration({
      scheme: edited(stored, { serviceDays: "wednesday" }),
      window: { from: TOMORROW, to: "2026-10-09" },
      existingRoutes: held,
      containers,
    })
    assert.ok(wednesdays)
    assert.equal(wednesdays.routes.some((row) => row.serviceDate === "2026-09-28"), false, "not cancelled, not planned")
    assert.equal(wednesdays.routes.find((row) => row.serviceDate === "2026-10-05")?.action, "cancel")
  })

  test("a held generation-authored cancel is not resurrected", () => {
    const stored = scheme({ editPolicy: "single" })
    const { routes } = generated(stored)
    const cancelled = routes.map((route) =>
      route.submittedValues?.serviceDate === "2026-09-28"
        ? thisCollectionOnlyRoute({
            ...route,
            status: "Cancelled",
            submittedValues: { ...route.submittedValues, cancelledByGeneration: true },
          })
        : route,
    )
    const plan = planSchemeGeneration({
      scheme: stored,
      window: { from: TOMORROW, to: "2026-10-09" },
      existingRoutes: cancelled,
      containers,
    })
    assert.ok(plan)
    const monday = plan.routes.find((row) => row.serviceDate === "2026-09-28")
    assert.equal(monday?.action, "skip")
    assert.equal(monday?.note, "Cancelled — edited for this collection only, left as edited")
  })

  test("a new one-off on a date that already carries one replaces it; other dates' holds stay", () => {
    const stored = scheme({ editPolicy: "single" })
    const { routes, pickups } = generated(stored)
    const first = planSchemeEditReconciliation(input(stored, startAt(stored, "08:00")), related(stored, routes, pickups))
    const afterFirst = routes.map((route) => first.routes.find((written) => written.id === route.id) ?? route)
    // A hold on Wednesday too, from an earlier one-off.
    const withWednesday = afterFirst.map((route) =>
      route.submittedValues?.serviceDate === "2026-09-30" ? thisCollectionOnlyRoute(route) : route,
    )
    const second = planSchemeEditReconciliation(
      input(first.scheme, startAt(first.scheme, "09:00")),
      related(first.scheme, withWednesday, pickups),
    )
    assert.equal(second.outcome, "single")
    assert.deepEqual(dates(second.routes), ["2026-09-28"])
    assert.equal(second.routes[0].facts["Time window"], "09:00–09:59")
    assert.equal(routeEditedForThisCollectionOnly(second.routes[0]), true)
    // Wednesday's hold was not in the window and so was neither released nor written.
    assert.equal(second.routes.some((route) => route.submittedValues?.serviceDate === "2026-09-30"), false)
  })

  test("a collection moved to another day is cancelled where it was and created where it goes, both held", () => {
    const stored = scheme({ editPolicy: "single" })
    const { routes, pickups } = generated(stored)
    const plan = planSchemeEditReconciliation(
      input(stored, edited(stored, { serviceDays: "tuesday, wednesday" })),
      related(stored, routes, pickups),
    )
    assert.equal(plan.outcome, "single")
    assert.deepEqual(plan.window, { from: TOMORROW, to: "2026-09-29" })
    assert.deepEqual(dates(plan.routes), ["2026-09-28", "2026-09-29"])
    const monday = plan.routes.find((route) => route.submittedValues?.serviceDate === "2026-09-28")
    const tuesday = plan.routes.find((route) => route.submittedValues?.serviceDate === "2026-09-29")
    assert.equal(monday?.status, "Cancelled")
    assert.equal(monday?.submittedValues?.cancelledByGeneration, true)
    assert.equal(routeEditedForThisCollectionOnly(monday!), true)
    assert.equal(monday?.facts.Deviation, `Scheme no longer serves this date · ${THIS_COLLECTION_ONLY_NOTE}`)
    assert.equal(tuesday?.status, "Planned")
    assert.equal(routeEditedForThisCollectionOnly(tuesday!), true)
    assert.equal(
      plan.message,
      "Saved for this collection only — 1 route updated, 1 route cancelled through Tue 29 Sept and left as edited by later runs. The scheme itself is unchanged.",
    )
    // The scheme still collects on Mondays; the next run puts neither route back.
    const afterEdit = routes.map((route) => plan.routes.find((written) => written.id === route.id) ?? route)
    const next = planSchemeGeneration({
      scheme: plan.scheme,
      window: { from: TOMORROW, to: "2026-10-09" },
      existingRoutes: [...afterEdit, ...plan.routes.filter((route) => !afterEdit.some((stored) => stored.id === route.id))],
      containers,
    })
    assert.ok(next)
    assert.equal(next?.routes.find((row) => row.serviceDate === "2026-09-28")?.action, "skip")
    assert.equal(next?.routes.some((row) => row.serviceDate === "2026-09-29" && row.action === "cancel"), false)
    assert.equal(plan.scheme.submittedValues?.serviceDays, "monday, wednesday")
  })

  test("a template that plans no upcoming collection pins nothing", () => {
    const ended = scheme({ editPolicy: "single", effectiveTo: TODAY })
    const plan = planSchemeEditReconciliation(input(ended, startAt(ended, "08:00")), related(ended, [], []))
    assert.equal(plan.outcome, "single")
    assert.deepEqual(plan.routes, [])
    assert.equal(plan.window, null)
    assert.equal(
      plan.message,
      "Saved for this collection only — neither the scheme nor the edit plans an upcoming collection, so no route was changed. The scheme itself is unchanged.",
    )
  })

  test("an invalid one-off is refused whole: nothing saved, nothing cancelled", () => {
    const stored = scheme({ editPolicy: "single" })
    const { routes, pickups } = generated(stored)
    const plan = planSchemeEditReconciliation(
      input(stored, edited(stored, { containerIds: "" })),
      related(stored, routes, pickups),
    )
    assert.equal(plan.outcome, "refused")
    assert.equal(plan.scheme, stored)
    assert.deepEqual(plan.routes, [])
    assert.deepEqual(plan.pickups, [])
    assert.ok(plan.validation && plan.validation.issues.length > 0)
    assert.ok(plan.message.startsWith("Not saved — a change for this collection only has to validate, and this one does not: "))
  })

  test("schemeAfterOneOff keeps the stored configuration and takes the name and the non-shaping values", () => {
    const stored = scheme()
    const after = {
      ...startAt(stored, "08:00"),
      name: "Renamed",
      facts: { ...stored.facts, Vehicle: "WH-25" },
      submittedValues: { ...stored.submittedValues, plannedStartTime: "08:00", serviceDays: "friday", editPolicy: "single", planAhead: false },
    }
    const kept = schemeAfterOneOff(stored, after)
    assert.equal(kept.name, "Renamed")
    assert.equal(kept.facts.Vehicle, "WH-24")
    assert.equal(kept.submittedValues?.serviceDays, "monday, wednesday")
    assert.equal(kept.submittedValues?.plannedStartTime, undefined)
    assert.equal(kept.submittedValues?.editPolicy, "single")
    assert.equal(kept.submittedValues?.planAhead, false)
  })

  test("thisCollectionOnlyRoute stacks the deviation after a holiday note; releaseThisCollectionOnly is scoped to the scheme and, with a window, to it", () => {
    const { routes } = generated()
    const shifted: BusinessRecord = {
      ...routes[0],
      facts: { ...routes[0].facts, Deviation: "Shifted from Mon 28 Sep · Test day" },
    }
    assert.equal(
      thisCollectionOnlyRoute(shifted).facts.Deviation,
      `Shifted from Mon 28 Sep · Test day · ${THIS_COLLECTION_ONLY_NOTE}`,
    )
    const held = routes.map(thisCollectionOnlyRoute)
    const other = { ...held[0], id: "route-other", submittedValues: { ...held[0].submittedValues, schemeId: "scheme-other" } }
    const released = releaseThisCollectionOnly("scheme-38", [...held, other])
    assert.equal(released.filter(routeEditedForThisCollectionOnly).length, 1)
    assert.equal(released[released.length - 1], other)
    // One call over the whole list, the window inside: both ends inclusive,
    // routes outside it untouched and the same objects.
    const windowed = releaseThisCollectionOnly("scheme-38", held, { from: "2026-09-30", to: "2026-10-05" })
    assert.deepEqual(
      windowed.filter((route) => !routeEditedForThisCollectionOnly(route)).map((route) => route.submittedValues?.serviceDate).sort(),
      ["2026-09-30", "2026-10-05"],
    )
    assert.equal(windowed[0], held[0], "an unreleased route is the same object")
    assert.equal(windowed[3], held[3])
  })
})

/* ------------------------- the policy is about a valid edit of a running scheme ------------------------- */

describe("edit policy · invalid edits and legacy records", () => {
  test("an invalidating edit under ask or future stops future planning and cancels a held route too", () => {
    for (const editPolicy of ["ask", "future"] as const) {
      const stored = scheme({ editPolicy })
      const { routes, pickups } = generated(stored)
      const held = routes.map((route) =>
        route.submittedValues?.serviceDate === "2026-09-28" ? thisCollectionOnlyRoute(route) : route,
      )
      const plan = planSchemeEditReconciliation(
        input(stored, edited(stored, { containerIds: "" })),
        related(stored, held, pickups),
      )
      assert.equal(plan.outcome, "draft", editPolicy)
      assert.equal(plan.question, undefined)
      assert.equal(plan.scheme.status, "Draft")
      assert.equal(plan.routes.length, 4)
      for (const route of plan.routes) {
        assert.equal(route.status, "Cancelled")
        assert.ok(route.facts.Deviation?.startsWith(SCHEME_INVALID_CANCEL_NOTE))
      }
    }
  })

  test("a record without structured recurrence saves unchanged and asks nothing", () => {
    const legacy: BusinessRecord = { ...scheme(), submittedValues: { editPolicy: "ask" } }
    const plan = planSchemeEditReconciliation(
      { before: legacy, after: { ...legacy, name: "Legacy" }, today: TODAY, actorName: "Planner" },
      related(legacy, [], []),
    )
    assert.equal(plan.outcome, "legacy")
    assert.equal(plan.question, undefined)
  })
})
