// Route schemes on the prototype's records (Issue #177, slice 3 of #81): the
// schemes the API holds as the `route-studio.schemes` module, which the list,
// the scheme page, quick create and the collection groups editor read and
// write. The wire shapes are the contracts' (`@waste/contracts/route-schemes`),
// imported as types so no zod reaches the bundle; the routes are
// apps/api/src/routes/{route-schemes,collection-groups}.ts.
//
// A scheme is one resource with its collection groups on it, and the record
// is the prototype's scheme: the scheme's fields under the form's ids, and
// the groups in the prototype's one group shape (@waste/domain/route-schemes/
// groups) — the legacy single-assignment keys when one group runs every
// service day, the explicit JSON under `group-<uuid>` ids otherwise, which is
// what `collectionGroupsToValues` writes for the same groups on the browser's
// path. A parked group — `days: []`, the API's word for a group that no
// longer runs, since there is no delete — is left out of the record, and a
// group the editor removes is parked. Each group's server id is kept beside
// the groups (`SERVER_GROUP_IDS_KEY`), since the legacy shape names its one
// group `default`.
//
// Relations. A project, an area and a provider are named by the web ids
// their modules lend; the fleet, the depot, the unloading station and a
// manual group's containers belong to modules still on fixtures (slices 5a
// and 5b), so they are the API's ids as chips — `vehicle-<uuid>` — until
// their module is read and the resolver names the row; a write reads a chip
// back to its uuid and refuses a fixture's id, which names nothing the API
// holds. A rule names its waste fractions, container types and vehicle type
// by NAME, the words the domain matches containers by, so a write finds the
// master data row of that name (`Resolver.find`) and refuses a name no row
// has.
//
// Statuses. The wire's are `draft` and `validated`, the half of the
// lifecycle a person decides; Scheduled, Effective and Expired are the web's
// readings of the period and of `generation` — when the last run succeeded,
// and each rule group's two latest match stamps, which the record carries as
// `lastGeneratedAt` and the drift history the lifecycle and the Attention
// badge read (container-drift.ts). The runs are where those are stored; the
// web never stamps them on the Pilot.
//
// Writes. A create is one POST with its groups. An edit is the scheme's
// PATCH when only the scheme moved; when groups moved too it is several
// requests, in the order the API can take them: the scheme first (serving
// the union of the old and new days, so a group may move onto a new day and
// off an old one), then the groups — parked, patched, their rule or their
// list replaced whole, created — then the scheme again (the new days alone).
// A validated scheme is held to the structural rules on every one of those
// requests, and some edits pass through a state the rules refuse (a day
// added to a validated scheme: the scheme without a group on it is a 409,
// the group on a day the scheme does not serve a 400), so such an edit goes
// draft first and validated last, and the last request is the API's verdict
// on the whole. A request refused after another landed leaves part of the
// edit written; the adapter asks for the validation again where it
// suspended it, reads the scheme back and throws `PartialWrite`, so the row
// shows what the server holds — a draft, if the verdict was a refusal —
// under the API's sentence.
//
// Generation (#178). The scheme's one action is `generate`: a run over the
// window the office asks for, `POST /route-schemes/:id/generate`, answering
// the run (202 when this request started it, 200 when it is the scheme's
// run already queued or running) and never the scheme, so it is an action
// and not a command (adapter.ts); a page asks for it through
// `generateScheme`. The run finishes on the worker; the scheme page watches
// it (./generation.ts) and then reads the scheme back through `read`, since
// its `generation` reading is the runs'.
import type { GenerationRequest, GenerationRun } from "@waste/contracts/generation"
import type { CollectionGroup as WireGroup, CollectionGroupCreate, CollectionGroupPatch, Occurrence, OccurrenceQuery, RouteScheme, RouteSchemeCreate, RouteSchemePatch, StopMatchingRule } from "@waste/contracts/route-schemes"
import { LAST_GENERATION_MATCHES_KEY, PREVIOUS_GENERATION_MATCHES_KEY, serializeGenerationMatches, type GenerationMatches } from "@waste/domain/route-schemes/container-drift"
import { collectionGroupsOfRecord, collectionGroupsToValues, hasExplicitCollectionGroups, IMPLICIT_GROUP_ID, sharedServiceProvider, type CollectionGroup as SchemeGroup, type ResolvedCollectionGroup } from "@waste/domain/route-schemes/groups"
import { addDays, parseServiceDays, sortServiceDays, type ServiceDay } from "@waste/domain/route-schemes/recurrence"
import { SERVICE_TYPES, type ServiceType } from "@waste/domain/planning/vocabulary"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { MASTER_DATA_KIND_DETAILS, masterDataKindOf, type MasterDataKind } from "@/lib/data/master-data-kinds"
import { ROUTE_SCHEMES_MODULE } from "@/lib/data/route-schemes"

