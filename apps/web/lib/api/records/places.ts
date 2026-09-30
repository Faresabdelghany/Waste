// The places on the prototype's records (Issue #180, slice 5a of #81): the
// Depot and the Unloading Station as the two kinds of the mixed "Depots &
// Unloading" module, `resources.depots`, and the Warehouse as
// `resources.warehouses`. The wire shapes are the contracts'
// (`@waste/contracts/places`), imported as types so no zod reaches the
// bundle; the routes are apps/api/src/routes/{depots,unloading-stations,
// warehouses}.ts.
//
// The generic workspace's forms stay as they are, so the mapping speaks
// their field ids: a location's kind is the form's `locationType` (`depot`
// or `unloading`), which is also how the two adapters of one module tell a
// new row apart; the two coordinates are a `FlatPoint` on the wire, both or
// neither (a depot and a station are always located, a warehouse until it
// is geocoded may not be); the form's one "Operating hours" text carries two
// `HH:MM` times, read out of it whatever else it says ("Mon–Fri 05:00–22:00")
// and written back as `05:00–22:00`, the fixtures' own spelling; a station's
// fractions are the form's multiselect over the master module, by web id
// through the resolver, replaced whole through `PUT …/fractions` as a
// vehicle type's container types are. A depot and a warehouse are a
// project's; a station is the company's and shows in every scope.
//
// Refusals come before the API where the API would refuse: what is set once
// (a place's code, its project, its kind of location), a provider that does
// not fit the ownership and one opening time without the other — the two
// rules the contracts spell, quoted here in their own sentences and held
// equal by the test — a status or an ownership the wire lacks, a reference
// the store does not hold. Nothing lends a fixture's id: no module still on
// fixtures names a place by id, so a server row is `<prefix>-<uuid>` from
// the start (the plan on #81, rule (b)). The helpers under "What the
// resources share" are the fleet's too (records/fleet.ts): a vehicle and a
// driver name their project, their provider and their home depot the same
// way.
import type { FlatPoint } from "@waste/contracts/geojson"
import type { Depot, UnloadingStation, Warehouse } from "@waste/contracts/places"
import { splitList } from "@waste/domain/record-values"
import { DEPOT_OWNERSHIPS, DEPOT_STATUSES, UNLOADING_STATION_OWNERSHIPS, UNLOADING_STATION_STATUSES, WAREHOUSE_STATUSES } from "@waste/domain/resources/vocabulary"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { MASTER_DATA_KIND_DETAILS, masterDataKindOf } from "@/lib/data/master-data-kinds"

import { create, get, listAll, patch, put } from "../client"
import {
  hasPrefix,
  inheritedPresentation,
  isLocalRefusal,
  ofKind,
  patchOf,
  stampFacts,
  statusLabel,
  statusToken,
  typed,
  typedFlag,
  webIdOf,
  type Client,
  type LocalRefusal,
  type MappingContext,
  type ResourceAdapter,
  type ServerModule,
} from "./adapter"

/** What a body giving one opening time is told (`@waste/contracts/places`, `BOTH_HOURS_OR_NEITHER`); the test holds the two equal. */
export const BOTH_HOURS_OR_NEITHER = "Give both opening and closing time or neither"
/** What a body whose ownership and provider disagree is told (`@waste/contracts/places`, `PROVIDER_WITH_PROVIDER_OWNERSHIP`); the test holds the two equal. */
export const PROVIDER_WITH_PROVIDER_OWNERSHIP = "Name the owning service provider with service-provider ownership and with nothing else"

// ---------------------------------------------------------------------------
// What the resources share
// ---------------------------------------------------------------------------

export const refusal = (path: string, message: string): LocalRefusal => ({ path, message })

/** A loaded record a server id stands for: the web id the store knows it under, or `<prefix>-<uuid>` when nothing loaded carries it, and its name where loaded. */
export function referenced(context: MappingContext, prefix: string, serverId: string): { webId: string; name?: string } {
  const record = context.resolve.byServerId(serverId)
  return { webId: record?.id ?? webIdOf(prefix, serverId), name: record?.name }
}

