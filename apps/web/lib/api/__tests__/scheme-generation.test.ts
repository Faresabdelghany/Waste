// The generation trigger on the adapter (#178, slice 4 of #81): a scheme's
// `generate` is an action, not a command — `POST /route-schemes/:id/generate`
// answers the run it started (202) or the run already queued or running
// (200), never the scheme — so it goes through the store's seam
// `actOnRecord`, which answers what the action answered and leaves the row
// as it is. The window is the body, held against the contracts'
// `GenerationRequest`. The run is then read on its own
// (`GET /generation-runs/:id`) and watched: read again every few seconds
// while it is queued or running and last updated under fifteen minutes ago,
// and no more once it has succeeded or failed, once that age has passed (a
// run whose job died stays open on its row, and its read carries no word of
// the job), or once the page that watched it is gone. When a watched run
// finishes, the scheme is read back (`rereadRecord`), since its `generation`
// reading — the last run, the drift — is the runs'.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { GenerationRequest, GenerationRun as GenerationRunSchema, type GenerationRun } from "@waste/contracts/generation"
import type { RouteScheme } from "@waste/contracts/route-schemes"

import { problemSentence } from "../problem"
import { NOTHING_RESOLVED } from "../records/adapter"
import { generationRunOf, runCounts, runReading, schemeGenerationRuns, watchGenerationRun, withRun, type RunTimer } from "../records/generation"
import { GENERATE_ROUTES, routeSchemeAdapter, routeSchemesModule, type GenerationAnswer } from "../records/route-schemes"
import { actOnRecord, loaded, rereadRecord, type ModuleState } from "../records/server-records"
import { organisationModule, projectAdapter } from "../records/organisation"
import { bodyOf, clientOver, json, problem, scripted, type Call } from "./scripted-fetch"

const NOW = new Date("2026-09-30T12:00:00Z")
const STAMPS = { createdAt: "2026-09-24T09:00:00.000Z", updatedAt: "2026-09-25T09:30:00.000Z" }
const PROJECT_ID = "01a0d2a4-a280-7002-8000-000000000001"
const CENTRAL_ID = "01a0d2a4-a280-701a-8000-000000000001"
const RUN_ID = "01a0d2a4-a280-7030-8000-000000000001"

const central: RouteScheme = {
  id: CENTRAL_ID,
  ...STAMPS,
  projectId: PROJECT_ID,
  name: "RS-Central · Week A",
  planningAreaId: null,
  serviceType: "container-collection",
  frequency: "weekly",
  serviceDays: ["monday", "tuesday", "wednesday", "thursday", "friday"],
  weekRotation: null,
  plannedStartTime: "06:00",
  holidayPolicy: "skip",
  editPolicy: "ask",
  planAhead: true,
  status: "validated",
  depotId: null,
  unloadingStationId: null,
  collectionGroups: [],
  generation: { lastGeneratedAt: null, groups: [] },
  validFrom: "2026-06-01",
  validTo: null,
}

/** A run as `GET /generation-runs/:id` answers it, every member the contract names. */
const runOf = (over: Partial<GenerationRun> = {}): GenerationRun =>
  GenerationRunSchema.parse({
    id: RUN_ID,
    createdAt: "2026-09-30T12:00:01.000Z",
    updatedAt: "2026-09-30T12:00:01.000Z",
    projectId: PROJECT_ID,
    routeSchemeId: CENTRAL_ID,
    trigger: "on-demand",
    windowFrom: "2026-10-01",
    windowTo: "2026-10-07",
    status: "queued",
    startedAt: null,
    finishedAt: null,
    routesCreated: 0,
    routesRefreshed: 0,
    routesCancelled: 0,
    pickupsWritten: 0,
    holidaysSkipped: 0,
    unlocated: 0,
    warnings: [],
    error: null,
    ...over,
  })

const succeeded = runOf({ status: "succeeded", startedAt: "2026-09-30T12:00:20.000Z", finishedAt: "2026-09-30T12:00:22.000Z", routesCreated: 5, pickupsWritten: 39 })
const failed = runOf({ status: "failed", startedAt: "2026-09-30T12:00:20.000Z", finishedAt: "2026-09-30T12:00:21.000Z", error: "Error: the scheme has no planning area to match inside" })

const record = routeSchemeAdapter.toRecord(central, { fixtures: [], resolve: NOTHING_RESOLVED, now: NOW })
const onApi: ModuleState = loaded({ records: [record], serverIds: new Map([[record.id, CENTRAL_ID]]) }, 1)
const options = { fixtures: [], state: new Map([["route-studio.schemes", onApi]]), now: NOW }
const WINDOW = { from: "2026-10-01", to: "2026-10-07" }

