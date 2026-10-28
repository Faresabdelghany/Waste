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
// Writes. A create is one POST with its groups. An edit is one request too,
// the scheme's PATCH (#205): the scheme's fields that moved, and — where any
// group moved — `collectionGroups`, the groups as the edit leaves them,
// whole: a group the scheme holds restated under its server id, its rule or
// its list in full; a group the edit adds with none; a group left out is
// parked by the API, since there is no delete. The API holds the structural
// rules once, on the state the edit leaves behind, and writes it in one
// transaction or not at all, so a validated scheme stays validated through
// an edit that adds a day, splits a group or trades containers, and a
// refusal leaves the row as it was under the API's sentence.
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
import type {
  CollectionGroup as WireGroup,
  CollectionGroupCreate,
  CollectionGroupEntry,
  CollectionGroupPatch,
  Occurrence,
  OccurrenceQuery,
  RouteScheme,
  RouteSchemeArchive,
  RouteSchemeArchived,
  RouteSchemeCreate,
  RouteSchemePatch,
  RouteSchemeSuccession,
  RouteSchemeSuccessorCreate,
  StopMatchingRule,
} from "@waste/contracts/route-schemes"
import { LAST_GENERATION_MATCHES_KEY, PREVIOUS_GENERATION_MATCHES_KEY, serializeGenerationMatches, type GenerationMatches } from "@waste/domain/route-schemes/container-drift"
import { collectionGroupsOfRecord, collectionGroupsToValues, hasExplicitCollectionGroups, IMPLICIT_GROUP_ID, sharedServiceProvider, type CollectionGroup as SchemeGroup, type ResolvedCollectionGroup } from "@waste/domain/route-schemes/groups"
import { SCHEME_API_WARNINGS_KEY } from "@waste/domain/route-schemes/lifecycle"
import { addDays, parseServiceDays, sortServiceDays } from "@waste/domain/route-schemes/recurrence"
import { SCHEME_SEASONS_KEY, seasonsValue, storedSeasonsFromValues } from "@waste/domain/route-schemes/scheme-seasons"
import { PLAN_AHEAD_DAYS_DEFAULT, planAheadDaysAllowed } from "@waste/domain/planning/lifecycle"
import { SERVICE_TYPES, type ServiceType } from "@waste/domain/planning/vocabulary"
import { REGISTRY_VISIBILITY_FACT, SOFT_DELETED } from "@waste/domain/record-visibility"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { MASTER_DATA_KIND_DETAILS, masterDataKindOf, type MasterDataKind } from "@/lib/data/master-data-kinds"
import { ROUTE_SCHEMES_MODULE } from "@/lib/data/route-schemes"

import { create, get, listAll, patch, post, withQuery } from "../client"
import {
  inheritedPresentation,
  isLocalRefusal,
  ofKind,
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
 * Where a scheme keeps its groups' names as the server holds them: JSON, the
 * server's group id to its name. The legacy shape names its one group after
 * the scheme, so an edit restating that group says the name the server has.
 */
export const SERVER_GROUP_NAMES_KEY = "serverGroupNames"

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

const MASTER_WORDS: Record<MasterDataKind, string> = { "waste-fraction": "waste fraction", "container-type": "container type", "service-frequency": "service frequency", "vehicle-type": "vehicle type", "contaminant-code": "contaminant code" }

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

/** A JSON object a record keeps under one of its typed keys, or {} where it keeps none or something else. */
function jsonObjectOf<T extends object>(record: BusinessRecord, key: string): T {
  const raw = record.submittedValues?.[key]
  if (typeof raw !== "string" || raw === "") return {} as T
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : ({} as T)
  } catch {
    return {} as T
  }
}

const ruleMasterIdsOf = (record: BusinessRecord): RuleMasterIds => jsonObjectOf<RuleMasterIds>(record, RULE_MASTER_IDS_KEY)

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
    // A rule's own planning area (O30 of #290): the area's record where the store holds it, its chip otherwise.
    planningAreaId: rule?.planningAreaId ? (context.resolve.byServerId(rule.planningAreaId)?.id ?? webIdOf(CHIP.area, rule.planningAreaId)) : undefined,
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

