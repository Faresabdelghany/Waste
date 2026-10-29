// The Driver App's controller (Issue #145): the Command Queue's states and its
// drain over a scripted driver door and fake-indexeddb. A tap persists its
// command at once, `location-pending`, and a fix rides along when one comes
// in time; the queue drains whole, in order, as one batch — on a tap, on
// load, on `online` and every 30 s while anything waits — and every
// successful batch is followed by a re-read, the server being the source of
// truth. `applied` and `replayed` are silent, `rejected` leaves the queue with
// its sentence shown until the next successful read, a batch refused whole
// keeps the queue behind Discard, and a 401 waits for the session. A photo's
// or a signature's bytes go to Storage before their command is sent (O1 of
// #290): an object Storage holds already is done, Storage out of reach holds
// the queue, and a refusal of the bytes is the action's rejection.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { NO_PROOF_STORAGE } from "@waste/contracts/problem"
import { IDBFactory } from "fake-indexeddb"

import { PROBLEM_MEDIA_TYPE } from "../../api/problem"
import { openCommandQueue, type QueueEntry } from "../command-queue"
import { createDriverApp, DRAIN_RETRY_MS, REQUEST_TIMEOUT_MS, type DriverAppOptions } from "../driver-app"
import {
  commandsOf,
  DRIVER_ID,
  driverMe,
  eventually,
  fakeDoor,
  fakeGeolocation,
  hang,
  json,
  NOW,
  objectKey,
  offline,
  outcomes,
  pickupId,
  problem,
  PROJECT_ID,
  ROUTE_ID,
  routeDetail,
  settle,
  signedUpload,
  STORAGE_ORIGIN,
  storageError,
  uploadPath,
  VEHICLE_ID,
} from "./driver-fixtures"
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

  test("a route opened while the token had lapsed is read once the refreshed token arrives", async () => {
    const device = phone()
    device.door.always("GET /driver/me", () => json(driverMe()))
    device.door.always(`GET /driver/routes/${ROUTE_ID}`, () => json(routeDetail({ status: "active" })))
    const app = device.open()
    await app.load()
    await eventually(() => assert.equal(app.store.getSnapshot().status, "ready"))
    app.setSession({ who: WHO, client: null })
    app.watchRoute(ROUTE_ID)
    await settle()
    assert.equal(app.store.getSnapshot().routes[ROUTE_ID], undefined)

    app.setSession({ who: WHO, client: device.door.client("fr35h") })
    await eventually(() => assert.equal(app.store.getSnapshot().routes[ROUTE_ID]?.status, "ready"))
  })

  test("a read the door answered 401 is read again under the refreshed token", async () => {
    const device = phone()
    device.door.always("GET /driver/me", () => json(driverMe()))
    device.door.next(`GET /driver/routes/${ROUTE_ID}`, () => problem(401, "The token has expired"))
    device.door.always(`GET /driver/routes/${ROUTE_ID}`, () => json(routeDetail({ status: "active" })))
    const app = device.open()
    app.watchRoute(ROUTE_ID)
    await app.load()
    await eventually(() => assert.equal(app.store.getSnapshot().status, "ready"))
    assert.equal(app.store.getSnapshot().routes[ROUTE_ID], undefined)

    app.setSession({ who: WHO, client: device.door.client("fr35h") })
    await eventually(() => assert.equal(app.store.getSnapshot().routes[ROUTE_ID]?.status, "ready"))
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

  test("an answered command stays on the screen's queue until the route is read again, so nothing is offered twice off the read from before its answer", async () => {
    const { app, door } = await onRoute()
    let release = () => {}
    const reread = new Promise<void>((resolve) => {
      release = resolve
    })
    door.next("POST /driver/commands", ({ body }) => outcomes((body as { commands: { id: string }[] }).commands, () => ({ outcome: "applied" })))
    door.next(`GET /driver/routes/${ROUTE_ID}`, async () => {
      await reread
      return json(routeDetail({ status: "active" }))
    })
    await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} })
    await eventually(() => assert.equal(door.batches().length, 1))
    await settle()
    assert.equal(app.store.getSnapshot().waiting.length, 1, "answered, but the read after it has not landed")
    release()
    await eventually(() => assert.deepEqual(app.store.getSnapshot().waiting, []))
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

  test("a batch the network never answers is given up after its deadline, as the server out of reach, and the next one goes", async () => {
    const { app, door, timers } = await onRoute()
    door.next("POST /driver/commands", hang)
    await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} })
    await eventually(() => assert.equal(door.batches().length, 1))
    timers.advance(REQUEST_TIMEOUT_MS)
    await eventually(() => assert.equal(app.store.getSnapshot().unreachable, true))
    assert.equal(app.store.getSnapshot().waiting.length, 1)

    door.next("POST /driver/commands", ({ body }) => outcomes((body as { commands: { id: string }[] }).commands))
    await app.tap({ kind: "resume", routeId: ROUTE_ID, body: {} })
    await eventually(() => assert.deepEqual(app.store.getSnapshot().waiting, []), 2_000)
    assert.equal(door.batches().length, 2)
  })

  test("a batch answered after the phone changed hands tells the new person nothing of the last one's, and still leaves the queue", async () => {
    const { app, door, stored } = await onRoute()
    let release: () => void = () => {}
    door.next("POST /driver/commands", ({ body }) =>
      new Promise<Response>((resolve) => {
        release = () => resolve(outcomes((body as { commands: { id: string }[] }).commands, () => ({ outcome: "rejected", problem: { type: "about:blank", title: "Conflict", status: 409, detail: "Route RC-1042 is not active" } })))
      }),
    )
    await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} })
    await eventually(() => assert.equal(door.batches().length, 1))
    app.setSession({ who: "the-next-driver", client: door.client("n3xt") })
    let told = false
    app.store.subscribe(() => {
      if (app.store.getSnapshot().rejections.length > 0) told = true
    })
    release()
    await eventually(async () => assert.deepEqual(await stored(), []))
    await settle()
    assert.equal(told, false, "no state the next driver sees ever carried the last one's rejection")
  })

  test("a rejection outlives the next batch of the same drain, and the next read after it clears it", async () => {
    const { app, door } = await onRoute()
    let release: () => void = () => {}
    door.next("POST /driver/commands", ({ body }) =>
      new Promise<Response>((resolve) => {
        release = () => resolve(outcomes((body as { commands: { id: string }[] }).commands, () => ({ outcome: "rejected", problem: { type: "about:blank", title: "Conflict", status: 409, detail: "Route RC-1042 is not active" } })))
      }),
    )
    door.next("POST /driver/commands", ({ body }) => outcomes((body as { commands: { id: string }[] }).commands))
    const paused = await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} })
    await eventually(() => assert.equal(door.batches().length, 1))
    await app.tap({ kind: "resume", routeId: ROUTE_ID, body: {} })
    release()
    await eventually(() => {
      assert.equal(door.batches().length, 2)
      assert.deepEqual(app.store.getSnapshot().waiting, [])
    })
    await settle()
    assert.deepEqual(app.store.getSnapshot().rejections.map((rejection) => rejection.commandId), [paused])

    await app.refresh()
    assert.deepEqual(app.store.getSnapshot().rejections, [])
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
    // Polled by its length: a deep-equal against two hundred waiting rows builds a diff of all of them on every miss, which starves the drain it waits on.
    await eventually(() => assert.equal(app.store.getSnapshot().waiting.length, 0), 10_000)
    assert.deepEqual(device.door.batches().map((batch) => batch.length), [200, 1])
    assert.deepEqual(device.door.batches().flat().map((command) => command.id), ids)
  })
})

