// The Driver App's controller (Issue #145): the Command Queue's states and its
// drain over a scripted driver door and fake-indexeddb. A tap persists its
// command at once, `location-pending`, and a fix rides along when one comes
// in time; the queue drains whole, in order, as one batch — on a tap, on
// load, on `online` and every 30 s while anything waits — and every
// successful batch is followed by a re-read, the server being the source of
// truth. `applied` and `replayed` are silent, `rejected` leaves the queue with
// its sentence shown until the next successful read, a batch refused whole
// keeps the queue behind Discard, and a 401 waits for the session.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { IDBFactory } from "fake-indexeddb"

import { openCommandQueue, type QueueEntry } from "../command-queue"
import { createDriverApp, DRAIN_RETRY_MS, type DriverAppOptions } from "../driver-app"
import { driverMe, eventually, fakeDoor, fakeGeolocation, json, NOW, offline, outcomes, pickupId, problem, ROUTE_ID, routeDetail, settle } from "./driver-fixtures"
import { manualTimers } from "./manual-timers"

const WHO = "mads-login"
const DEVICE = "web-test-device"
const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

/** One phone: its database, its door, its position and its clock. */
function phone(overrides: Partial<DriverAppOptions> = {}) {
  const factory = new IDBFactory()
  const door = fakeDoor()
  const position = fakeGeolocation()
  const timers = manualTimers()
  let now = NOW
  const options: DriverAppOptions = {
    openQueue: () => openCommandQueue(factory, { mintDeviceId: () => DEVICE }),
    geolocation: position.geolocation,
    now: () => now,
    timers,
    appVersion: null,
    ...overrides,
  }
  const open = (more: Partial<DriverAppOptions> = {}) => {
    const app = createDriverApp({ ...options, ...more })
    app.setSession({ who: WHO, client: door.client() })
    return app
  }
  return {
    factory,
    door,
    position,
    timers,
    open,
    tick: (ms: number) => {
      now += ms
    },
    /** What the database holds now, as a second page would read it. */
    stored: async () => {
      const queue = await openCommandQueue(factory, { mintDeviceId: () => DEVICE })
      const rows = await queue.list()
      queue.close()
      return rows
    },
    /** Rows written before the page loads, as a previous page left them. */
    seed: async (rows: QueueEntry[]) => {
      const queue = await openCommandQueue(factory, { mintDeviceId: () => DEVICE })
      for (const row of rows) await queue.put(row)
      queue.close()
    },
  }
}

const waiting = (id: string, overrides: Partial<QueueEntry> = {}): QueueEntry => ({
  owner: WHO,
  state: "ready",
  command: { id, kind: "complete-pickup", routeId: ROUTE_ID, occurredAt: new Date(NOW - 60_000).toISOString(), deviceId: DEVICE, body: { pickupId: pickupId(1) } },
  ...overrides,
})

/** A loaded phone on the route screen, both reads answered once and the door ready to read again after every batch. */
async function onRoute(overrides: Partial<DriverAppOptions> = {}) {
  const device = phone(overrides)
  device.door.always("GET /driver/me", () => json(driverMe()))
  device.door.always(`GET /driver/routes/${ROUTE_ID}`, () => json(routeDetail({ status: "active" })))
  const app = device.open()
  app.watchRoute(ROUTE_ID)
  await app.load()
  await eventually(() => assert.equal(app.store.getSnapshot().status, "ready"))
  return { ...device, app }
}

const reads = (door: ReturnType<typeof fakeDoor>) => door.calls.filter((call) => call.method === "GET").map((call) => call.path)