import { create, get, listAll, patch, post, put, withQuery } from "../client"
import {
  inheritedPresentation,
  isLocalRefusal,
  ofKind,
  PartialWrite,
  stampFacts,
  statusLabel,
  statusToken,
  typed,
  webIdOf,
  type Client,
  type LocalRefusal,
  type MappingContext,
  type RecordAction,
  type ResourceAdapter,
  type ServerModule,
} from "./adapter"
import type { ActionOutcome, SendAction } from "./server-records"

/** Where a scheme keeps its groups' server ids: JSON, the web's group id to the server's. */
export const SERVER_GROUP_IDS_KEY = "serverGroupIds"

/**
 * Where a scheme keeps the master data ids its rules were read with, by the
 * names it spells them by: JSON, kind to name to server id. A row renamed in
 * Settings › Master data after the schemes loaded is still found by the name
 * the rule reads.
 */
export const RULE_MASTER_IDS_KEY = "ruleMasterIds"

/** The master data ids a record's rules were read with. */
type RuleMasterIds = Partial<Record<MasterDataKind, Record<string, string>>>

/** What a group whose stop source a write would change is told: the wire sets it once. */
export const STOP_SOURCE_KEPT = "A collection group keeps how it finds its stops: add a group that picks containers and remove this one"

const SCHEME_PREFIX = "scheme"
const GROUP_PREFIX = "group"
/** The prefixes the id chips of rows not read from the API yet carry, as their modules' fixtures spell their ids. */
const CHIP = { project: "project", area: "area", provider: "service-provider", vehicle: "vehicle", driver: "driver", depot: "depot", station: "station", container: "asset" } as const

const refusal = (path: string, message: string): LocalRefusal => ({ path, message })
const isRefusal = isLocalRefusal

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The web id of another module's row: the one its module lends once it is read, else the chip. */
function webIdFor(context: MappingContext, prefix: string, serverId: string): string {
  return context.resolve.byServerId(serverId)?.id ?? webIdOf(prefix, serverId)
}

/** The server id behind a web id: its module's, else a chip's uuid; undefined for a fixture's id, which names nothing on the API. */
function serverIdFor(context: MappingContext, prefix: string, webId: string): string | undefined {
  const known = context.resolve.serverIdOf(webId)
  if (known !== undefined) return known
  const rest = webId.startsWith(`${prefix}-`) ? webId.slice(prefix.length + 1) : ""
  return UUID.test(rest) ? rest : undefined
}

/** The name the domain matches by, for a master data row the API names by id; the chip when the row is not loaded. */
function masterName(context: MappingContext, kind: MasterDataKind, serverId: string): string {
  return context.resolve.byServerId(serverId)?.name ?? webIdOf(MASTER_DATA_KIND_DETAILS[kind].prefix, serverId)
}

const MASTER_WORDS: Record<MasterDataKind, string> = { "waste-fraction": "waste fraction", "container-type": "container type", "service-frequency": "service frequency", "vehicle-type": "vehicle type" }

/**
 * The server id of the master data row a rule names by name — the row of
 * that name now, else the one the record was read with (`known`), else a
 * chip read back unloaded — or a refusal at the form's field.
 */
function masterId(context: MappingContext, kind: MasterDataKind, name: string, path: string, known: RuleMasterIds): string | LocalRefusal {
  const row = context.resolve.find((record) => masterDataKindOf(record) === kind && record.name === name)
  const id = row === undefined ? (known[kind]?.[name] ?? serverIdFor(context, MASTER_DATA_KIND_DETAILS[kind].prefix, name)) : context.resolve.serverIdOf(row.id)
  return id ?? refusal(path, `The API holds no ${MASTER_WORDS[kind]} named ${JSON.stringify(name)}`)
}

function ruleMasterIdsOf(record: BusinessRecord): RuleMasterIds {
  const raw = record.submittedValues?.[RULE_MASTER_IDS_KEY]
  if (typeof raw !== "string" || raw === "") return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as RuleMasterIds) : {}
  } catch {
    return {}
  }
}

/** Every item mapped, or the first refusal. */
function allOf<T>(items: readonly string[], each: (item: string) => T | LocalRefusal): T[] | LocalRefusal {
  const out: T[] = []
  for (const item of items) {
    const mapped = each(item)
    if (isRefusal(mapped)) return mapped
    out.push(mapped)
  }
  return out
}

/** The form's last day in force from the wire's first day out (half-open, ADR-0005), and back. */
const lastDayIn = (firstDayOut: string) => addDays(firstDayOut, -1)
const firstDayOut = (lastDayIn: string) => addDays(lastDayIn, 1)

const sameDays = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((day, index) => day === b[index])

const isServiceType = (value: string): value is ServiceType => (SERVICE_TYPES as readonly string[]).includes(value)