/** Where a scheme keeps how many days from tomorrow the nightly job plans it (O21 of #290): a whole number of days, as text. */
export const PLAN_AHEAD_DAYS_KEY = "planAheadDays"

/** What a window outside 1..28 is refused with before the API. */
export const PLAN_AHEAD_DAYS_REFUSAL = "The nightly job plans 1 to 28 days ahead"

/** The record's Plan Ahead window in days, undefined where it says none, or a refusal. */
function planAheadDaysOf(record: BusinessRecord): number | undefined | LocalRefusal {
  const value = record.submittedValues?.[PLAN_AHEAD_DAYS_KEY]
  if (value === undefined || value === null || value === "") return undefined
  const days = typeof value === "number" ? value : Number(value)
  return planAheadDaysAllowed(days) ? days : refusal(PLAN_AHEAD_DAYS_KEY, PLAN_AHEAD_DAYS_REFUSAL)
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
  const planAheadDays = planAheadDaysOf(record)
  if (isRefusal(planAheadDays)) return planAheadDays
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
    planAheadDays,
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
  // A rule's own planning area (O30 of #290) is said only where it has one: absent is the scheme's, as null is.
  if (group.planningAreaId === undefined) return { wasteFractionIds, containerTypeIds, vehicleTypeId }
  const planningAreaId = serverIdFor(context, CHIP.area, group.planningAreaId) ?? refusal("collectionGroups", `Pick a planning area the API holds for group ${group.name}`)
  if (isRefusal(planningAreaId)) return planningAreaId
  return { wasteFractionIds, containerTypeIds, vehicleTypeId, planningAreaId }
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
  if (containerIds.length === 0) return refusal("containerIds", "A group that picks containers picks one at least")
  return { name: group.name, days: group.days, stopSource: "manual", rule: null, containerIds, ...fleet }
}

/**
 * The rule a group was read with, by the ids the record keeps under the names
 * it spells them by (`RULE_MASTER_IDS_KEY`): what a rule the edit leaves
 * alone is restated as, so a master data row renamed since the load — or a new
 * row given an old name — moves nothing. Undefined where a name was not read
 * with an id; the caller then reads the rule by name.
 */
function ruleAsRead(group: SchemeGroup, known: RuleMasterIds): StopMatchingRule | undefined {
  const idsOf = (kind: MasterDataKind, names: readonly string[]) => names.map((name) => known[kind]?.[name])
  const wasteFractionIds = idsOf("waste-fraction", group.fractions)
  const containerTypeIds = idsOf("container-type", group.containerTypes ?? [])
  const [vehicleTypeId] = group.ruleVehicleType === undefined ? [null] : idsOf("vehicle-type", [group.ruleVehicleType])
  if (group.fractions.length === 0 || [...wasteFractionIds, ...containerTypeIds, vehicleTypeId].some((id) => id === undefined)) return undefined
  return { wasteFractionIds: wasteFractionIds as string[], containerTypeIds: containerTypeIds as string[], vehicleTypeId: vehicleTypeId ?? null }
}

/** Whether two groups' rules name the same fractions, container types and vehicle type, in the names the record spells them by; the area is restated by its id whatever this says. */
const sameRule = (a: SchemeGroup, b: SchemeGroup) =>
  JSON.stringify([a.fractions, a.containerTypes ?? [], a.ruleVehicleType ?? null]) === JSON.stringify([b.fractions, b.containerTypes ?? [], b.ruleVehicleType ?? null])

/** The web group id to server id map a record carries. */
const serverGroupIdsOf = (record: BusinessRecord) => jsonObjectOf<Record<string, string>>(record, SERVER_GROUP_IDS_KEY)

/** The server's names of a record's groups, by server id. */
const serverGroupNamesOf = (record: BusinessRecord) => jsonObjectOf<Record<string, string>>(record, SERVER_GROUP_NAMES_KEY)

/** The groups of a record, with the day list the legacy shape reads them against. */
const groupsOf = (record: BusinessRecord): ResolvedCollectionGroup[] => collectionGroupsOfRecord(record)