describe("loading", () => {
  test("reads the start screen and sends nothing while the queue is empty", async () => {
    const device = phone()
    device.door.next("GET /driver/me", () => json(driverMe()))
    const app = device.open()
    await app.load()
    await settle()
    const state = app.store.getSnapshot()
    assert.equal(state.status, "ready")
    assert.equal(state.me?.driver.name, "Mads Jensen")
    assert.deepEqual(device.door.batches(), [])
    assert.deepEqual(state.waiting, [])
  })

  test("a login the door refuses says so, and shows no stop", async () => {
    const device = phone()
    device.door.next("GET /driver/me", () => problem(403, "This account is not an active driver's login"))
    const app = device.open()
    await app.load()
    await eventually(() => assert.equal(app.store.getSnapshot().status, "not-a-driver"))
    assert.equal(app.store.getSnapshot().refusal, "This account is not an active driver's login")
    assert.equal(app.store.getSnapshot().me, null)
  })

  test("with no connection there is no stale stop, only the count of what waits and Retry", async () => {
    const device = phone()
    await device.seed([waiting("01950000-0000-7000-8000-00000000c001"), waiting("01950000-0000-7000-8000-00000000c002")])
    device.door.next("GET /driver/me", offline)
    device.door.next("POST /driver/commands", offline)
    const app = device.open()
    await app.load()
    await eventually(() => assert.equal(app.store.getSnapshot().status, "unreachable"))
    assert.equal(app.store.getSnapshot().me, null)
    assert.equal(app.store.getSnapshot().waiting.length, 2)

    device.door.next("GET /driver/me", () => json(driverMe()))
    device.door.next("POST /driver/commands", ({ body }) => outcomes((body as { commands: { id: string }[] }).commands))
    device.door.always("GET /driver/me", () => json(driverMe()))
    await app.retry()
    await eventually(() => {
      assert.equal(app.store.getSnapshot().status, "ready")
      assert.deepEqual(app.store.getSnapshot().waiting, [])
    })
  })
})

describe("a tap", () => {
  test("persists its command at once as location-pending, then sends it with the fix that came in time", async () => {
    const { app, door, position, stored } = await onRoute()
    const id = await app.tap({ kind: "complete-pickup", routeId: ROUTE_ID, body: { pickupId: pickupId(1) } })

    assert.match(id, UUID_V7)
    const [row] = await stored()
    assert.equal(row.state, "location-pending")
    assert.deepEqual(row.command, { id, kind: "complete-pickup", routeId: ROUTE_ID, occurredAt: new Date(NOW).toISOString(), deviceId: DEVICE, body: { pickupId: pickupId(1) } })
    assert.deepEqual(app.store.getSnapshot().waiting.map((entry) => entry.command.id), [id])
    await settle()
    assert.deepEqual(door.batches(), [], "nothing is sent while the lookup may still answer")

    door.next("POST /driver/commands", ({ body }) => outcomes((body as { commands: { id: string }[] }).commands))
    const before = reads(door).length
    position.answer(12)
    await eventually(() => assert.equal(door.batches().length, 1))
    assert.deepEqual(door.batches()[0][0].body, { pickupId: pickupId(1), location: { type: "Point", coordinates: [12.58, 55.7] }, accuracyM: 12 })
    await eventually(async () => {
      assert.deepEqual(app.store.getSnapshot().waiting, [])
      assert.deepEqual(await stored(), [])
    })
    // The server is the source of truth: the batch is followed by a read of what it changed.
    await eventually(() => assert.deepEqual(reads(door).slice(before).sort(), ["/driver/me", `/driver/routes/${ROUTE_ID}`]))
  })

  test("goes without a location when none comes within 3 s", async () => {
    const { app, door, timers } = await onRoute()
    await app.tap({ kind: "skip-pickup", routeId: ROUTE_ID, body: { pickupId: pickupId(2), reason: "not-presented" } })
    door.next("POST /driver/commands", ({ body }) => outcomes((body as { commands: { id: string }[] }).commands))
    timers.advance(3_000)
    await eventually(() => assert.equal(door.batches().length, 1))
    assert.deepEqual(door.batches()[0][0].body, { pickupId: pickupId(2), reason: "not-presented" })
  })

  test("pause and resume carry nothing, ask for no position and go at once", async () => {
    const { app, door, position } = await onRoute()
    door.next("POST /driver/commands", ({ body }) => outcomes((body as { commands: { id: string }[] }).commands))
    await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} })
    await eventually(() => assert.equal(door.batches().length, 1))
    assert.deepEqual(door.batches()[0][0].body, {})
    assert.equal(position.asked.length, 0)
  })

  test("a start carries the web's build identifier where the deployment has one", async () => {
    const { app, door, position } = await onRoute({ appVersion: "4584152" })
    door.next("POST /driver/commands", ({ body }) => outcomes((body as { commands: { id: string }[] }).commands))
    await app.tap({ kind: "start-route", routeId: ROUTE_ID, body: { vehicleId: "01950000-0000-7000-8000-0000000000e1" } })
    position.answer()
    await eventually(() => assert.equal(door.batches().length, 1))
    assert.equal(door.batches()[0][0].body.appVersion, "4584152")
  })

  test("closing the page mid-lookup never loses the action: the next page sends it without a location", async () => {
    const first = await onRoute()
    const id = await first.app.tap({ kind: "fail-pickup", routeId: ROUTE_ID, body: { pickupId: pickupId(3), reason: "inaccessible", note: "Gate locked" } })
    first.app.dispose()

    first.door.next("POST /driver/commands", ({ body }) => outcomes((body as { commands: { id: string }[] }).commands))
    const second = first.open()
    await second.load()
    await eventually(() => assert.equal(first.door.batches().length, 1))
    assert.deepEqual(first.door.batches()[0], [{ id, kind: "fail-pickup", routeId: ROUTE_ID, occurredAt: new Date(NOW).toISOString(), deviceId: DEVICE, body: { pickupId: pickupId(3), reason: "inaccessible", note: "Gate locked" } }])
  })
})