/** An object without its undefined members, as the domain's group shape is compacted. */
function compact<T extends object>(object: T): T {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== undefined)) as T
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/** A wire group as the prototype's group, under `group-<uuid>`. */
function schemeGroupOf(group: WireGroup, context: MappingContext): SchemeGroup {
  const provider = group.serviceProviderId === null ? undefined : context.resolve.byServerId(group.serviceProviderId)
  const vehicle = group.vehicleId === null ? undefined : context.resolve.byServerId(group.vehicleId)
  const driver = group.driverId === null ? undefined : context.resolve.byServerId(group.driverId)
  const rule = group.rule
  return compact({
    id: webIdOf(GROUP_PREFIX, group.id),
    name: group.name,
    days: sortServiceDays(group.days),
    fractions: rule?.wasteFractionIds.map((id) => masterName(context, "waste-fraction", id)) ?? [],
    stopSource: group.stopSource,
    ruleVehicleType: rule?.vehicleTypeId ? masterName(context, "vehicle-type", rule.vehicleTypeId) : undefined,
    containerTypes: rule && rule.containerTypeIds.length > 0 ? rule.containerTypeIds.map((id) => masterName(context, "container-type", id)) : undefined,
    containerIds: group.containerIds.map((id) => webIdFor(context, CHIP.container, id)),
    serviceProviderId: group.serviceProviderId === null ? undefined : (provider?.id ?? webIdOf(CHIP.provider, group.serviceProviderId)),
    serviceProviderName: provider?.name,
    vehicleId: group.vehicleId === null ? undefined : (vehicle?.id ?? webIdOf(CHIP.vehicle, group.vehicleId)),
    // The callsign, as the create path denormalizes a vehicle's name; the chip while the fleet is not read from the API.
    vehicleName: group.vehicleId === null ? undefined : (vehicle?.name.split(" · ")[0] ?? webIdOf(CHIP.vehicle, group.vehicleId)),
    driverId: group.driverId === null ? undefined : (driver?.id ?? webIdOf(CHIP.driver, group.driverId)),
    driverName: group.driverId === null ? undefined : (driver?.name ?? webIdOf(CHIP.driver, group.driverId)),
  })
}

// ---------------------------------------------------------------------------
// Writing: the scheme's fields
// ---------------------------------------------------------------------------

type SchemeFields = Omit<RouteSchemePatch, "status">

/** A place's server id from the form's web id, null for none, or a refusal naming the field. */
function placeOf(context: MappingContext, record: BusinessRecord, key: string, prefix: string, what: string): string | null | LocalRefusal {
  const webId = typed(record, key)
  if (webId === undefined) return null
  return serverIdFor(context, prefix, webId) ?? refusal(key, `The API holds no ${what} ${webId}`)
}

/** The scheme's own wire fields as the record spells them, or the first refusal. */
function schemeFieldsOf(record: BusinessRecord, context: MappingContext): SchemeFields | LocalRefusal {
  const areaWebId = typed(record, "planningAreaId")
  const planningAreaId = areaWebId === undefined ? null : (serverIdFor(context, CHIP.area, areaWebId) ?? refusal("planningAreaId", "Pick a planning area the API holds"))
  if (isRefusal(planningAreaId)) return planningAreaId
  const depotId = placeOf(context, record, "depotId", CHIP.depot, "depot")
  if (isRefusal(depotId)) return depotId
  const unloadingStationId = placeOf(context, record, "unloadingStationId", CHIP.station, "unloading station")
  if (isRefusal(unloadingStationId)) return unloadingStationId
  const serviceTypeLabel = typed(record, "serviceType")
  const serviceType = serviceTypeLabel === undefined ? undefined : statusToken(serviceTypeLabel)
  if (serviceType !== undefined && !isServiceType(serviceType)) return refusal("serviceType", "Pick a service type")
  const frequency = typed(record, "frequency") as RouteSchemePatch["frequency"]
  const lastDay = typed(record, "effectiveTo")
  const planAhead = record.submittedValues?.planAhead
  return {
    name: typed(record, "schemeName") ?? record.name,
    planningAreaId,
    serviceType,
    frequency,
    serviceDays: parseServiceDays(typed(record, "serviceDays") ?? ""),
    weekRotation: frequency === "every-2-weeks" ? ((typed(record, "weekRotation") as RouteSchemePatch["weekRotation"]) ?? null) : null,
    plannedStartTime: typed(record, "plannedStartTime") ?? null,
    holidayPolicy: typed(record, "holidayPolicy") as RouteSchemePatch["holidayPolicy"],
    editPolicy: typed(record, "editPolicy") as RouteSchemePatch["editPolicy"],
    planAhead: typeof planAhead === "boolean" ? planAhead : undefined,
    depotId,
    unloadingStationId,
    validFrom: typed(record, "effectiveFrom"),
    validTo: lastDay === undefined ? null : firstDayOut(lastDay),
  }
}

