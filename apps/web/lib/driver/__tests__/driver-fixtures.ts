// What the driver door answers, as the Driver App's tests need it: a start
// screen, a route read with its stops, and a door that answers by method and
// path and records what it was asked — a fetch the real client (lib/api/
// client.ts) goes through, so each test reads the request the API would
// have seen.
import type { CommandOutcomeRow, DriverMe, DriverPickup, DriverRouteDetail } from "@waste/contracts/driver-commands"
import type { Route } from "@waste/contracts/routes"

import type { ApiClient } from "../../api/client"
import { PROBLEM_MEDIA_TYPE } from "../../api/problem"

export const NOW = Date.parse("2027-01-15T08:00:00.000Z")
export const ROUTE_ID = "01950000-0000-7000-8000-000000000001"
export const DRIVER_ID = "01950000-0000-7000-8000-0000000000d1"
export const VEHICLE_ID = "01950000-0000-7000-8000-0000000000e1"
export const TRAILER_ID = "01950000-0000-7000-8000-0000000000e2"
export const PROJECT_ID = "01950000-0000-7000-8000-0000000000f1"
export const STATION_ID = "01950000-0000-7000-8000-0000000000a1"
export const FRACTION_ID = "01950000-0000-7000-8000-0000000000b1"
export const pickupId = (n: number) => `01950000-0000-7000-8000-0000000001${String(n).padStart(2, "0")}`

const STAMP = { createdAt: "2027-01-14T20:00:00.000Z", updatedAt: "2027-01-14T20:00:00.000Z" }

export function route(overrides: Partial<Route> = {}): Route {
  return {
    id: ROUTE_ID,
    ...STAMP,
    projectId: PROJECT_ID,
    routeSchemeId: "01950000-0000-7000-8000-0000000000c1",
    collectionGroupId: "01950000-0000-7000-8000-0000000000c2",
    serviceDate: "2027-01-15",
    operatingDate: "2027-01-15",
    number: 1042,
    label: "RC-1042",
    status: "ready",
    note: null,
    cancelledByGeneration: false,
    generationRunId: null,
    plannedStartTime: "06:00",
    planned: { vehicleId: VEHICLE_ID, driverId: DRIVER_ID, trailerId: null, serviceProviderId: null, depotId: null, unloadingStationId: null },
    actual: { vehicleId: null, driverId: null, trailerId: null },
    dispatchedAt: "2027-01-15T05:00:00.000Z",
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    progress: { planned: 3, completed: 0, skipped: 0, failed: 0, total: 3, fraction: 0 },
    ...overrides,
  }
}

export function pickup(n: number, overrides: Partial<DriverPickup> = {}): DriverPickup {
  return {
    id: pickupId(n),
    ...STAMP,
    projectId: PROJECT_ID,
    routeId: ROUTE_ID,
    containerId: `01950000-0000-7000-8000-0000000002${String(n).padStart(2, "0")}`,
    position: n,
    sequence: n,
    status: "planned",
    reason: null,
    note: null,
    propertyId: "01950000-0000-7000-8000-000000000301",
    sharedCollectionPointId: null,
    wasteFractionId: FRACTION_ID,
    arrivedAt: null,
    outcomeAt: null,
    address: `Strandvejen ${n}, 2100 København Ø`,
    location: { type: "Point", coordinates: [12.58, 55.7 + n / 1000] },
    containerLabel: `BIN-9100${n}`,
    wasteFractionName: "Residual",
    ...overrides,
  }
}

export function routeDetail(overrides: Partial<DriverRouteDetail> = {}): DriverRouteDetail {
  return { ...route(), pickups: [pickup(1), pickup(2), pickup(3)], activePlan: null, session: null, sessions: [], unloads: [], ...overrides }
}