const request = (call: Call) => `${call.init.method ?? "GET"} ${call.url.replace("http://api.test", "")}`

async function generate(answers: Array<(call: Call) => Response>, input: Record<string, unknown> = WINDOW, current: ModuleState = onApi, name = GENERATE_ROUTES) {
  const { fetch, calls } = scripted(answers)
  const outcome = await actOnRecord<GenerationAnswer>(clientOver(fetch), routeSchemesModule, current, record, name, input, options)
  return { outcome, calls }
}

describe("a scheme's generate action", () => {
  test("posts the window to the scheme's own generate route, a body the contract accepts, and answers the run the API started", async () => {
    const { outcome, calls } = await generate([() => json(runOf(), 202)])
    assert.deepEqual(calls.map(request), [`POST /route-schemes/${CENTRAL_ID}/generate`])
    assert.deepEqual(GenerationRequest.parse(bodyOf(calls[0])), WINDOW)
    assert.deepEqual(bodyOf(calls[0]), WINDOW, "nothing but the window: the trigger, the status and the scheme are the server's")
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.answer.started, true)
    assert.equal(outcome.answer.run.id, RUN_ID)
    assert.equal(outcome.answer.run.status, "queued")
  })

  test("a 200 is the run already queued or running, which this request did not start: two clicks are one run", async () => {
    const open = runOf({ trigger: "cron", windowFrom: "2026-09-30", windowTo: "2026-10-06" })
    const { outcome } = await generate([() => json(open, 200)])
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.answer.started, false)
    assert.equal(outcome.answer.run.trigger, "cron", "the open run as the API holds it, whatever window it covers")
  })

  test("the API's refusal comes back under the action's heading, in the API's own sentence", async () => {
    const { outcome } = await generate([() => problem(409, "A draft scheme generates nothing; validate it first")])
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.what, "Generation of RS-Central · Week A was not started")
    assert.equal(outcome.recordId, record.id)
    assert.match(problemSentence(outcome.problem), /A draft scheme generates nothing; validate it first/)
  })

  test("a window without its last day is refused at that field before the API sees it", async () => {
    const { outcome, calls } = await generate([], { from: "2026-10-01" })
    assert.equal(calls.length, 0)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.problem.status, 400)
    assert.deepEqual(outcome.problem.errors?.map((error) => error.path), ["to"])
  })

  test("nothing is sent for a scheme the API does not hold yet", async () => {
    const unsaved = loaded({ records: [record], serverIds: new Map() }, 1)
    const { outcome, calls } = await generate([], WINDOW, unsaved)
    assert.equal(calls.length, 0)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.match(problemSentence(outcome.problem), /not on the API yet/)
  })

  test("an action the adapter does not have is refused by its name, and nothing is sent", async () => {
    const { outcome, calls } = await generate([], WINDOW, onApi, "optimise")
    assert.equal(calls.length, 0)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.match(problemSentence(outcome.problem), /"optimise"/)
  })
})

describe("a scheme's runs", () => {
  test("are its first page, newest first, as the API lists them", async () => {
    const { fetch, calls } = scripted([() => json({ items: [succeeded, failed], nextCursor: "older" })])
    const runs = await schemeGenerationRuns(clientOver(fetch), CENTRAL_ID)
    assert.deepEqual(calls.map(request), [`GET /route-schemes/${CENTRAL_ID}/generation-runs?limit=10`])
    assert.deepEqual(
      runs.map((run) => run.status),
      ["succeeded", "failed"],
    )
  })

  test("a run the page learns of goes first when it is new, and takes its own place when the list holds it", () => {
    const older = runOf({ id: "01a0d2a4-a280-7030-8000-0000000000aa", status: "succeeded" })
    const open = runOf()
    assert.deepEqual(
      withRun([older], open).map((run) => run.id),
      [RUN_ID, older.id],
    )
    const listed = [open, older]
    const answered = withRun(listed, runOf({ status: "running" }))
    assert.deepEqual(
      answered.map((run) => `${run.id}:${run.status}`),
      [`${RUN_ID}:running`, `${older.id}:succeeded`],
    )
    assert.equal(listed[0].status, "queued", "the list it was handed is left as it was")
  })

  test("what a run did reads as its counts, leaving out the ones it did not do", () => {
    assert.equal(runCounts(runOf({ status: "succeeded", routesCreated: 5, pickupsWritten: 39 })), "5 routes created · 39 pickups written")
    assert.equal(runCounts(runOf({ status: "succeeded", routesRefreshed: 1, routesCancelled: 2, holidaysSkipped: 2, unlocated: 1 })), "1 route refreshed, 2 cancelled · 2 holidays skipped · 1 container not placed")
    assert.equal(runCounts(runOf({ status: "succeeded" })), "Nothing was planned in the window")
  })

  test("a run is read by its own id", async () => {
    const { fetch, calls } = scripted([() => json(succeeded)])
    const run = await generationRunOf(clientOver(fetch), RUN_ID)
    assert.deepEqual(calls.map(request), [`GET /generation-runs/${RUN_ID}`])
    assert.equal(run.routesCreated, 5)
  })
})