/** The project a record names — the form's `projectId`, else the scope it was made in — as a server id, or a refusal. */
export function projectServerIdOf(record: BusinessRecord, context: MappingContext): string | LocalRefusal {
  const webId = typed(record, "projectId") ?? record.projectIds?.[0]
  const serverId = webId === undefined ? undefined : context.resolve.serverIdOf(webId)
  return serverId ?? refusal("projectId", "Pick a project")
}

/** Whether the form moved the record's project: what is set once. */
export const projectMoved = (before: BusinessRecord, after: BusinessRecord) => (typed(after, "projectId") ?? after.projectIds?.[0]) !== (typed(before, "projectId") ?? before.projectIds?.[0])

/** The provider a record names under `serviceProviderId`, as a server id; null for none; a refusal for one the store does not hold. */
export function providerServerIdOf(record: BusinessRecord, context: MappingContext): string | null | LocalRefusal {
  const webId = typed(record, "serviceProviderId")
  if (webId === undefined) return null
  return context.resolve.serverIdOf(webId) ?? refusal("serviceProviderId", "Pick a service provider the API holds")
}

/** The contracts' provider rule, as a create body sees it: the provider is named exactly when `owner` — an ownership, an employment — says `service-provider`. */
export const providerFitsOwner = (owner: string, serviceProviderId: string | null): boolean => (owner === "service-provider") === (serviceProviderId !== null)

/**
 * The depot a record names under `key`, as a server id; null for none; a
 * refusal for a web id the store does not hold or one that is a station's —
 * the mixed module's picker offers both kinds.
 */
export function depotServerIdOf(record: BusinessRecord, key: string, context: MappingContext): string | null | LocalRefusal {
  const webId = typed(record, key)
  if (webId === undefined) return null
  const serverId = context.resolve.serverIdOf(webId)
  const named = serverId === undefined ? undefined : context.resolve.byServerId(serverId)
  if (serverId === undefined || named === undefined || !depotAdapter.owns(named)) return refusal(key, "Pick a depot the API holds")
  return serverId
}

/** The waste fractions a record names under `key` — the form's multiselect over the master module — as server ids, or a refusal for one the store does not hold. */
export function fractionServerIdsOf(record: BusinessRecord, key: string, context: MappingContext): string[] | LocalRefusal {
  const ids: string[] = []
  for (const webId of splitList(typed(record, key))) {
    const serverId = context.resolve.serverIdOf(webId)
    const named = serverId === undefined ? undefined : context.resolve.byServerId(serverId)
    if (serverId === undefined || named === undefined || masterDataKindOf(named) !== "waste-fraction") return refusal(key, "Pick waste fractions the API holds")
    ids.push(serverId)
  }
  return ids
}

/** Whether two sets of ids differ as sets: the form's order is the order they were ticked in, not a change. */
export const sameSet = (a: readonly string[], b: readonly string[]) => [...a].sort().join(",") === [...b].sort().join(",")

/** The point the form's two numbers spell: both → a `FlatPoint`, neither → null, one → the refusal at the missing one, in the caller's sentence. */
export function pointOf(record: BusinessRecord, sentence: string): FlatPoint | null | LocalRefusal {
  const latitude = typed(record, "latitude")
  const longitude = typed(record, "longitude")
  if (latitude === undefined && longitude === undefined) return null
  if (latitude === undefined) return refusal("latitude", sentence)
  if (longitude === undefined) return refusal("longitude", sentence)
  const lat = Number(latitude)
  const lng = Number(longitude)
  if (!Number.isFinite(lat)) return refusal("latitude", "A coordinate is a number")
  if (!Number.isFinite(lng)) return refusal("longitude", "A coordinate is a number")
  return { type: "Point", coordinates: [lng, lat] }
}

/** The form's two numbers from a point: blank for none. */
export const coordinatesOf = (point: FlatPoint | null) => (point === null ? { latitude: "", longitude: "" } : { latitude: String(point.coordinates[1]), longitude: String(point.coordinates[0]) })