export function driverMe(overrides: Partial<DriverMe> = {}): DriverMe {
  return {
    driver: {
      id: DRIVER_ID,
      ...STAMP,
      projectId: PROJECT_ID,
      name: "Mads Jensen",
      workforceReference: null,
      employment: "employee",
      serviceProviderId: null,
      homeDepotId: null,
      licenceClass: "ce",
      licenceNumber: null,
      licenceExpiry: "2028-12-31",
      userAccountId: "01950000-0000-7000-8000-000000000401",
      status: "active",
      notes: null,
    },
    openSession: null,
    routes: [route()],
    vehicles: [
      { id: VEHICLE_ID, kind: "powered-vehicle", requiredLicenceClass: "c", label: "WH-24" },
      { id: TRAILER_ID, kind: "trailer", requiredLicenceClass: "ce", label: "TR-03" },
    ],
    unloadingStations: [{ id: STATION_ID, name: "ARC Amager", location: { type: "Point", coordinates: [12.62, 55.68] }, weighbridge: true, wasteFractionIds: [FRACTION_ID] }],
    wasteFractions: [{ id: FRACTION_ID, key: "residual", name: "Residual" }],
    ...overrides,
  }
}

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

export const problem = (status: number, detail: string) =>
  new Response(JSON.stringify({ type: "about:blank", title: "Refused", status, detail }), { status, headers: { "content-type": PROBLEM_MEDIA_TYPE } })

/** The door's 200 for a batch: one outcome per command sent, `applied` unless the test says otherwise. */
export const outcomes = (commands: readonly { id: string }[], decide: (id: string, index: number) => Partial<CommandOutcomeRow> = () => ({})) =>
  json({ outcomes: commands.map((command, index) => ({ commandId: command.id, outcome: "applied", ...decide(command.id, index) })) })

/** What a fetch that never reached the server throws. */
export const offline = () => {
  throw new TypeError("Failed to fetch")
}

export type DoorCall = { method: string; path: string; body: unknown }
type Answer = (call: DoorCall) => Response | Promise<Response>

/**
 * A driver door that answers by `METHOD /path`: first from the answers queued
 * for it, in order, then from its standing answer, and refuses anything else
 * so a test notices a request it did not expect.
 */
export function fakeDoor() {
  const calls: DoorCall[] = []
  const queued = new Map<string, Answer[]>()
  const standing = new Map<string, Answer>()
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? "GET"
    const call: DoorCall = { method, path: url.pathname, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined }
    calls.push(call)
    const key = `${method} ${url.pathname}`
    const answer = queued.get(key)?.shift() ?? standing.get(key)
    if (answer === undefined) throw new Error(`unexpected ${key}`)
    return answer(call)
  }) as typeof fetch
  return {
    fetch: fetchImpl,
    calls,
    /** The next answers for a request, in order. */
    next: (key: string, ...answers: Answer[]) => {
      queued.set(key, [...(queued.get(key) ?? []), ...answers])
    },
    /** The answer for a request once its queued ones are spent. */
    always: (key: string, answer: Answer) => {
      standing.set(key, answer)
    },
    /** The batches the door was sent, each as its commands. */
    batches: () => calls.filter((call) => call.method === "POST" && call.path === "/driver/commands").map((call) => (call.body as { commands: Array<{ id: string; kind: string; body: Record<string, unknown> }> }).commands),
    client: (token = "t0k3n"): ApiClient => ({ baseUrl: "http://api.test", token, fetch: fetchImpl }),
  }
}

/** Retries an assertion across macrotask turns until it holds — IndexedDB and the client settle on their own clocks — and fails with its last error after two seconds. */
export async function eventually(assertion: () => void | Promise<void>, withinMs = 2_000): Promise<void> {
  const until = Date.now() + withinMs
  for (;;) {
    try {
      await assertion()
      return
    } catch (error) {
      if (Date.now() > until) throw error
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
}

/** Lets everything in flight run, for a test asserting that something did not happen. */
export async function settle(turns = 50): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await new Promise((resolve) => setImmediate(resolve))
}

/** A geolocation that answers only when the test says. */
export function fakeGeolocation() {
  const asked: Array<{ success: PositionCallback; error?: PositionErrorCallback | null }> = []
  return {
    asked,
    geolocation: {
      getCurrentPosition: (success: PositionCallback, error?: PositionErrorCallback | null) => {
        asked.push({ success, error })
      },
    },
    /** Answers the oldest lookup still waiting with a good fix. */
    answer: (accuracy = 8) => {
      const lookup = asked.shift()
      if (lookup === undefined) throw new Error("no lookup is waiting")
      lookup.success({ coords: { latitude: 55.7, longitude: 12.58, accuracy }, timestamp: NOW } as GeolocationPosition)
    },
  }
}