/**
 * What of a group an edit can move, in the record's own terms — its days, how
 * it finds its stops and what it finds them by, its fleet — compared as one
 * value, so a field added here is compared without another clause. The name
 * is weighed apart, since the legacy shape shows the scheme's in its place.
 */
const movable = (group: SchemeGroup) =>
  JSON.stringify([
    group.days,
    group.stopSource,
    group.stopSource === "rule" ? [group.fractions, group.containerTypes ?? [], group.ruleVehicleType ?? null, group.planningAreaId ?? null] : group.containerIds,
    group.serviceProviderId ?? null,
    group.vehicleId ?? null,
    group.driverId ?? null,
  ])

/**
 * The edit's `collectionGroups`, or null when no group moved, or a refusal.
 * A group is the server's when the record's id map names it; the one group of
 * the legacy shape (`default`) that the map does not name — explicit groups
 * merged back into one — is the scheme's first group. Whether a group moved is
 * decided first, in the record's terms, so an edit of the scheme alone
 * resolves nothing of its groups; once one moved, every group of `after` is
 * restated whole, since the API takes the list as the groups the edit leaves,
 * and a group the map names and `after` lacks is left out, which parks it.
 * A restated group keeps the name the server holds unless the edit gave it
 * another — the legacy shape shows the scheme's name for its one group — and
 * a rule the edit leaves alone is restated by the ids it was read with.
 */
function groupEntriesOf(before: BusinessRecord, after: BusinessRecord, context: MappingContext): CollectionGroupEntry[] | null | LocalRefusal {
  const ids = serverGroupIdsOf(before)
  const names = serverGroupNamesOf(before)
  const known = ruleMasterIdsOf(before)
  const was = groupsOf(before)
  const is = groupsOf(after)
  const wasByServerId = new Map(was.flatMap((group) => (ids[group.id] === undefined ? [] : [[ids[group.id], group] as const])))
  const firstServerId = was.map((group) => ids[group.id]).find((id) => id !== undefined)
  const serverIdOf = (group: ResolvedCollectionGroup) => ids[group.id] ?? (group.id === IMPLICIT_GROUP_ID && is.length === 1 ? firstServerId : undefined)
  const pairs = is.map((group) => {
    const serverId = serverIdOf(group)
    return { group, serverId, prior: serverId === undefined ? undefined : wasByServerId.get(serverId) }
  })
  for (const { group, prior } of pairs) {
    if (prior !== undefined && prior.stopSource !== group.stopSource) return refusal("stopSelection", STOP_SOURCE_KEPT)
  }
  // A name the legacy shape showed in the group's place — the scheme's, before or after the edit — is no name the edit gave.
  const renamed = (group: ResolvedCollectionGroup, prior: ResolvedCollectionGroup) => !group.implicit && group.name !== prior.name
  const restated = new Set(pairs.flatMap(({ serverId, prior }) => (serverId === undefined || prior === undefined ? [] : [serverId])))
  const moved =
    pairs.some(({ group, prior }) => prior === undefined || renamed(group, prior) || movable(group) !== movable(prior)) ||
    [...wasByServerId].some(([serverId, group]) => !restated.has(serverId) && group.days.length > 0)
  if (!moved) return null
  const entries: CollectionGroupEntry[] = []
  for (const { group, serverId, prior } of pairs) {
    if (serverId === undefined || prior === undefined) {
      // Added after the scheme's groups, as the editor adds one: no group is renumbered.
      const whole = groupCreateOf(group, context, known)
      if (isRefusal(whole)) return whole
      entries.push(whole)
      continue
    }
    const kept = group.stopSource === "rule" && sameRule(prior, group) ? ruleAsRead(group, known) : undefined
    const whole = groupCreateOf(group, context, known)
    if (isRefusal(whole)) return whole
    const name = renamed(group, prior) ? group.name : (names[serverId] ?? prior.name)
    // The rule as read keeps its master ids; its area is the one the edit leaves it with.
    const area = whole.rule?.planningAreaId == null ? {} : { planningAreaId: whole.rule.planningAreaId }
    entries.push({ id: serverId, ...whole, ...(kept === undefined ? {} : { rule: { ...kept, ...area } }), name })
  }
  return entries
}