/** `55.7091, 12.5958`: the point as a fact, latitude first as a person reads it. */
export const coordinatesFact = (point: FlatPoint) => `${point.coordinates[1]}, ${point.coordinates[0]}`

const TIME = /\b(\d{1,2}):(\d{2})\b/g

/** What an "Operating hours" text that says something other than two times is told. */
export const TWO_TIMES_OR_NOTHING = "Give the opening and the closing time as HH:MM, such as 05:00–22:00, or leave the hours out"

/**
 * The two times an "Operating hours" text carries, whatever else it says
 * around them ("Mon–Fri 05:00–22:00"); none for a blank; the contract's
 * refusal for one time; a refusal for a text that says something else — a
 * third time, hours without minutes — since a text the adapter cannot read
 * must not clear or cut what is on record.
 */
export function hoursOf(text: string | undefined): { opensAt: string | null; closesAt: string | null } | LocalRefusal {
  const trimmed = (text ?? "").trim()
  if (trimmed === "") return { opensAt: null, closesAt: null }
  const times = [...trimmed.matchAll(TIME)].map((match) => `${match[1].padStart(2, "0")}:${match[2]}`)
  if (times.length === 1) return refusal("operatingHours", BOTH_HOURS_OR_NEITHER)
  if (times.length !== 2) return refusal("operatingHours", TWO_TIMES_OR_NOTHING)
  return { opensAt: times[0], closesAt: times[1] }
}

/** `05:00–22:00`, the fixtures' spelling; blank for a place with no hours. */
export const hoursLabel = (opensAt: string | null, closesAt: string | null) => (opensAt !== null && closesAt !== null ? `${opensAt}–${closesAt}` : "")

/** A count a form typed, 1 or more; undefined for blank; a refusal for anything else. */
export function countOf(record: BusinessRecord, key: string, sentence: string): number | undefined | LocalRefusal {
  const text = typed(record, key)
  if (text === undefined) return undefined
  return /^\d+$/.test(text) && Number(text) >= 1 ? Number(text) : refusal(key, sentence)
}

/** A closed-list token the form typed under `key`, or a refusal naming the list; undefined for blank. */
export function tokenOf(record: BusinessRecord, key: string, tokens: readonly string[], what: string, noun: string): string | undefined | LocalRefusal {
  const text = typed(record, key)
  if (text === undefined) return undefined
  const token = statusToken(text)
  return tokens.includes(token) ? token : refusal(key, `The API has no ${what} "${text}" for ${noun}; it knows ${tokens.join(", ")}`)
}

/** The record's lifecycle label as the wire's token, where the wire has it. */
export const lifecycleStatusOf = (record: BusinessRecord, statuses: readonly string[]): string | undefined => {
  const token = statusToken(record.status)
  return statuses.includes(token) ? token : undefined
}

/**
 * The status a create says: the form's typed status where the form has one,
 * held to the wire's list; else the record's lifecycle label where the wire
 * has it; else nothing, and the API's default stands.
 */
export function createStatusOf(record: BusinessRecord, statuses: readonly string[], noun: string): string | undefined | LocalRefusal {
  const typedStatus = tokenOf(record, "status", statuses, "status", noun)
  return typedStatus === undefined ? lifecycleStatusOf(record, statuses) : typedStatus
}

/**
 * The status a patch says: a typed status the form moved, held to the
 * wire's list; else the lifecycle label as the workspace's transitions move
 * it (the store has refused a label the wire lacks before this runs).
 */
export function patchStatusOf(before: BusinessRecord, after: BusinessRecord, statuses: readonly string[], noun: string): string | undefined | LocalRefusal {
  const typedAfter = typed(after, "status")
  if (typedAfter !== undefined && typedAfter !== typed(before, "status")) return tokenOf(after, "status", statuses, "status", noun)
  return lifecycleStatusOf(after, statuses)
}

/** The patch with the status added where it moved: the lifecycle's token before against the one the edit says. */
export function withStatus<Body extends object>(body: Body | null, before: BusinessRecord, status: string | undefined, statuses: readonly string[]): (Body & { status?: string }) | null {
  if (status === undefined || status === lifecycleStatusOf(before, statuses)) return body
  return { ...(body ?? ({} as Body)), status }
}