/** The run's last update, and the clock a watch reads, a minute on. */
const UPDATED = Date.parse("2026-09-30T12:00:01.000Z")
const MINUTE = 60_000
const aMinuteOn = () => UPDATED + MINUTE

describe("how the page reads a run it shows", () => {
  const cases: Array<[GenerationRun["status"], number, ReturnType<typeof runReading>]> = [
    ["queued", 1 * MINUTE, "watched"],
    ["running", 15 * MINUTE - 1, "watched"],
    ["queued", 15 * MINUTE, "unreported"],
    ["running", 40 * MINUTE, "unreported"],
    ["succeeded", 1 * MINUTE, "finished"],
    ["failed", 1 * MINUTE, "finished"],
    ["succeeded", 40 * MINUTE, "finished"],
  ]
  for (const [status, age, reading] of cases) {
    test(`a ${status} run last updated ${Math.round(age / 1000)} s ago is ${reading}`, () => {
      assert.equal(runReading(runOf({ status }), UPDATED + age), reading)
    })
  }
})

/** A timer the test fires by hand: what is pending, and how long it asked to wait. */
function handTimer() {
  const pending: Array<{ fire: () => void; ms: number }> = []
  const timer: RunTimer = {
    set: (fire, ms) => {
      const entry = { fire, ms }
      pending.push(entry)
      return entry
    },
    clear: (handle) => {
      const at = pending.indexOf(handle as (typeof pending)[number])
      if (at !== -1) pending.splice(at, 1)
    },
  }
  /** Fires the one pending timer and lets the read it starts settle. */
  const tick = async () => {
    const next = pending.shift()
    assert.ok(next, "a read was due")
    next.fire()
    await new Promise((settle) => setImmediate(settle))
  }
  return { timer, pending, tick }
}

describe("watching a run", () => {
  test("reads it every few seconds while it is queued or running, and stops once it has succeeded", async () => {
    const answers = [runOf(), runOf({ status: "running", startedAt: "2026-09-30T12:00:20.000Z" }), succeeded]
    const reads: string[] = []
    const seen: string[] = []
    const { timer, pending, tick } = handTimer()
    watchGenerationRun(runOf(), {
      read: async (runId) => {
        reads.push(runId)
        return answers.shift() as GenerationRun
      },
      onRun: (run) => seen.push(run.status),
      timer,
      now: aMinuteOn,
    })
    assert.equal(reads.length, 0, "the answered run is shown as it is; the first read waits its interval")
    assert.equal(pending[0]?.ms, 3000)
    await tick()
    await tick()
    await tick()
    assert.deepEqual(seen, ["queued", "running", "succeeded"])
    assert.deepEqual(reads, [RUN_ID, RUN_ID, RUN_ID])
    assert.equal(pending.length, 0, "a run that has succeeded is not read again")
  })

  test("a failed run is as terminal as a succeeded one", async () => {
    const seen: string[] = []
    const { timer, pending, tick } = handTimer()
    watchGenerationRun(runOf({ status: "running" }), { read: async () => failed, onRun: (run) => seen.push(run.status), timer, now: aMinuteOn })
    await tick()
    assert.deepEqual(seen, ["failed"])
    assert.equal(pending.length, 0)
  })

  test("a run that has already finished is not watched at all", () => {
    const { timer, pending } = handTimer()
    watchGenerationRun(succeeded, { read: async () => assert.fail("a finished run is never read"), onRun: () => assert.fail("nothing to tell"), timer, now: aMinuteOn })
    assert.equal(pending.length, 0)
  })

  test("an open run older than fifteen minutes is not watched: the worker has not reported on it", () => {
    const { timer, pending } = handTimer()
    watchGenerationRun(runOf(), { read: async () => assert.fail("never read"), onRun: () => undefined, timer, now: () => UPDATED + 16 * MINUTE })
    assert.equal(pending.length, 0)
  })

  test("the watch ends when the run's age passes fifteen minutes, without reading it again, and says so", async () => {
    let clock = UPDATED + 14 * MINUTE
    const reads: number[] = []
    const unreported: string[] = []
    const { timer, pending, tick } = handTimer()
    watchGenerationRun(runOf(), {
      read: async () => {
        reads.push(clock)
        return runOf()
      },
      onRun: () => undefined,
      onUnreported: (run) => unreported.push(run.id),
      timer,
      now: () => clock,
    })
    await tick()
    assert.equal(reads.length, 1, "still under fifteen minutes: read")
    clock = UPDATED + 15 * MINUTE + 2000
    await tick()
    assert.equal(reads.length, 1, "past fifteen minutes: not read again")
    assert.deepEqual(unreported, [RUN_ID])
    assert.equal(pending.length, 0)
  })

  test("stopping ends the watch: nothing more is read, and an answer already in flight is dropped", async () => {
    const seen: string[] = []
    let answer: (run: GenerationRun) => void = () => undefined
    const { timer, pending } = handTimer()
    const stop = watchGenerationRun(runOf(), {
      read: () =>
        new Promise<GenerationRun>((resolve) => {
          answer = resolve
        }),
      onRun: (run) => seen.push(run.status),
      timer,
      now: aMinuteOn,
    })
    pending.shift()?.fire()
    stop()
    answer(succeeded)
    await new Promise((settle) => setImmediate(settle))
    assert.deepEqual(seen, [], "the page that asked is gone")
    assert.equal(pending.length, 0)
  })

  test("stopping before the first read clears its timer", () => {
    const { timer, pending } = handTimer()
    const stop = watchGenerationRun(runOf(), { read: async () => assert.fail("never read"), onRun: () => undefined, timer, now: aMinuteOn })
    assert.equal(pending.length, 1)
    stop()
    assert.equal(pending.length, 0)
  })

  test("a read the API did not answer is told and tried again; a read it refused ends the watch", async () => {
    const problems: number[] = []
    const seen: string[] = []
    const { fetch } = scripted([() => problem(503, "The database is not answering"), () => json(runOf({ status: "running" })), () => problem(404, `No generation run ${RUN_ID} in the projects this account works in`)])
    const { timer, pending, tick } = handTimer()
    watchGenerationRun(runOf(), {
      read: (runId) => generationRunOf(clientOver(fetch), runId),
      onRun: (run) => seen.push(run.status),
      onProblem: (told) => problems.push(told.status),
      timer,
      now: aMinuteOn,
    })
    await tick()
    assert.deepEqual(problems, [503])
    assert.equal(pending.length, 1, "a 503 is the database's moment, not the run's end")
    await tick()
    assert.deepEqual(seen, ["running"])
    await tick()
    assert.deepEqual(problems, [503, 404])
    assert.equal(pending.length, 0, "a run the API refuses to show is not asked for again")
  })
})