describe("a photo or a signature", () => {
  const photo = () => ({ extension: "jpg", contentType: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x4a]).buffer }) as const
  const signature = () => ({ extension: "png", contentType: "image/png", bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).buffer }) as const
  const stored = (key: string) => () => json({ Key: `proofs/${key}` })
  /** Storage's answer to a key it holds already: a 400, the duplicate told by the body's code. */
  const duplicate = () => json({ statusCode: "409", error: "Duplicate", message: "The resource already exists", code: "KeyAlreadyExists" }, 400)
  const NO_STORAGE = "Photos and signatures are not stored on this deployment: it holds no Storage key"
  const noProofStorage = () =>
    new Response(JSON.stringify({ type: NO_PROOF_STORAGE.type, title: NO_PROOF_STORAGE.title, status: 503, detail: NO_STORAGE }), { status: 503, headers: { "content-type": PROBLEM_MEDIA_TYPE } })
  /** What the phone asked of anything but the two reads, in order. */
  const asked = (door: ReturnType<typeof fakeDoor>) => door.calls.filter((call) => call.method !== "GET")
  const puts = (door: ReturnType<typeof fakeDoor>) => door.calls.filter((call) => call.method === "PUT")

  test("is put to Storage before its command is sent — straight from the phone, with no token of the API's — and the command names the key the API named", async () => {
    const { app, door, position } = await onRoute()
    door.next("POST /driver/uploads", signedUpload)
    door.next("POST /driver/commands", ({ body }) => outcomes(commandsOf(body)))
    const id = await app.tap({ kind: "add-photo", routeId: ROUTE_ID, body: { pickupId: pickupId(1) }, object: photo() })
    door.next(`PUT ${uploadPath(id, "jpg")}`, stored(objectKey(id, "jpg")))
    position.answer()
    await eventually(() => assert.deepEqual(app.store.getSnapshot().waiting, []))

    assert.deepEqual(asked(door).map((call) => `${call.method} ${call.path}`), ["POST /driver/uploads", `PUT ${uploadPath(id, "jpg")}`, "POST /driver/commands"])
    const [upload, put] = asked(door)
    assert.deepEqual(upload.body, { routeId: ROUTE_ID, commandId: id, extension: "jpg" })
    assert.equal(put.origin, STORAGE_ORIGIN)
    assert.deepEqual(new Uint8Array(put.raw as ArrayBuffer), new Uint8Array(photo().bytes))
    assert.equal(put.headers.get("content-type"), "image/jpeg")
    assert.equal(put.headers.get("authorization"), null, "the signed URL is the permission; the API's token never goes to Storage")
    const [sent] = door.batches()[0]
    assert.equal(sent.kind, "add-photo")
    assert.deepEqual(sent.body, { pickupId: pickupId(1), objectKey: objectKey(id, "jpg"), location: { type: "Point", coordinates: [12.58, 55.7] }, accuracyM: 8 })
    assert.deepEqual(app.store.getSnapshot().rejections, [])
  })

  test("an object Storage holds already is done: the API's `uploaded` puts nothing, and the command goes", async () => {
    const { app, door, position } = await onRoute()
    door.next("POST /driver/uploads", ({ body }) => json({ state: "uploaded", objectKey: objectKey((body as { commandId: string }).commandId, "png") }))
    door.next("POST /driver/commands", ({ body }) => outcomes(commandsOf(body)))
    const id = await app.tap({ kind: "add-signature", routeId: ROUTE_ID, body: { pickupId: pickupId(1) }, object: signature() })
    position.answer()
    await eventually(() => assert.equal(door.batches().length, 1))
    assert.deepEqual(puts(door), [])
    assert.equal(door.batches()[0][0].body.objectKey, objectKey(id, "png"))
  })

  test("and so is Storage's own duplicate, a 400 it tells by the body's code: a put whose answer was lost, or two drains racing", async () => {
    const { app, door, position } = await onRoute()
    door.next("POST /driver/uploads", signedUpload)
    door.next("POST /driver/commands", ({ body }) => outcomes(commandsOf(body)))
    const id = await app.tap({ kind: "add-signature", routeId: ROUTE_ID, body: { pickupId: pickupId(1) }, object: signature() })
    door.next(`PUT ${uploadPath(id, "png")}`, duplicate)
    position.answer()
    await eventually(() => assert.equal(door.batches().length, 1))
    assert.equal(door.batches()[0][0].body.objectKey, objectKey(id, "png"))
    assert.deepEqual(app.store.getSnapshot().rejections, [])
  })

  test("out of reach on the way to Storage, nothing is sent — what follows waits behind it — until Storage has the bytes", async () => {
    const { app, door, position, timers } = await onRoute()
    let reachable = false
    door.always("POST /driver/uploads", (call) => (reachable ? signedUpload(call) : offline()))
    door.always("POST /driver/commands", ({ body }) => outcomes(commandsOf(body)))
    const photoId = await app.tap({ kind: "add-photo", routeId: ROUTE_ID, body: { pickupId: pickupId(1) }, object: photo() })
    position.answer()
    await eventually(() => assert.equal(app.store.getSnapshot().unreachable, true))
    const paused = await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} })
    await settle()
    assert.deepEqual(door.batches(), [])
    assert.equal(app.store.getSnapshot().waiting.length, 2)

    // The API signs, and Storage itself is down.
    reachable = true
    door.next(`PUT ${uploadPath(photoId, "jpg")}`, () => storageError(503, "Service Unavailable"))
    timers.advance(DRAIN_RETRY_MS)
    await eventually(() => assert.equal(puts(door).length, 1))
    await settle()
    assert.deepEqual(door.batches(), [])
    assert.equal(app.store.getSnapshot().unreachable, true)
    assert.equal(app.store.getSnapshot().refused, null)

    door.next(`PUT ${uploadPath(photoId, "jpg")}`, stored(objectKey(photoId, "jpg")))
    timers.advance(DRAIN_RETRY_MS)
    await eventually(() => assert.deepEqual(app.store.getSnapshot().waiting, []))
    assert.deepEqual(door.batches().map((batch) => batch.map((command) => command.id)), [[photoId, paused]])
    assert.equal(app.store.getSnapshot().unreachable, false)
  })

  test("Storage out of reach holds back the photo and what follows it, never what was tapped before: that goes, and the banner stays", async () => {
    const { app, door, position, timers } = await onRoute()
    let reachable = false
    door.always("POST /driver/uploads", offline)
    door.always("POST /driver/commands", ({ body }) => (reachable ? outcomes(commandsOf(body)) : offline()))
    const paused = await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} })
    await eventually(() => assert.equal(app.store.getSnapshot().unreachable, true))
    const photoId = await app.tap({ kind: "add-photo", routeId: ROUTE_ID, body: { pickupId: pickupId(1) }, object: photo() })
    position.answer()
    await eventually(() => assert.equal(door.calls.filter((call) => call.path === "/driver/uploads").length, 1))
    await settle()

    reachable = true
    timers.advance(DRAIN_RETRY_MS)
    await eventually(() => assert.deepEqual(app.store.getSnapshot().waiting.map((entry) => entry.command.id), [photoId]))
    const sent = door.batches().filter((batch) => batch.some((command) => command.id === paused))
    assert.deepEqual(sent.at(-1)?.map((command) => command.id), [paused], "the pause went, the photo did not")
    await settle()
    assert.equal(app.store.getSnapshot().unreachable, true, "the photo still waits for Storage")
    assert.equal(door.calls.filter((call) => call.path === "/driver/uploads").length, 2, "one try per drain, not a loop")
    assert.deepEqual(timers.pending(), [DRAIN_RETRY_MS])
  })

  test("Storage refusing the signed URL itself — a 401 of its own — is the action's refusal, not the session's", async () => {
    const { app, door, position } = await onRoute()
    door.next("POST /driver/uploads", signedUpload)
    const id = await app.tap({ kind: "add-photo", routeId: ROUTE_ID, body: { pickupId: pickupId(1) }, object: photo() })
    door.next(`PUT ${uploadPath(id, "jpg")}`, () => json({ statusCode: "401", error: "Unauthorized", message: "Invalid signature" }, 401))
    position.answer()
    await eventually(() => assert.equal(app.store.getSnapshot().rejections.length, 1))
    assert.equal(app.store.getSnapshot().rejections[0].sentence, "Storage refused the photo: Invalid signature")
    assert.deepEqual(app.store.getSnapshot().waiting, [])
  })

  test("a deployment without Storage refuses the action, not the queue: its sentence on its stop, the action dropped, and what follows sent", async () => {
    const device = await onRoute()
    const { app, door, position } = device
    door.next("POST /driver/uploads", noProofStorage)
    door.next("POST /driver/commands", ({ body }) => outcomes(commandsOf(body)))
    const photoId = await app.tap({ kind: "add-photo", routeId: ROUTE_ID, body: { pickupId: pickupId(2) }, object: photo() })
    const paused = await app.tap({ kind: "pause", routeId: ROUTE_ID, body: {} })
    position.answer()
    await eventually(() => assert.deepEqual(app.store.getSnapshot().waiting, []))
    assert.deepEqual(door.batches().map((batch) => batch.map((command) => command.id)), [[paused]])
    const state = app.store.getSnapshot()
    assert.deepEqual(state.rejections, [{ commandId: photoId, kind: "add-photo", routeId: ROUTE_ID, pickupId: pickupId(2), sentence: NO_STORAGE }])
    assert.equal(state.unreachable, false)
    assert.equal(state.refused, null)
    assert.deepEqual(await device.stored(), [])
  })

  test("Storage refusing the bytes — too large, a format it does not take — refuses the action with Storage's sentence", async () => {
    const { app, door, position } = await onRoute()
    door.next("POST /driver/uploads", signedUpload)
    const id = await app.tap({ kind: "add-photo", routeId: ROUTE_ID, body: { pickupId: pickupId(1) }, object: photo() })
    door.next(`PUT ${uploadPath(id, "jpg")}`, () => json({ statusCode: "413", error: "Payload too large", message: "The object exceeded the maximum allowed size", code: "EntityTooLarge" }, 400))
    position.answer()
    await eventually(() => assert.equal(app.store.getSnapshot().rejections.length, 1))
    assert.deepEqual(app.store.getSnapshot().rejections, [{ commandId: id, kind: "add-photo", routeId: ROUTE_ID, pickupId: pickupId(1), sentence: "Storage refused the photo: The object exceeded the maximum allowed size" }])
    assert.deepEqual(door.batches(), [])
    assert.deepEqual(app.store.getSnapshot().waiting, [])
  })

  test("a 401 on the way waits for the session, as a batch does, and the new token sends it", async () => {
    const { app, door, position } = await onRoute()
    door.next("POST /driver/uploads", () => problem(401, "The token has expired"))
    const id = await app.tap({ kind: "add-signature", routeId: ROUTE_ID, body: { pickupId: pickupId(1) }, object: signature() })
    position.answer()
    await eventually(() => assert.equal(asked(door).length, 1))
    await settle()
    const state = app.store.getSnapshot()
    assert.equal(state.waiting.length, 1)
    assert.deepEqual([state.unreachable, state.refused, state.rejections], [false, null, []])

    door.next("POST /driver/uploads", signedUpload)
    door.next(`PUT ${uploadPath(id, "png")}`, stored(objectKey(id, "png")))
    door.next("POST /driver/commands", ({ body }) => outcomes(commandsOf(body)))
    app.setSession({ who: WHO, client: door.client("n3w-t0k3n") })
    await eventually(() => assert.deepEqual(app.store.getSnapshot().waiting, []))
    assert.equal(door.batches()[0][0].body.objectKey, objectKey(id, "png"))
  })

  test("the bytes stay in the queue until Storage has them, and then only the key does: the next page sends the command without putting it again", async () => {
    const device = await onRoute()
    const { app, door, position } = device
    door.always("POST /driver/uploads", signedUpload)
    door.always("POST /driver/commands", offline)
    const id = await app.tap({ kind: "add-photo", routeId: ROUTE_ID, body: {}, object: photo() })
    const [held] = await device.stored()
    assert.deepEqual(new Uint8Array(held.object?.bytes ?? new ArrayBuffer(0)), new Uint8Array(photo().bytes), "a page closed now loses nothing")

    door.next(`PUT ${uploadPath(id, "jpg")}`, stored(objectKey(id, "jpg")))
    position.answer()
    await eventually(() => assert.equal(app.store.getSnapshot().unreachable, true))
    const [kept] = await device.stored()
    assert.equal(kept.object, undefined, "the bytes leave the phone once Storage has them")
    assert.equal((kept.command.body as { objectKey?: string }).objectKey, objectKey(id, "jpg"))
    app.dispose()

    door.always("POST /driver/commands", ({ body }) => outcomes(commandsOf(body)))
    const next = device.open()
    await next.load()
    await eventually(() => assert.deepEqual(next.store.getSnapshot().waiting, []))
    assert.equal(puts(door).length, 1)
    assert.equal(door.calls.filter((call) => call.path === "/driver/uploads").length, 1)
    assert.equal(door.batches().at(-1)?.[0].body.objectKey, objectKey(id, "jpg"))
  })
})