/** A required text the form typed under `key`, or a refusal in the noun's words. */
export function requiredText(record: BusinessRecord, key: string, noun: string, what: string): string | LocalRefusal {
  return typed(record, key) ?? refusal(key, `${noun} needs ${what}`)
}

/** The kind of location a record of the mixed module is: the form's `locationType`, a depot unless it says `unloading`. */
const isStationRecord = (record: Pick<BusinessRecord, "id" | "submittedValues">) => typed(record, "locationType") === "unloading"

const LOCATION_KIND = "Operational Location"

/** What the two coordinates of a place that is always located are told when one is missing. */
const depotLocated = "A depot has a location: give the latitude and longitude"
const depotKeepsLocation = "A depot keeps a location: give the latitude and longitude"
const stationLocated = "An unloading station has a location: give the latitude and longitude"
const stationKeepsLocation = "An unloading station keeps a location: give the latitude and longitude"
const bothOrNeither = "Give both the latitude and the longitude, or neither"

const VEHICLE_CAPACITY_IS_A_COUNT = "Vehicle capacity is a whole number, 1 or more"

const codeSetOnce = (noun: string) => `The code is set once: ${noun} that needs another code is another ${noun.replace(/^an? /, "")}`

// ---------------------------------------------------------------------------
// Depots
// ---------------------------------------------------------------------------