describe("the scheme after its run", () => {
  test("is read back through its own route and replaces the row under the row's web id, its generation reading the server's", async () => {
    const lastGeneratedAt = "2026-09-30T12:00:22.000Z"
    const { fetch, calls } = scripted([() => json({ ...central, generation: { lastGeneratedAt, groups: [] } })])
    const outcome = await rereadRecord(clientOver(fetch), routeSchemesModule, onApi, record, options)
    assert.deepEqual(calls.map(request), [`GET /route-schemes/${CENTRAL_ID}`])
    assert.equal(outcome.kind, "done")
    if (outcome.kind !== "done") return
    assert.equal(outcome.record.id, record.id)
    assert.equal(outcome.serverId, CENTRAL_ID)
    assert.equal(outcome.record.submittedValues?.lastGeneratedAt, lastGeneratedAt)
  })

  test("a read the API refuses leaves the row as it was and hands the problem back", async () => {
    const { fetch } = scripted([() => problem(404, `No route scheme ${CENTRAL_ID} in the projects this account works in`)])
    const outcome = await rereadRecord(clientOver(fetch), routeSchemesModule, onApi, record, options)
    assert.equal(outcome.kind, "refused")
    if (outcome.kind !== "refused") return
    assert.equal(outcome.problem.status, 404)
  })

  test("nothing is read for a row the API does not hold yet, nor for a kind whose adapter reads no single row", async () => {
    const { fetch, calls } = scripted([])
    const unsaved = loaded({ records: [record], serverIds: new Map() }, 1)
    assert.equal((await rereadRecord(clientOver(fetch), routeSchemesModule, unsaved, record, options)).kind, "refused")
    const project = projectAdapter.toRecord(
      { id: PROJECT_ID, ...STAMPS, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active", weekend: ["saturday", "sunday"], holidayList: "Danish public holidays" },
      { fixtures: [], resolve: NOTHING_RESOLVED, now: NOW },
    )
    const organisation = loaded({ records: [project], serverIds: new Map([[project.id, PROJECT_ID]]) }, 1)
    const unread = await rereadRecord(clientOver(fetch), organisationModule, organisation, project, options)
    assert.equal(unread.kind, "refused")
    if (unread.kind === "refused") assert.match(problemSentence(unread.problem), /not read back/)
    assert.equal(calls.length, 0)
  })
})