describe("positions (O8 of #290)", () => {
  /** This driver's session on the route, open since 06:00, paused where said. */
  const openSession = (pausedAt: string | null = null) => ({
    id: "01950000-0000-7000-8000-0000000005a1",
    createdAt: "2027-01-15T06:00:00.000Z",
    updatedAt: "2027-01-15T06:00:00.000Z",
    projectId: PROJECT_ID,
    routeId: ROUTE_ID,
    driverId: DRIVER_ID,
    vehicleId: VEHICLE_ID,
    trailerId: null,
    deviceId: DEVICE,
    appVersion: null,
    startedAt: "2027-01-15T06:00:00.000Z",
    endedAt: null,
    pausedAt,
    lastSeenAt: "2027-01-15T07:59:00.000Z",
  })
  /** A loaded phone on a running route's screen, its door answering every batch as applied. */
  async function running(session = openSession()) {
    const device = phone()
    device.door.always("GET /driver/me", () => json(driverMe()))
    device.door.always(`GET /driver/routes/${ROUTE_ID}`, () => json(routeDetail({ status: "active", session })))
    device.door.always("POST /driver/commands", ({ body }) => outcomes(commandsOf(body)))
    const app = device.open()
    const unwatch = app.watchRoute(ROUTE_ID)
    await app.load()
    await eventually(() => assert.equal(app.store.getSnapshot().status, "ready"))
    return { ...device, app, unwatch }
  }
  /** The phone is heard of `seconds` from now, `metres` north of where it began. */
  const heard = (device: Awaited<ReturnType<typeof running>>, seconds: number, metres = 0) => {
    device.position.move(NOW + seconds * 1000, 55.7 + metres / 111_195)
  }
  const positionBatches = (door: ReturnType<typeof fakeDoor>) => door.batches().flatMap((batch) => batch.filter((command) => command.kind === "record-positions"))

  test("on a running route's screen the phone is watched, the open batch is the queue's collecting row, which counts as no action waiting and is never sent as it stands", async () => {
    const device = await running()
    await eventually(() => assert.equal(device.position.watches.size, 1))
    heard(device, 0)
    await eventually(async () => {
      const rows = await device.stored()
      assert.deepEqual(
        rows.map((row) => [row.state, row.command.kind, (row.command.body as { points: unknown[] }).points.length]),
        [["collecting", "record-positions", 1]],
      )
    })
    assert.deepEqual(device.app.store.getSnapshot().waiting, [], "no action of the driver's waits")
    await device.app.drain()
    assert.deepEqual(device.door.batches(), [], "the open batch is not sent")
  })

  test("two minutes on, the batch closes into a record-positions command minted then, which goes with the next drain and leaves the queue", async () => {
    const device = await running()
    await eventually(() => assert.equal(device.position.watches.size, 1))
    heard(device, 0)
    device.tick(30_000)
    heard(device, 30, 40)
    await eventually(async () => assert.equal(((await device.stored())[0]?.command.body as { points?: unknown[] }).points?.length, 2))
    device.tick(90_000)
    device.timers.advance(120_000)
    await eventually(() => assert.equal(positionBatches(device.door).length, 1))
    const [sent] = positionBatches(device.door)
    assert.match(sent.id, UUID_V7)
    assert.deepEqual(sent.body, {
      points: [
        { at: new Date(NOW).toISOString(), location: { type: "Point", coordinates: [12.58, 55.7] }, accuracyM: 8 },
        { at: new Date(NOW + 30_000).toISOString(), location: { type: "Point", coordinates: [12.58, 55.7 + 40 / 111_195] }, accuracyM: 8 },
      ],
    })
    await eventually(async () => assert.deepEqual(await device.stored(), []))
  })

  test("the open batch survives a reload while offline: the next page closes it into a command and sends it", async () => {
    const first = await running()
    await eventually(() => assert.equal(first.position.watches.size, 1))
    heard(first, 0)
    await eventually(async () => assert.equal((await first.stored()).length, 1))
    first.app.dispose()
    assert.equal(first.position.watches.size, 0, "the page going stops the watch")

    const second = first.open()
    await second.load()
    await eventually(() => assert.equal(positionBatches(first.door).length, 1))
    assert.equal((positionBatches(first.door)[0].body.points as unknown[]).length, 1)
    await eventually(async () => assert.deepEqual((await first.stored()).filter((row) => row.state === "collecting"), []))
  })

  test("a pause or an end-route tap closes the batch first, so its fixes reach the door before the command, and the recording stops", async () => {
    const device = await running()
    await eventually(() => assert.equal(device.position.watches.size, 1))
    heard(device, 0)
    await eventually(async () => assert.equal((await device.stored()).length, 1))
    await device.app.tap({ kind: "end-route", routeId: ROUTE_ID, body: {} })
    assert.equal(device.position.watches.size, 0, "no fix after the route's end is kept")
    device.position.answer()
    await eventually(() =>
      assert.deepEqual(
        device.door.batches().flatMap((batch) => batch.map((command) => command.kind)),
        ["record-positions", "end-route"],
      ),
    )
  })

  test("nothing is recorded on a paused session, without one, off the route's screen, or for another driver's session", async () => {
    const paused = await running(openSession("2027-01-15T07:30:00.000Z"))
    await settle()
    assert.equal(paused.position.watches.size, 0, "paused")

    const unstarted = await running(null as unknown as ReturnType<typeof openSession>)
    await settle()
    assert.equal(unstarted.position.watches.size, 0, "no session")

    const theirs = await running({ ...openSession(), driverId: "01950000-0000-7000-8000-0000000000d2" })
    await settle()
    assert.equal(theirs.position.watches.size, 0, "another driver's session")

    const left = await running()
    await eventually(() => assert.equal(left.position.watches.size, 1))
    heard(left, 0)
    await eventually(async () => assert.equal((await left.stored()).length, 1))
    left.unwatch()
    assert.equal(left.position.watches.size, 0, "the route's screen closed")
    await eventually(() => assert.equal(positionBatches(left.door).length, 1), 2_000)
  })

  test("a refused batch of positions is not shown to the driver: the server keeps its receipt", async () => {
    const device = await running()
    await eventually(() => assert.equal(device.position.watches.size, 1))
    device.door.next("POST /driver/commands", ({ body }) => outcomes(commandsOf(body), () => ({ outcome: "rejected", problem: { type: "about:blank", title: "Bad Request", status: 400, detail: "Before the session started" } })))
    heard(device, 0)
    await eventually(async () => assert.equal((await device.stored()).length, 1))
    device.unwatch()
    await eventually(() => assert.equal(positionBatches(device.door).length, 1))
    await settle()
    assert.deepEqual(device.app.store.getSnapshot().rejections, [])
  })
})

describe("a code read off a bin (O19 of #290)", () => {
  test("is a read of the door, queues nothing, and says when the server is out of reach or refuses", async () => {
    const { app, door } = await onRoute()
    const identification = { code: "WH91001", stops: [{ pickupId: pickupId(1), position: 1, containerId: "01950000-0000-7000-8000-000000000201", containerLabel: "BIN-91001", matchedBy: "barcode" as const, replacement: false }] }
    door.next(`GET /driver/routes/${ROUTE_ID}/identify`, () => json(identification), offline, () => problem(404, `No route ${ROUTE_ID} assigned to this driver`))
    assert.deepEqual(await app.identify(ROUTE_ID, "WH 91001"), { status: "answered", answer: identification })
    const asked = door.calls.find((call) => call.path.endsWith("/identify"))
    assert.ok(asked)
    assert.deepEqual(await app.identify(ROUTE_ID, "WH91001"), { status: "unreachable" })
    assert.deepEqual(await app.identify(ROUTE_ID, "WH91001"), { status: "refused", sentence: `No route ${ROUTE_ID} assigned to this driver` })
    assert.deepEqual(app.store.getSnapshot().waiting, [])
    assert.deepEqual(door.batches(), [])
    app.dispose()
  })
})