export const depotAdapter: ResourceAdapter<Depot> = {
  prefix: "depot",
  owns: (record) => hasPrefix("depot")(record) || (record.recordKind === LOCATION_KIND && !isStationRecord(record)),
  statuses: DEPOT_STATUSES,
  list: (client) => listAll<Depot>(client, "/depots"),
  toRecord: (depot, context) => {
    const project = referenced(context, "project", depot.projectId)
    const provider = depot.serviceProviderId === null ? undefined : referenced(context, "service-provider", depot.serviceProviderId)
    const hours = hoursLabel(depot.opensAt, depot.closesAt)
    const facts: Record<string, string> = {
      Kind: "Depot",
      Code: depot.code,
      Address: depot.address,
      Coordinates: coordinatesFact(depot.location),
      Ownership: provider?.name ?? statusLabel(depot.ownership),
    }
    if (hours) facts.Hours = hours
    if (depot.vehicleCapacity !== null) facts["Vehicle capacity"] = String(depot.vehicleCapacity)
    if (project.name !== undefined) facts.Project = project.name
    return {
      id: webIdOf("depot", depot.id),
      name: depot.name,
      context: `Depot · ${project.name ?? "Project"}`,
      status: statusLabel(depot.status),
      ...inheritedPresentation(undefined),
      ...stampFacts(depot, context.now),
      value: hours,
      description: depot.notes ?? "",
      facts,
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      serviceProviderId: provider?.webId,
      recordKind: LOCATION_KIND,
      submittedValues: {
        projectId: project.webId,
        locationType: "depot",
        name: depot.name,
        code: depot.code,
        address: depot.address,
        ...coordinatesOf(depot.location),
        ownership: depot.ownership,
        serviceProviderId: provider?.webId ?? "",
        operatingHours: hours,
        vehicleCapacity: depot.vehicleCapacity === null ? "" : String(depot.vehicleCapacity),
      },
    }
  },
  toCreateBody: (record, context) => {
    const projectId = projectServerIdOf(record, context)
    if (isLocalRefusal(projectId)) return projectId
    const code = requiredText(record, "code", "A depot", "a code")
    if (isLocalRefusal(code)) return code
    const name = requiredText(record, "name", "A depot", "a name")
    if (isLocalRefusal(name)) return name
    const address = requiredText(record, "address", "A depot", "an address")
    if (isLocalRefusal(address)) return address
    const location = pointOf(record, depotLocated)
    if (isLocalRefusal(location)) return location
    if (location === null) return refusal("latitude", depotLocated)
    const ownership = tokenOf(record, "ownership", DEPOT_OWNERSHIPS, "ownership", "a depot") ?? "company"
    if (isLocalRefusal(ownership)) return ownership
    const serviceProviderId = providerServerIdOf(record, context)
    if (isLocalRefusal(serviceProviderId)) return serviceProviderId
    if (!providerFitsOwner(ownership, serviceProviderId)) return refusal("serviceProviderId", PROVIDER_WITH_PROVIDER_OWNERSHIP)
    const hours = hoursOf(typed(record, "operatingHours"))
    if (isLocalRefusal(hours)) return hours
    const vehicleCapacity = countOf(record, "vehicleCapacity", VEHICLE_CAPACITY_IS_A_COUNT)
    if (isLocalRefusal(vehicleCapacity)) return vehicleCapacity
    const status = createStatusOf(record, DEPOT_STATUSES, "a depot")
    if (isLocalRefusal(status)) return status
    return {
      projectId,
      code,
      name,
      address,
      location,
      ownership,
      ...(serviceProviderId === null ? {} : { serviceProviderId }),
      ...(hours.opensAt === null ? {} : { opensAt: hours.opensAt, closesAt: hours.closesAt }),
      ...(vehicleCapacity === undefined ? {} : { vehicleCapacity }),
      ...(status === undefined ? {} : { status }),
    }
  },
  toPatchBody: (before, after, context) => {
    if (isStationRecord(after)) return refusal("locationType", "A location keeps its kind: a depot does not become an unloading station")
    if (typed(after, "code") !== typed(before, "code")) return refusal("code", codeSetOnce("a depot"))
    if (projectMoved(before, after)) return refusal("projectId", "A depot stays in its project")
    const location = pointOf(after, depotKeepsLocation)
    if (isLocalRefusal(location)) return location
    if (location === null) return refusal("latitude", depotKeepsLocation)
    const ownership = tokenOf(after, "ownership", DEPOT_OWNERSHIPS, "ownership", "a depot")
    if (isLocalRefusal(ownership)) return ownership
    const serviceProviderId = providerServerIdOf(after, context)
    if (isLocalRefusal(serviceProviderId)) return serviceProviderId
    if (!providerFitsOwner(ownership ?? typed(before, "ownership") ?? "company", serviceProviderId)) return refusal("serviceProviderId", PROVIDER_WITH_PROVIDER_OWNERSHIP)
    const hours = hoursOf(typed(after, "operatingHours"))
    if (isLocalRefusal(hours)) return hours
    const vehicleCapacity = countOf(after, "vehicleCapacity", VEHICLE_CAPACITY_IS_A_COUNT)
    if (isLocalRefusal(vehicleCapacity)) return vehicleCapacity
    const status = patchStatusOf(before, after, DEPOT_STATUSES, "a depot")
    if (isLocalRefusal(status)) return status
    const body = patchOf(before, after, (record) => {
      const point = pointOf(record, "")
      const read = hoursOf(typed(record, "operatingHours"))
      const provider = providerServerIdOf(record, context)
      const capacity = countOf(record, "vehicleCapacity", "")
      return {
        name: typed(record, "name") ?? record.name,
        address: typed(record, "address"),
        location: isLocalRefusal(point) || point === null ? undefined : point,
        ownership: typed(record, "ownership"),
        serviceProviderId: isLocalRefusal(provider) ? undefined : provider,
        opensAt: isLocalRefusal(read) ? undefined : read.opensAt,
        closesAt: isLocalRefusal(read) ? undefined : read.closesAt,
        vehicleCapacity: isLocalRefusal(capacity) ? undefined : (capacity ?? null),
      }
    })
    return withStatus(body, before, status, DEPOT_STATUSES)
  },
  create: (client, body) => create<Depot>(client, "/depots", body).then((created) => created.body),
  update: (client, serverId, body) => patch<Depot>(client, `/depots/${serverId}`, body),
}

// ---------------------------------------------------------------------------
// Unloading stations
// ---------------------------------------------------------------------------

/** What a station's update carries: a patch of the station, the whole set of fractions, or both, each to its own route. */
type StationWrite = {
  station?: object
  wasteFractionIds?: string[]
}