/** The status token a record's status spells on the wire: one of the two a person decides. */
const statusOf = (record: BusinessRecord): string => statusToken(record.status)

// ---------------------------------------------------------------------------
// Writing: the groups
// ---------------------------------------------------------------------------

/** A group's rule by id, from the names the record spells it by. */
function ruleOf(group: SchemeGroup, context: MappingContext, known: RuleMasterIds = {}): StopMatchingRule | LocalRefusal {
  if (group.fractions.length === 0) return refusal("wasteFraction", "A group that matches by rule names a waste fraction")
  const wasteFractionIds = allOf(group.fractions, (name) => masterId(context, "waste-fraction", name, "wasteFraction", known))
  if (isRefusal(wasteFractionIds)) return wasteFractionIds
  const containerTypeIds = allOf(group.containerTypes ?? [], (name) => masterId(context, "container-type", name, "matchContainerTypes", known))
  if (isRefusal(containerTypeIds)) return containerTypeIds
  const vehicleTypeId = group.ruleVehicleType === undefined ? null : masterId(context, "vehicle-type", group.ruleVehicleType, "matchVehicleType", known)
  if (isRefusal(vehicleTypeId)) return vehicleTypeId
  return { wasteFractionIds, containerTypeIds, vehicleTypeId }
}

/** A manual group's picks by the API's ids, in stop order. */
function containerIdsOf(group: SchemeGroup, context: MappingContext): string[] | LocalRefusal {
  return allOf(group.containerIds, (webId) => serverIdFor(context, CHIP.container, webId) ?? refusal("containerIds", `The API holds no container ${webId}`))
}

type GroupFleet = Pick<CollectionGroupPatch, "serviceProviderId" | "vehicleId" | "driverId">

/** A group's provider, vehicle and driver by the API's ids, null where it names none. */
function fleetOf(group: SchemeGroup, context: MappingContext): Required<GroupFleet> | LocalRefusal {
  const one = (webId: string | undefined, prefix: string, path: string, what: string) =>
    webId === undefined ? null : (serverIdFor(context, prefix, webId) ?? refusal(path, `The API holds no ${what} ${webId}`))
  const serviceProviderId = one(group.serviceProviderId, CHIP.provider, "serviceProviderId", "service provider")
  if (isRefusal(serviceProviderId)) return serviceProviderId
  const vehicleId = one(group.vehicleId, CHIP.vehicle, "plannedVehicleId", "vehicle")
  if (isRefusal(vehicleId)) return vehicleId
  const driverId = one(group.driverId, CHIP.driver, "plannedDriverId", "driver")
  if (isRefusal(driverId)) return driverId
  return { serviceProviderId, vehicleId, driverId }
}

/** A group to create, whole: its rule or its list, never both. */
function groupCreateOf(group: SchemeGroup, context: MappingContext, known: RuleMasterIds = {}): CollectionGroupCreate | LocalRefusal {
  const fleet = fleetOf(group, context)
  if (isRefusal(fleet)) return fleet
  if (group.stopSource === "rule") {
    const rule = ruleOf(group, context, known)
    if (isRefusal(rule)) return rule
    return { name: group.name, days: group.days, stopSource: "rule", rule, containerIds: null, ...fleet }
  }
  const containerIds = containerIdsOf(group, context)
  if (isRefusal(containerIds)) return containerIds
  return { name: group.name, days: group.days, stopSource: "manual", rule: null, containerIds, ...fleet }
}

/**
 * One group request of an edit. `phase` is its place in the order `update`
 * sends them: the API holds each request to "no container on two groups a
 * shared day" (and a validated scheme to the rest), so what gives something
 * up goes before what takes it — parks first, then the writes that only
 * shrink (fewer days, a shorter list) or change nothing picked (a rule, a
 * name, the fleet), then the ones that grow, then the new groups.
 */
type GroupWrite = { phase: 0 | 1 | 2 | 3 } & (
  | { kind: "park"; id: string }
  | { kind: "patch"; id: string; body: CollectionGroupPatch }
  | { kind: "rule"; id: string; body: StopMatchingRule }
  | { kind: "containers"; id: string; body: { containerIds: string[] } }
  | { kind: "create"; body: CollectionGroupCreate }
)

/** Whether `after` holds something `before` did not: a day, a container. */
const grows = (before: readonly string[], after: readonly string[]) => after.some((item) => !before.includes(item))

/** Whether two groups' rules name the same fractions, container types and vehicle type, in the names the record spells them by. */
const sameRule = (a: SchemeGroup, b: SchemeGroup) =>
  JSON.stringify([a.fractions, a.containerTypes ?? [], a.ruleVehicleType ?? null]) === JSON.stringify([b.fractions, b.containerTypes ?? [], b.ruleVehicleType ?? null])