describe("the drain", () => {
  test("sends the whole queue as one batch, in the order of the taps", async () => {
    const { app, door, position } = await onRoute()
    let reachable = false
    door.always("POST /driver/commands", ({ body }) => (reachable ? outcomes((body as { commands: { id: string }[] }).commands) : offline()))
    const ids = [
      await app.tap({ kind: "complete-pickup", routeId: ROUTE_ID, body: { pickupId: pickupId(1) } }),
      await app.tap({ kind: "complete-pickup", routeId: ROUTE_ID, body: { pickupId: pickupId(2) } }),
      await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} }),
    ]
    position.answer()
    position.answer()
    await eventually(() => assert.equal(app.store.getSnapshot().waiting.filter((entry) => entry.state === "ready").length, 3))
    await eventually(() => assert.equal(app.store.getSnapshot().unreachable, true))
    await settle()

    const tried = door.batches().length
    reachable = true
    app.online()
    await eventually(() => assert.deepEqual(app.store.getSnapshot().waiting, []))
    assert.equal(door.batches().length, tried + 1)
    assert.deepEqual(door.batches().at(-1)?.map((command) => command.id), ids)
  })

  test("holds back what comes after a command still waiting for its fix", async () => {
    const { app, door, position } = await onRoute()
    const first = await app.tap({ kind: "complete-pickup", routeId: ROUTE_ID, body: { pickupId: pickupId(1) } })
    const second = await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} })
    await settle()
    assert.deepEqual(door.batches(), [])

    door.next("POST /driver/commands", ({ body }) => outcomes((body as { commands: { id: string }[] }).commands))
    position.answer()
    await eventually(() => assert.equal(door.batches().length, 1))
    assert.deepEqual(door.batches()[0].map((command) => command.id), [first, second])
  })

  test("keeps one batch in flight: a tap meanwhile goes in the next", async () => {
    const { app, door } = await onRoute()
    let release: () => void = () => {}
    door.next("POST /driver/commands", ({ body }) => new Promise<Response>((resolve) => (release = () => resolve(outcomes((body as { commands: { id: string }[] }).commands)))))
    const paused = await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} })
    await eventually(() => assert.equal(door.batches().length, 1))
    const resumed = await app.tap({ kind: "resume", routeId: ROUTE_ID, body: {} })
    await settle()
    assert.equal(door.batches().length, 1)

    door.next("POST /driver/commands", ({ body }) => outcomes((body as { commands: { id: string }[] }).commands))
    release()
    await eventually(() => assert.equal(door.batches().length, 2))
    assert.deepEqual(door.batches().map((batch) => batch.map((command) => command.id)), [[paused], [resumed]])
  })

  test("out of reach, it keeps everything, says so with the count, and tries again every 30 s", async () => {
    const { app, door, timers } = await onRoute()
    door.next("POST /driver/commands", offline)
    await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} })
    await eventually(() => assert.equal(app.store.getSnapshot().unreachable, true))
    assert.equal(app.store.getSnapshot().waiting.length, 1)
    assert.equal(app.store.getSnapshot().me?.driver.name, "Mads Jensen", "the last read stays on screen")
    assert.deepEqual(timers.pending(), [DRAIN_RETRY_MS])
    assert.equal(DRAIN_RETRY_MS, 30_000)

    door.next("POST /driver/commands", ({ body }) => outcomes((body as { commands: { id: string }[] }).commands))
    timers.advance(DRAIN_RETRY_MS)
    await eventually(() => {
      assert.equal(app.store.getSnapshot().unreachable, false)
      assert.deepEqual(app.store.getSnapshot().waiting, [])
    })
    assert.deepEqual(timers.pending(), [], "nothing waits, so nothing is scheduled")
  })

  test("a proxy's 502 is the server out of reach too", async () => {
    const { app, door } = await onRoute()
    door.next("POST /driver/commands", () => problem(502, "Bad Gateway"))
    await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} })
    await eventually(() => assert.equal(app.store.getSnapshot().unreachable, true))
    assert.equal(app.store.getSnapshot().refused, null)
    assert.equal(app.store.getSnapshot().waiting.length, 1)
  })

  test("applied and replayed are silent", async () => {
    const { app, door } = await onRoute()
    door.next("POST /driver/commands", ({ body }) => outcomes((body as { commands: { id: string }[] }).commands, () => ({ outcome: "applied" })))
    door.next("POST /driver/commands", ({ body }) => outcomes((body as { commands: { id: string }[] }).commands, () => ({ outcome: "replayed" })))
    await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} })
    await eventually(() => assert.equal(door.batches().length, 1))
    await app.tap({ kind: "resume", routeId: ROUTE_ID, body: {} })
    await eventually(() => assert.deepEqual(app.store.getSnapshot().waiting, []))
    assert.deepEqual(app.store.getSnapshot().rejections, [])
  })

  test("a rejected command leaves the queue, and its sentence stays on its stop through the batch's re-read until the next successful read", async () => {
    const { app, door, position, stored } = await onRoute()
    door.next("POST /driver/commands", ({ body }) =>
      outcomes((body as { commands: { id: string }[] }).commands, () => ({ outcome: "rejected", problem: { type: "about:blank", title: "Conflict", status: 409, detail: "Pickup 2 is already completed" } })),
    )
    const id = await app.tap({ kind: "complete-pickup", routeId: ROUTE_ID, body: { pickupId: pickupId(2) } })
    position.answer()
    await eventually(async () => {
      assert.deepEqual(await stored(), [])
      assert.deepEqual(app.store.getSnapshot().rejections, [{ commandId: id, kind: "complete-pickup", routeId: ROUTE_ID, pickupId: pickupId(2), sentence: "Pickup 2 is already completed" }])
    })
    const afterBatch = reads(door).length
    await eventually(() => assert.equal(reads(door).length, afterBatch))
    await settle()
    assert.equal(app.store.getSnapshot().rejections.length, 1, "the batch's own re-read leaves it on screen")

    await app.refresh()
    assert.deepEqual(app.store.getSnapshot().rejections, [], "the next successful read clears it")
  })

  test("a rejection can be dismissed", async () => {
    const { app, door } = await onRoute()
    door.next("POST /driver/commands", ({ body }) =>
      outcomes((body as { commands: { id: string }[] }).commands, () => ({ outcome: "rejected", problem: { type: "about:blank", title: "Conflict", status: 409, detail: "Route RC-1042 is not active" } })),
    )
    const id = await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} })
    await eventually(() => assert.equal(app.store.getSnapshot().rejections.length, 1))
    assert.equal(app.store.getSnapshot().rejections[0].pickupId, null, "a route-level command's sentence is the route's")
    app.dismiss(id)
    assert.deepEqual(app.store.getSnapshot().rejections, [])
  })

  for (const [status, detail] of [
    [400, "The request body is invalid"],
    [403, "This account is not an active driver's login"],
  ] as const) {
    test(`a batch refused whole (${status}) keeps the queue, says why, and only Discard empties it`, async () => {
      const { app, door, stored, timers } = await onRoute()
      door.always("POST /driver/commands", () => problem(status, detail))
      await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} })
      await eventually(() => assert.equal(app.store.getSnapshot().refused, detail))
      timers.advance(DRAIN_RETRY_MS)
      await settle()
      assert.equal(app.store.getSnapshot().waiting.length, 1)
      assert.equal((await stored()).length, 1)

      await app.discardWaiting()
      assert.deepEqual(app.store.getSnapshot().waiting, [])
      assert.equal(app.store.getSnapshot().refused, null)
      assert.deepEqual(await stored(), [])
    })
  }

  test("a 401 waits for the session: nothing refused, nothing dropped, and a new token sends it", async () => {
    const { app, door } = await onRoute()
    door.next("POST /driver/commands", () => problem(401, "The token has expired"))
    await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} })
    await eventually(() => assert.equal(door.batches().length, 1))
    await settle()
    assert.equal(app.store.getSnapshot().refused, null)
    assert.equal(app.store.getSnapshot().unreachable, false)
    assert.equal(app.store.getSnapshot().waiting.length, 1)

    door.next("POST /driver/commands", ({ body }) => outcomes((body as { commands: { id: string }[] }).commands))
    app.setSession({ who: WHO, client: door.client("fr35h") })
    await eventually(() => assert.deepEqual(app.store.getSnapshot().waiting, []))
  })

  test("without a usable token nothing is sent, and the queue waits for one", async () => {
    const { app, door } = await onRoute()
    app.setSession({ who: WHO, client: null })
    await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} })
    await settle()
    assert.deepEqual(door.batches(), [])
    assert.equal(app.store.getSnapshot().waiting.length, 1)
  })

  test("sends and counts only the signed-in login's commands", async () => {
    const device = phone()
    await device.seed([waiting("01950000-0000-7000-8000-00000000c001", { owner: "someone-else" }), waiting("01950000-0000-7000-8000-00000000c002")])
    device.door.always("GET /driver/me", () => json(driverMe()))
    device.door.next("POST /driver/commands", ({ body }) => outcomes((body as { commands: { id: string }[] }).commands))
    const app = device.open()
    assert.equal(app.store.getSnapshot().waiting.length, 0)
    await app.load()
    await eventually(() => assert.equal(device.door.batches().length, 1))
    assert.deepEqual(device.door.batches()[0].map((command) => command.id), ["01950000-0000-7000-8000-00000000c002"])
    await eventually(async () => assert.deepEqual((await device.stored()).map((row) => row.owner), ["someone-else"]))
    assert.deepEqual(app.store.getSnapshot().waiting, [])
  })

  test("more than two hundred go as consecutive batches", async () => {
    const device = phone()
    const ids = Array.from({ length: 201 }, (_, index) => `01950000-0000-7000-8000-${String(index).padStart(12, "0")}`)
    await device.seed(ids.map((id) => waiting(id)))
    device.door.always("GET /driver/me", () => json(driverMe()))
    device.door.always("POST /driver/commands", ({ body }) => outcomes((body as { commands: { id: string }[] }).commands))
    const app = device.open()
    await app.load()
    await eventually(() => assert.deepEqual(app.store.getSnapshot().waiting, []))
    assert.deepEqual(device.door.batches().map((batch) => batch.length), [200, 1])
    assert.deepEqual(device.door.batches().flat().map((command) => command.id), ids)
  })
})