const FRACTIONS_KEY = "acceptedFractionIds"

export const unloadingStationAdapter: ResourceAdapter<UnloadingStation> = {
  prefix: "station",
  owns: (record) => hasPrefix("station")(record) || (record.recordKind === LOCATION_KIND && isStationRecord(record)),
  statuses: UNLOADING_STATION_STATUSES,
  list: (client) => listAll<UnloadingStation>(client, "/unloading-stations"),
  toRecord: (station, context) => {
    const provider = station.serviceProviderId === null ? undefined : referenced(context, "service-provider", station.serviceProviderId)
    const fractions = station.wasteFractionIds.map((id) => referenced(context, MASTER_DATA_KIND_DETAILS["waste-fraction"].prefix, id))
    const hours = hoursLabel(station.opensAt, station.closesAt)
    const facts: Record<string, string> = {
      Kind: "Unloading station",
      Code: station.code,
      Address: station.address,
      Coordinates: coordinatesFact(station.location),
      Ownership: provider?.name ?? statusLabel(station.ownership),
    }
    if (hours) facts.Hours = hours
    facts.Weighbridge = station.weighbridge ? "Yes" : "No"
    if (fractions.length > 0) facts.Fractions = fractions.map((fraction) => fraction.name ?? fraction.webId).join(" · ")
    return {
      id: webIdOf("station", station.id),
      name: station.name,
      context: `Unloading station · ${statusLabel(station.ownership).toLowerCase()}`,
      status: statusLabel(station.status),
      ...inheritedPresentation(undefined),
      ...stampFacts(station, context.now),
      value: hours,
      description: station.notes ?? "",
      facts,
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      // The company's: no project, so every scope shows it.
      serviceProviderId: provider?.webId,
      recordKind: LOCATION_KIND,
      submittedValues: {
        locationType: "unloading",
        name: station.name,
        code: station.code,
        address: station.address,
        ...coordinatesOf(station.location),
        ownership: station.ownership,
        serviceProviderId: provider?.webId ?? "",
        operatingHours: hours,
        [FRACTIONS_KEY]: fractions.map((fraction) => fraction.webId).join(","),
        weighbridgeAvailable: station.weighbridge,
      },
    }
  },
  toCreateBody: (record, context) => {
    const code = requiredText(record, "code", "An unloading station", "a code")
    if (isLocalRefusal(code)) return code
    const name = requiredText(record, "name", "An unloading station", "a name")
    if (isLocalRefusal(name)) return name
    const address = requiredText(record, "address", "An unloading station", "an address")
    if (isLocalRefusal(address)) return address
    const location = pointOf(record, stationLocated)
    if (isLocalRefusal(location)) return location
    if (location === null) return refusal("latitude", stationLocated)
    const ownership = tokenOf(record, "ownership", UNLOADING_STATION_OWNERSHIPS, "ownership", "an unloading station") ?? refusal("ownership", "Say whose the station is: the company's, a service provider's or external")
    if (isLocalRefusal(ownership)) return ownership
    const serviceProviderId = providerServerIdOf(record, context)
    if (isLocalRefusal(serviceProviderId)) return serviceProviderId
    if (!providerFitsOwner(ownership, serviceProviderId)) return refusal("serviceProviderId", PROVIDER_WITH_PROVIDER_OWNERSHIP)
    const hours = hoursOf(typed(record, "operatingHours"))
    if (isLocalRefusal(hours)) return hours
    const wasteFractionIds = fractionServerIdsOf(record, FRACTIONS_KEY, context)
    if (isLocalRefusal(wasteFractionIds)) return wasteFractionIds
    const status = createStatusOf(record, UNLOADING_STATION_STATUSES, "an unloading station")
    if (isLocalRefusal(status)) return status
    return {
      code,
      name,
      address,
      location,
      ownership,
      ...(serviceProviderId === null ? {} : { serviceProviderId }),
      ...(hours.opensAt === null ? {} : { opensAt: hours.opensAt, closesAt: hours.closesAt }),
      weighbridge: typedFlag(record, "weighbridgeAvailable") ?? false,
      ...(status === undefined ? {} : { status }),
      wasteFractionIds,
    }
  },
  toPatchBody: (before, after, context) => {
    if (!isStationRecord(after)) return refusal("locationType", "A location keeps its kind: an unloading station does not become a depot")
    if (typed(after, "code") !== typed(before, "code")) return refusal("code", codeSetOnce("an unloading station"))
    const location = pointOf(after, stationKeepsLocation)
    if (isLocalRefusal(location)) return location
    if (location === null) return refusal("latitude", stationKeepsLocation)
    const ownership = tokenOf(after, "ownership", UNLOADING_STATION_OWNERSHIPS, "ownership", "an unloading station")
    if (isLocalRefusal(ownership)) return ownership
    const serviceProviderId = providerServerIdOf(after, context)
    if (isLocalRefusal(serviceProviderId)) return serviceProviderId
    if (!providerFitsOwner(ownership ?? typed(before, "ownership") ?? "", serviceProviderId)) return refusal("serviceProviderId", PROVIDER_WITH_PROVIDER_OWNERSHIP)
    const hours = hoursOf(typed(after, "operatingHours"))
    if (isLocalRefusal(hours)) return hours
    const status = patchStatusOf(before, after, UNLOADING_STATION_STATUSES, "an unloading station")
    if (isLocalRefusal(status)) return status
    const is = fractionServerIdsOf(after, FRACTIONS_KEY, context)
    if (isLocalRefusal(is)) return is
    const was = fractionServerIdsOf(before, FRACTIONS_KEY, context)
    const station = withStatus(
      patchOf(before, after, (record) => {
        const point = pointOf(record, "")
        const read = hoursOf(typed(record, "operatingHours"))
        const provider = providerServerIdOf(record, context)
        return {
          name: typed(record, "name") ?? record.name,
          address: typed(record, "address"),
          location: isLocalRefusal(point) || point === null ? undefined : point,
          ownership: typed(record, "ownership"),
          serviceProviderId: isLocalRefusal(provider) ? undefined : provider,
          opensAt: isLocalRefusal(read) ? undefined : read.opensAt,
          closesAt: isLocalRefusal(read) ? undefined : read.closesAt,
          weighbridge: typedFlag(record, "weighbridgeAvailable"),
        }
      }),
      before,
      status,
      UNLOADING_STATION_STATUSES,
    )
    // A set the store could not read before (a row loaded while the master data had failed) is replaced only when the form changed it.
    const wasIds = isLocalRefusal(was) ? undefined : was
    const wasteFractionIds = wasIds !== undefined && sameSet(wasIds, is) ? undefined : is
    if (station === null && wasteFractionIds === undefined) return null
    const write: StationWrite = { ...(station === null ? {} : { station }), ...(wasteFractionIds === undefined ? {} : { wasteFractionIds }) }
    return write
  },
  create: (client, body) => create<UnloadingStation>(client, "/unloading-stations", body).then((created) => created.body),
  // The station first, then the whole set through its own route; the answer
  // is the station as it now stands. Two requests are two, as the vehicle
  // types' update says.
  update: async (client, serverId, body) => {
    const write = body as StationWrite
    let station: UnloadingStation | undefined
    if (write.station !== undefined) station = await patch<UnloadingStation>(client, `/unloading-stations/${serverId}`, write.station)
    if (write.wasteFractionIds !== undefined) station = await put<UnloadingStation>(client, `/unloading-stations/${serverId}/fractions`, { wasteFractionIds: write.wasteFractionIds })
    return station ?? (await get<UnloadingStation>(client, `/unloading-stations/${serverId}`))
  },
}