/** The web group id to server id map a record carries. */
function serverGroupIdsOf(record: BusinessRecord): Record<string, string> {
  const raw = record.submittedValues?.[SERVER_GROUP_IDS_KEY]
  if (typeof raw !== "string" || raw === "") return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

/** The groups of a record, with the day list the legacy shape reads them against. */
const groupsOf = (record: BusinessRecord): ResolvedCollectionGroup[] => collectionGroupsOfRecord(record)

/**
 * What the groups' change between two records asks of the API, in order, or
 * a refusal. A group is the server's when the record's id map names it; the
 * one group of the legacy shape (`default`) that the map does not name —
 * explicit groups merged back into one — is the scheme's first group. A
 * group the map names and `after` lacks is parked.
 */
function groupWritesOf(before: BusinessRecord, after: BusinessRecord, context: MappingContext): GroupWrite[] | LocalRefusal {
  const ids = serverGroupIdsOf(before)
  const known = ruleMasterIdsOf(before)
  const was = groupsOf(before)
  const is = groupsOf(after)
  const wasByServerId = new Map(was.flatMap((group) => (ids[group.id] === undefined ? [] : [[ids[group.id], group] as const])))
  const firstServerId = was.map((group) => ids[group.id]).find((id) => id !== undefined)
  const serverIdOf = (group: ResolvedCollectionGroup) => ids[group.id] ?? (group.id === IMPLICIT_GROUP_ID && is.length === 1 ? firstServerId : undefined)
  const writes: GroupWrite[] = []
  const kept = new Set<string>()
  for (const group of is) {
    const serverId = serverIdOf(group)
    const prior = serverId === undefined ? undefined : wasByServerId.get(serverId)
    if (serverId === undefined || prior === undefined) {
      // Appended after the scheme's groups, as the editor adds one: no group is renumbered.
      const body = groupCreateOf(group, context, known)
      if (isRefusal(body)) return body
      writes.push({ phase: 3, kind: "create", body })
      continue
    }
    kept.add(serverId)
    if (prior.stopSource !== group.stopSource) return refusal("stopSelection", STOP_SOURCE_KEPT)
    const fleetBefore = fleetOf(prior, context)
    const fleetAfter = fleetOf(group, context)
    if (isRefusal(fleetAfter)) return fleetAfter
    const body: CollectionGroupPatch = {
      // The legacy shape's one group carries the scheme's name, not its own, so it renames nothing.
      ...(group.implicit || group.name === prior.name ? {} : { name: group.name }),
      ...(sameDays(group.days, prior.days) ? {} : { days: group.days }),
      ...Object.fromEntries(Object.entries(fleetAfter).filter(([key, value]) => isRefusal(fleetBefore) || fleetBefore[key as keyof GroupFleet] !== value)),
    }
    if (Object.keys(body).length > 0) writes.push({ phase: grows(prior.days, group.days) ? 2 : 1, kind: "patch", id: serverId, body })
    if (group.stopSource === "rule") {
      // A rule the edit leaves alone is not resolved again, so a master data row renamed since the load blocks nothing.
      if (sameRule(prior, group)) continue
      const rule = ruleOf(group, context, known)
      if (isRefusal(rule)) return rule
      writes.push({ phase: 1, kind: "rule", id: serverId, body: rule })
    } else {
      const containerIds = containerIdsOf(group, context)
      if (isRefusal(containerIds)) return containerIds
      if (containerIds.length === 0) return refusal("containerIds", "A group that picks containers picks one at least")
      const priorIds = containerIdsOf(prior, context)
      if (isRefusal(priorIds) || JSON.stringify(containerIds) !== JSON.stringify(priorIds)) {
        writes.push({ phase: isRefusal(priorIds) || grows(priorIds, containerIds) ? 2 : 1, kind: "containers", id: serverId, body: { containerIds } })
      }
    }
  }
  for (const [serverId, group] of wasByServerId) {
    if (!kept.has(serverId) && group.days.length > 0) writes.push({ phase: 0, kind: "park", id: serverId })
  }
  return writes.sort((a, b) => a.phase - b.phase)
}

/**
 * An edit as the API takes it: the scheme's patch before the groups, the
 * groups, the scheme's patch after them. `wrap` says the first moved a
 * validated scheme to draft and the last validates it again.
 */
type SchemeWrite = { first?: RouteSchemePatch; groups: GroupWrite[]; last?: RouteSchemePatch; wrap: boolean }

const nonEmpty = <T extends object>(body: T): T | undefined => (Object.keys(body).length === 0 ? undefined : body)

/** The fields `after` says and says otherwise than `before`: `patchOf`'s rule over two readings already made. */
function changedFields(before: SchemeFields, after: SchemeFields): SchemeFields {
  const was = before as Record<string, unknown>
  return Object.fromEntries(Object.entries(after).filter(([key, value]) => value !== undefined && JSON.stringify(value) !== JSON.stringify(was[key]))) as SchemeFields
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

async function sendGroupWrite(client: Client, schemeId: string, write: GroupWrite): Promise<void> {
  switch (write.kind) {
    case "park":
      await patch<WireGroup>(client, `/collection-groups/${write.id}`, { days: [] })
      return
    case "patch":
      await patch<WireGroup>(client, `/collection-groups/${write.id}`, write.body)
      return
    case "rule":
      await put<WireGroup>(client, `/collection-groups/${write.id}/stop-matching-rule`, write.body)
      return
    case "containers":
      await put<WireGroup>(client, `/collection-groups/${write.id}/containers`, write.body)
      return
    case "create":
      await create<WireGroup>(client, `/route-schemes/${schemeId}/collection-groups`, write.body)
      return
  }
}

/** A scheme's generate, by the name the adapter's `actions` holds it under. */
export const GENERATE_ROUTES = "generate"

/** What a generate answers: the run, and whether this request started it (202) or it is the scheme's run already queued or running (200) — two clicks are one run. */
export type GenerationAnswer = { run: GenerationRun; started: boolean }

/** The days a generate plans, both inclusive, as the generate dialog says them. */
export type GenerationWindow = { from: string; to: string }

const dayOf = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined)

const generateRoutes: RecordAction<GenerationAnswer> = {
  // The window alone: the trigger, the status and the scheme are the server's. Its rules — ordered, at most 366 days — are the API's to say.
  toBody: (input) => {
    const from = dayOf(input.from)
    if (from === undefined) return refusal("from", "Pick the first day to generate")
    const to = dayOf(input.to)
    if (to === undefined) return refusal("to", "Pick the last day to generate")
    return { from, to } satisfies GenerationRequest
  },
  run: async (client, serverId, body) => {
    const { status, body: run } = await post<GenerationRun>(client, `/route-schemes/${serverId}/generate`, body)
    return { run, started: status === 202 }
  },
  refused: (record) => `Generation of ${record.name} was not started`,
}

export const routeSchemeAdapter: ResourceAdapter<RouteScheme> = {
  prefix: SCHEME_PREFIX,
  owns: ofKind(SCHEME_PREFIX, ["Route Scheme"]),
  statuses: ["draft", "validated"],
  list: (client) => listAll<RouteScheme>(client, "/route-schemes"),
  toRecord: (scheme, context) => {
    const project = context.resolve.byServerId(scheme.projectId)
    const projectWebId = project?.id ?? webIdOf(CHIP.project, scheme.projectId)
    const area = scheme.planningAreaId === null ? undefined : context.resolve.byServerId(scheme.planningAreaId)
    const serviceDays = sortServiceDays(scheme.serviceDays)
    const running = scheme.collectionGroups.filter((group) => group.days.length > 0)
    const groups = running.map((group) => schemeGroupOf(group, context))
    const groupValues = collectionGroupsToValues(groups, serviceDays)
    // The legacy shape names its one group `default`; the explicit one keeps the ids above.
    const explicit = hasExplicitCollectionGroups(groupValues)
    const webGroupIdOf = new Map(running.map((group) => [group.id, explicit ? webIdOf(GROUP_PREFIX, group.id) : IMPLICIT_GROUP_ID]))
    const last: GenerationMatches = {}
    const previous: GenerationMatches = {}
    for (const entry of scheme.generation.groups) {
      const webId = webGroupIdOf.get(entry.groupId)
      if (webId === undefined) continue
      last[webId] = { rule: entry.latest.ruleSignature, containerIds: entry.latest.containerIds.map((id) => webIdFor(context, CHIP.container, id)) }
      if (entry.previous !== null) previous[webId] = { rule: entry.previous.ruleSignature, containerIds: entry.previous.containerIds.map((id) => webIdFor(context, CHIP.container, id)) }
    }
    const fractions = new Set(groups.flatMap((group) => group.fractions))
    // The ids each rule was read with, by the names the record spells them by (RULE_MASTER_IDS_KEY).
    const ruleIds: RuleMasterIds = {}
    const note = (kind: MasterDataKind, id: string) => {
      ruleIds[kind] = { ...ruleIds[kind], [masterName(context, kind, id)]: id }
    }
    for (const { rule } of running) {
      if (rule === null) continue
      for (const id of rule.wasteFractionIds) note("waste-fraction", id)
      for (const id of rule.containerTypeIds) note("container-type", id)
      if (rule.vehicleTypeId !== null) note("vehicle-type", rule.vehicleTypeId)
    }
    const provider = sharedServiceProvider(groups)
    const lastDay = scheme.validTo === null ? "" : lastDayIn(scheme.validTo)
    return {
      id: webIdOf(SCHEME_PREFIX, scheme.id),
      name: scheme.name,
      context: project?.name ?? "Project",
      status: statusLabel(scheme.status),
      ...inheritedPresentation(undefined),
      ...stampFacts(scheme, context.now),
      value: "—",
      facts: {
        Project: project?.name ?? "Project",
        ...(area === undefined ? {} : { "Planning area": area.name }),
        "Service type": statusLabel(scheme.serviceType),
        ...(scheme.plannedStartTime === null ? {} : { "Planned start": scheme.plannedStartTime }),
        ...(provider.name === undefined ? {} : { "Service provider": provider.name }),
        // The legacy shape names its one group's fleet by these facts (collectionGroupsOf).
        ...(explicit || groups[0]?.vehicleName === undefined ? {} : { Vehicle: groups[0].vehicleName }),
        ...(explicit || groups[0]?.driverName === undefined ? {} : { Driver: groups[0].driverName }),
        "Plan ahead": scheme.planAhead ? "On" : "Off",
      },
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [projectWebId],
      ...(provider.id === undefined ? {} : { serviceProviderId: provider.id }),
      recordKind: "Route Scheme",
      submittedValues: {
        schemeName: scheme.name,
        projectId: projectWebId,
        planningAreaId: scheme.planningAreaId === null ? "" : (area?.id ?? webIdOf(CHIP.area, scheme.planningAreaId)),
        wasteFraction: fractions.size === 1 ? [...fractions][0] : "",
        serviceType: statusLabel(scheme.serviceType),
        frequency: scheme.frequency,
        weekRotation: scheme.weekRotation ?? "",
        serviceDays: serviceDays.join(", "),
        effectiveFrom: scheme.validFrom,
        effectiveTo: lastDay,
        plannedStartTime: scheme.plannedStartTime ?? "",
        holidayPolicy: scheme.holidayPolicy,
        editPolicy: scheme.editPolicy,
        planAhead: scheme.planAhead,
        depotId: scheme.depotId === null ? "" : webIdFor(context, CHIP.depot, scheme.depotId),
        unloadingStationId: scheme.unloadingStationId === null ? "" : webIdFor(context, CHIP.station, scheme.unloadingStationId),
        ...groupValues,
        [SERVER_GROUP_IDS_KEY]: JSON.stringify(Object.fromEntries(running.map((group) => [webGroupIdOf.get(group.id), group.id]))),
        [RULE_MASTER_IDS_KEY]: JSON.stringify(ruleIds),
        ...(scheme.generation.lastGeneratedAt === null ? {} : { lastGeneratedAt: scheme.generation.lastGeneratedAt }),
        [LAST_GENERATION_MATCHES_KEY]: serializeGenerationMatches(last),
        [PREVIOUS_GENERATION_MATCHES_KEY]: serializeGenerationMatches(previous),
      },
    }
  },
  toCreateBody: (record, context) => {
    const projectWebId = typed(record, "projectId") ?? record.projectIds?.[0]
    const projectId = projectWebId === undefined ? undefined : serverIdFor(context, CHIP.project, projectWebId)
    if (projectId === undefined) return refusal("projectId", "Pick a project")
    const fields = schemeFieldsOf(record, context)
    if (isRefusal(fields)) return fields
    const { serviceType, frequency, validFrom, validTo, holidayPolicy, editPolicy, planAhead, ...rest } = fields
    if (serviceType === undefined) return refusal("serviceType", "Pick a service type")
    if (frequency === undefined) return refusal("frequency", "Pick how often the scheme recurs")
    if (rest.serviceDays === undefined || rest.serviceDays.length === 0) return refusal("serviceDays", "Pick the days the scheme serves")
    if (validFrom === undefined) return refusal("effectiveFrom", "A scheme needs the day it comes into force")
    const groups: CollectionGroupCreate[] = []
    for (const group of groupsOf(record)) {
      const created = groupCreateOf(group, context)
      if (isRefusal(created)) return created
      groups.push(created)
    }
    const status = statusOf(record)
    // The contract's output type says `planAhead` always; on the way in, absent is the server's default.
    const body: Omit<RouteSchemeCreate, "planAhead"> & { planAhead?: boolean } = {
      projectId,
      name: rest.name ?? record.name,
      planningAreaId: rest.planningAreaId,
      serviceType,
      frequency,
      serviceDays: rest.serviceDays,
      weekRotation: rest.weekRotation,
      plannedStartTime: rest.plannedStartTime,
      holidayPolicy: holidayPolicy ?? "skip",
      editPolicy: editPolicy ?? "ask",
      ...(planAhead === undefined ? {} : { planAhead }),
      status: status === "validated" ? "validated" : "draft",
      depotId: rest.depotId,
      unloadingStationId: rest.unloadingStationId,
      collectionGroups: groups,
      validFrom,
      ...(validTo === null || validTo === undefined ? {} : { validTo }),
    }
    return body
  },
  toPatchBody: (before, after, context) => {
    const projectBefore = typed(before, "projectId") ?? before.projectIds?.[0]
    const projectAfter = typed(after, "projectId") ?? after.projectIds?.[0]
    if (projectBefore !== projectAfter) return refusal("projectId", "A scheme stays in its project")
    const fieldsAfter = schemeFieldsOf(after, context)
    if (isRefusal(fieldsAfter)) return fieldsAfter
    const fieldsBefore = schemeFieldsOf(before, context)
    const scheme = changedFields(isRefusal(fieldsBefore) ? {} : fieldsBefore, fieldsAfter)
    const groups = groupWritesOf(before, after, context)
    if (isRefusal(groups)) return groups
    const statusBefore = statusOf(before)
    const statusAfter = statusOf(after)
    const statusMove = statusAfter === statusBefore ? undefined : (statusAfter as RouteSchemePatch["status"])
    if (groups.length === 0) {
      const only = nonEmpty({ ...scheme, ...(statusMove === undefined ? {} : { status: statusMove }) })
      return only === undefined ? null : ({ first: only, groups, wrap: false } satisfies SchemeWrite)
    }
    const { serviceDays, ...fields } = scheme
    const daysBefore = parseServiceDays(typed(before, "serviceDays") ?? "")
    const daysAfter = serviceDays ?? daysBefore
    const union = sortServiceDays([...new Set<ServiceDay>([...daysBefore, ...daysAfter])])
    const structural = serviceDays !== undefined || groups.length > 1 || groups.some((write) => write.kind === "create" || write.kind === "park" || (write.kind === "patch" && write.body.days !== undefined))
    const wrap = statusBefore === "validated" && statusAfter === "validated" && structural
    const write: SchemeWrite = {
      first: nonEmpty({
        ...fields,
        ...(sameDays(union, daysBefore) ? {} : { serviceDays: union }),
        ...(wrap || statusMove === "draft" ? { status: "draft" as const } : {}),
      }),
      groups,
      last: nonEmpty({
        ...(sameDays(union, daysAfter) ? {} : { serviceDays: daysAfter }),
        ...(wrap || statusMove === "validated" ? { status: "validated" as const } : {}),
      }),
      wrap,
    }
    return write
  },
  create: (client, body) => create<RouteScheme>(client, "/route-schemes", body).then((created) => created.body),
  update: async (client, serverId, body) => {
    const write = body as SchemeWrite
    const path = `/route-schemes/${serverId}`
    let landed = false
    let step: "first" | "groups" | "last" = "first"
    try {
      let answer: RouteScheme | undefined
      if (write.first !== undefined) {
        answer = await patch<RouteScheme>(client, path, write.first)
        landed = true
      }
      step = "groups"
      for (const group of write.groups) {
        await sendGroupWrite(client, serverId, group)
        landed = true
        answer = undefined
      }
      step = "last"
      if (write.last !== undefined) answer = await patch<RouteScheme>(client, path, write.last)
      return answer ?? (await get<RouteScheme>(client, path))
    } catch (error) {
      if (!landed) throw error
      // The validation the first request suspended, asked for again unless it was the verdict that failed.
      if (write.wrap && step !== "last") await patch<RouteScheme>(client, path, { status: "validated" }).catch(() => undefined)
      const standing = await get<RouteScheme>(client, path).catch(() => undefined)
      if (standing === undefined) throw error
      throw new PartialWrite(error, standing)
    }
  },
  read: (client, serverId) => get<RouteScheme>(client, `/route-schemes/${serverId}`),
  actions: { [GENERATE_ROUTES]: generateRoutes },
}

/** A scheme's generate through the store's `sendAction`, its answer typed: the one way a page asks for a run. */
export function generateScheme(sendAction: SendAction, recordId: string, window: GenerationWindow, options?: { report?: boolean }): Promise<ActionOutcome<GenerationAnswer>> {
  return sendAction(ROUTE_SCHEMES_MODULE.workspaceId, ROUTE_SCHEMES_MODULE.moduleId, recordId, GENERATE_ROUTES, window, options) as Promise<ActionOutcome<GenerationAnswer>>
}

/** The dates the API would plan a scheme on in a window, both days inclusive: the scheme page's next collections. */
export function schemeOccurrences(client: Client, serverId: string, window: OccurrenceQuery): Promise<Occurrence[]> {
  return get<Occurrence[]>(client, withQuery(`/route-schemes/${serverId}/occurrences`, window))
}

/** Route Studio › Route Schemes: the list, the scheme page, quick create and the collection groups editor. */
export const routeSchemesModule: ServerModule = {
  workspaceId: ROUTE_SCHEMES_MODULE.workspaceId,
  moduleId: ROUTE_SCHEMES_MODULE.moduleId,
  resources: [routeSchemeAdapter],
}