const nonEmpty = <T extends object>(body: T): T | undefined => (Object.keys(body).length === 0 ? undefined : body)

/** The fields `after` says and says otherwise than `before`: `patchOf`'s rule over two readings already made. */
function changedFields(before: SchemeFields, after: SchemeFields): SchemeFields {
  const was = before as Record<string, unknown>
  return Object.fromEntries(Object.entries(after).filter(([key, value]) => value !== undefined && JSON.stringify(value) !== JSON.stringify(was[key]))) as SchemeFields
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

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

/** The scheme's archive (O21 of #290): its delete, which erases nothing. */
export const ARCHIVE_SCHEME = "archive"
/** The next version of the scheme's name, from a day (O21 of #290). */
export const SUCCEED_SCHEME = "successor"

const archiveScheme_: RecordAction<RouteSchemeArchived> = {
  // The first day the scheme no longer runs; absent, the API's tomorrow on the project's clock.
  toBody: (input) => {
    const effectiveFrom = dayOf(input.effectiveFrom)
    return (effectiveFrom === undefined ? {} : { effectiveFrom }) satisfies RouteSchemeArchive
  },
  run: (client, serverId, body) => post<RouteSchemeArchived>(client, `/route-schemes/${serverId}/archive`, body).then((answer) => answer.body),
  refused: (record) => `${record.name} was not archived`,
}

const succeedScheme_: RecordAction<RouteSchemeSuccession> = {
  toBody: (input) => {
    const validFrom = dayOf(input.validFrom)
    if (validFrom === undefined) return refusal("validFrom", "Pick the day the next version takes over")
    return { validFrom } satisfies RouteSchemeSuccessorCreate
  },
  run: (client, serverId, body) => create<RouteSchemeSuccession>(client, `/route-schemes/${serverId}/successor`, body).then((answer) => answer.body),
  refused: (record) => `No new version of ${record.name} was written`,
}

export const routeSchemeAdapter: ResourceAdapter<RouteScheme> = {
  prefix: SCHEME_PREFIX,
  auditTable: "route_scheme",
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
        "Plan ahead window": `${scheme.planAheadDays} days`,
        // An archived scheme (O21 of #290) is history: every list and planner skips it as the prototype's deleted scheme, and its routes still name it.
        ...(scheme.archivedAt === null ? {} : { Archived: scheme.archivedAt.slice(0, 10), [REGISTRY_VISIBILITY_FACT]: SOFT_DELETED }),
        ...(scheme.seasons.length === 0 ? {} : { Seasons: scheme.seasons.map((season) => season.name).join(", ") }),
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
        [PLAN_AHEAD_DAYS_KEY]: String(scheme.planAheadDays),
        ...(scheme.archivedAt === null ? {} : { archivedAt: scheme.archivedAt }),
        depotId: scheme.depotId === null ? "" : webIdFor(context, CHIP.depot, scheme.depotId),
        unloadingStationId: scheme.unloadingStationId === null ? "" : webIdFor(context, CHIP.station, scheme.unloadingStationId),
        ...groupValues,
        [SERVER_GROUP_IDS_KEY]: JSON.stringify(Object.fromEntries(running.map((group) => [webGroupIdOf.get(group.id), group.id]))),
        [SERVER_GROUP_NAMES_KEY]: JSON.stringify(Object.fromEntries(running.map((group) => [group.id, group.name]))),
        [RULE_MASTER_IDS_KEY]: JSON.stringify(ruleIds),
        // The seasons whole (O17 of #290), sent back whole when an edit moves them.
        [SCHEME_SEASONS_KEY]: seasonsValue(scheme.seasons),
        ...(scheme.generation.lastGeneratedAt === null ? {} : { lastGeneratedAt: scheme.generation.lastGeneratedAt }),
        [LAST_GENERATION_MATCHES_KEY]: serializeGenerationMatches(last),
        [PREVIOUS_GENERATION_MATCHES_KEY]: serializeGenerationMatches(previous),
        // The API's own reconciliation (O22 of #290), which the browser shows rather than judging the promises again.
        [SCHEME_API_WARNINGS_KEY]: JSON.stringify(scheme.warnings),
      },
    }
  },
  toCreateBody: (record, context) => {
    const projectWebId = typed(record, "projectId") ?? record.projectIds?.[0]
    const projectId = projectWebId === undefined ? undefined : serverIdFor(context, CHIP.project, projectWebId)
    if (projectId === undefined) return refusal("projectId", "Pick a project")
    const fields = schemeFieldsOf(record, context)
    if (isRefusal(fields)) return fields
    const { serviceType, frequency, validFrom, validTo, holidayPolicy, editPolicy, planAhead, planAheadDays, ...rest } = fields
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
    // The contract's output type says `planAhead` and its window always; on the way in, absent is the server's default.
    const body: Omit<RouteSchemeCreate, "planAhead" | "planAheadDays"> & { planAhead?: boolean; planAheadDays?: number } = {
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
      ...(planAheadDays === undefined || planAheadDays === PLAN_AHEAD_DAYS_DEFAULT ? {} : { planAheadDays }),
      status: status === "validated" ? "validated" : "draft",
      depotId: rest.depotId,
      unloadingStationId: rest.unloadingStationId,
      collectionGroups: groups,
      // The seasons whole (O17 of #290), none where the record carries none.
      seasons: storedSeasonsFromValues(record.submittedValues),
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
    const groups = groupEntriesOf(before, after, context)
    if (isRefusal(groups)) return groups
    const statusBefore = statusOf(before)
    const statusAfter = statusOf(after)
    const body: RouteSchemePatch | undefined = nonEmpty({
      ...scheme,
      ...(statusAfter === statusBefore ? {} : { status: statusAfter as RouteSchemePatch["status"] }),
      ...(groups === null ? {} : { collectionGroups: groups }),
      // The set whole where it moved; `[]` clears it.
      ...(seasonsValue(storedSeasonsFromValues(after.submittedValues)) === seasonsValue(storedSeasonsFromValues(before.submittedValues)) ? {} : { seasons: storedSeasonsFromValues(after.submittedValues) }),
    })
    return body ?? null
  },
  create: (client, body) => create<RouteScheme>(client, "/route-schemes", body).then((created) => created.body),
  // One request, the API's verdict on the whole edit: it writes all of it or none (#205).
  update: (client, serverId, body) => patch<RouteScheme>(client, `/route-schemes/${serverId}`, body),
  read: (client, serverId) => get<RouteScheme>(client, `/route-schemes/${serverId}`),
  actions: { [GENERATE_ROUTES]: generateRoutes, [ARCHIVE_SCHEME]: archiveScheme_, [SUCCEED_SCHEME]: succeedScheme_ },
}

/** A scheme's archive through the store's `sendAction`, from `effectiveFrom` or the API's tomorrow; the page reads the scheme and its routes back once it lands. */
export function archiveScheme(sendAction: SendAction, recordId: string, effectiveFrom: string | undefined): Promise<ActionOutcome<RouteSchemeArchived>> {
  return sendAction(ROUTE_SCHEMES_MODULE.workspaceId, ROUTE_SCHEMES_MODULE.moduleId, recordId, ARCHIVE_SCHEME, effectiveFrom === undefined ? {} : { effectiveFrom }, { report: false }) as Promise<ActionOutcome<RouteSchemeArchived>>
}

/** A scheme's next version from `validFrom` through the store's `sendAction`; the page reads the schemes and the routes back once it lands. */
export function succeedScheme(sendAction: SendAction, recordId: string, validFrom: string): Promise<ActionOutcome<RouteSchemeSuccession>> {
  return sendAction(ROUTE_SCHEMES_MODULE.workspaceId, ROUTE_SCHEMES_MODULE.moduleId, recordId, SUCCEED_SCHEME, { validFrom }, { report: false }) as Promise<ActionOutcome<RouteSchemeSuccession>>
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