// ---------------------------------------------------------------------------
// Warehouses
// ---------------------------------------------------------------------------

export const warehouseAdapter: ResourceAdapter<Warehouse> = {
  prefix: "warehouse",
  owns: ofKind("warehouse", ["Warehouse"]),
  statuses: WAREHOUSE_STATUSES,
  list: (client) => listAll<Warehouse>(client, "/warehouses"),
  toRecord: (warehouse, context) => {
    const project = referenced(context, "project", warehouse.projectId)
    const depot = warehouse.depotId === null ? undefined : referenced(context, "depot", warehouse.depotId)
    const facts: Record<string, string> = { Code: warehouse.code, Address: warehouse.address }
    if (warehouse.location !== null) facts.Coordinates = coordinatesFact(warehouse.location)
    if (depot !== undefined) facts["Colocated depot"] = depot.name ?? depot.webId
    if (project.name !== undefined) facts.Project = project.name
    return {
      id: webIdOf("warehouse", warehouse.id),
      name: warehouse.name,
      context: `${project.name ?? "Project"} · ${warehouse.address}`,
      status: statusLabel(warehouse.status),
      ...inheritedPresentation(undefined),
      ...stampFacts(warehouse, context.now),
      description: warehouse.notes ?? "",
      facts,
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: "Warehouse",
      submittedValues: {
        projectId: project.webId,
        name: warehouse.name,
        code: warehouse.code,
        status: warehouse.status,
        address: warehouse.address,
        ...coordinatesOf(warehouse.location),
        colocatedDepotId: depot?.webId ?? "",
      },
    }
  },
  toCreateBody: (record, context) => {
    const projectId = projectServerIdOf(record, context)
    if (isLocalRefusal(projectId)) return projectId
    const code = requiredText(record, "code", "A warehouse", "a code")
    if (isLocalRefusal(code)) return code
    const name = requiredText(record, "name", "A warehouse", "a name")
    if (isLocalRefusal(name)) return name
    const address = requiredText(record, "address", "A warehouse", "an address")
    if (isLocalRefusal(address)) return address
    const location = pointOf(record, bothOrNeither)
    if (isLocalRefusal(location)) return location
    const depotId = depotServerIdOf(record, "colocatedDepotId", context)
    if (isLocalRefusal(depotId)) return depotId
    const status = createStatusOf(record, WAREHOUSE_STATUSES, "a warehouse")
    if (isLocalRefusal(status)) return status
    return {
      projectId,
      code,
      name,
      address,
      ...(location === null ? {} : { location }),
      ...(depotId === null ? {} : { depotId }),
      ...(status === undefined ? {} : { status }),
    }
  },
  toPatchBody: (before, after, context) => {
    if (typed(after, "code") !== typed(before, "code")) return refusal("code", codeSetOnce("a warehouse"))
    if (projectMoved(before, after)) return refusal("projectId", "A warehouse stays in its project")
    const location = pointOf(after, bothOrNeither)
    if (isLocalRefusal(location)) return location
    const depotId = depotServerIdOf(after, "colocatedDepotId", context)
    if (isLocalRefusal(depotId)) return depotId
    const status = patchStatusOf(before, after, WAREHOUSE_STATUSES, "a warehouse")
    if (isLocalRefusal(status)) return status
    const body = patchOf(before, after, (record) => {
      const point = pointOf(record, "")
      const depot = depotServerIdOf(record, "colocatedDepotId", context)
      return {
        name: typed(record, "name") ?? record.name,
        address: typed(record, "address"),
        location: isLocalRefusal(point) ? undefined : point,
        depotId: isLocalRefusal(depot) ? undefined : depot,
      }
    })
    return withStatus(body, before, status, WAREHOUSE_STATUSES)
  },
  create: (client, body) => create<Warehouse>(client, "/warehouses", body).then((created) => created.body),
  update: (client, serverId, body) => patch<Warehouse>(client, `/warehouses/${serverId}`, body),
}

// ---------------------------------------------------------------------------
// The modules
// ---------------------------------------------------------------------------

/** Resources → Depots & Unloading: the depots, then the stations. */
export const placesModule: ServerModule = {
  workspaceId: "resources",
  moduleId: "depots",
  resources: [depotAdapter, unloadingStationAdapter],
}

/** Resources → Warehouses, after the depots one may share a yard with. */
export const warehousesModule: ServerModule = {
  workspaceId: "resources",
  moduleId: "warehouses",
  resources: [warehouseAdapter],
}

export type { Client }
