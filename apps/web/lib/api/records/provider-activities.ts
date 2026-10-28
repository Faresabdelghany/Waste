// Service Providers › Activities on the API (#474): one item of coordination
// between the office and one provider, `provider-activity-<uuid>` from the
// start. The record names the provider, the award, the scheme and the version
// an approval wrote through the store's resolver — their chips where the
// reader does not read their module, as a provider reads no scheme — and
// reads an open follow-up overdue on its project's day. A create is opened
// from what the dialog picked: a proposal from a route of its group, which
// names the project, the scheme and the group; a follow-up or a note from its
// award's project, or the project the office picked. The status moves by
// command alone (approve, reject, withdraw, complete, cancel), so the adapter
// lists no statuses; a patch corrects an open Activity's own words, a
// route-day change's days, a vehicle change's vehicle and driver, a stop-set
// change's containers, a waste-fraction change's fractions, a proposal's day,
// a follow-up's due day. The words and forms are
// lib/data/provider-activities.ts'; the routes are
// apps/api/src/routes/service-provider-activities.ts.
import type { ServiceProviderActivity, ServiceProviderActivityCreate, ServiceProviderActivityPatch } from "@waste/contracts/service-provider-activities"
import type { ServiceDay } from "@waste/domain/planning/vocabulary"
import { SERVICE_DAYS } from "@waste/domain/planning/vocabulary"
import { activityLabel, activityReading } from "@waste/domain/service-providers/activities"
import { splitList } from "@waste/domain/record-values"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { ACTIVITY_KIND_KEY, ACTIVITY_PREFIX, ACTIVITY_RECORD_KIND, ACTIVITY_STATUS_KEY, closeBodyOf, daysText, kindLabel, PROVIDER_ACTIVITIES_MODULE, rejectBodyOf } from "@/lib/data/provider-activities"
import type { BusinessFormValues } from "@/lib/data/business-form-types"

import { command, create, get, listAll, patch } from "../client"
import { isLocalRefusal, ofKind, stampFacts, statusLabel, typed, webIdOf, type LocalRefusal, type MappingContext, type RecordCommand, type ResourceAdapter, type ServerModule } from "./adapter"
import { dayIn } from "./planning"
import { refusal } from "./places"
import { nameVia, referencedServerId, webIdVia } from "./references"

const PROVIDER_PREFIX = "service-provider"
const AREA_PREFIX = "service-area"
const PROJECT_PREFIX = "project"
const SCHEME_PREFIX = "scheme"
const GROUP_PREFIX = "group"
const VEHICLE_PREFIX = "vehicle"
const DRIVER_PREFIX = "driver"
const CONTAINER_PREFIX = "asset"
const FRACTION_PREFIX = "fraction"

/** The schemes and the routes an approval changes: read again once the API took it. */
const SCHEMES_KEY = "route-studio.schemes"
const ROUTES_KEY = "route-studio.routes"

export function toActivityRecord(activity: ServiceProviderActivity, context: MappingContext): BusinessRecord {
  const project = context.resolve.byServerId(activity.projectId)
  const projectWebId = project?.id ?? webIdVia(context, PROJECT_PREFIX, activity.projectId)
  const timezone = project === undefined ? undefined : typed(project, "timezone")
  const provider = nameVia(context, PROVIDER_PREFIX, activity.serviceProviderId)
  const label = activityLabel(activity.number)
  const reading = activityReading(activity, dayIn(context.now ?? new Date(), timezone))
  const facts: Record<string, string> = {
    Number: label,
    Kind: kindLabel(activity.kind),
    "Service provider": provider,
    ...(activity.serviceAreaId === null ? {} : { "Service area": nameVia(context, AREA_PREFIX, activity.serviceAreaId) }),
    ...(activity.routeSchemeId === null ? {} : { "Route scheme": nameVia(context, SCHEME_PREFIX, activity.routeSchemeId) }),
    ...(activity.serviceDays === null ? {} : { "New days": daysText(activity.serviceDays) }),
    ...(activity.vehicleId === null ? {} : { "New vehicle": nameVia(context, VEHICLE_PREFIX, activity.vehicleId) }),
    ...(activity.driverId === null ? {} : { "New driver": nameVia(context, DRIVER_PREFIX, activity.driverId) }),
    ...(activity.containerIds === null ? {} : { "New stops": activity.containerIds.map((id) => nameVia(context, CONTAINER_PREFIX, id)).join(" → ") }),
    ...(activity.wasteFractionIds === null ? {} : { "New fractions": activity.wasteFractionIds.map((id) => nameVia(context, FRACTION_PREFIX, id)).join(" · ") }),
    ...(activity.effectiveFrom === null ? {} : { From: activity.effectiveFrom }),
    ...(activity.dueOn === null ? {} : { Due: activity.dueOn }),
    ...(activity.successorSchemeId === null ? {} : { "New version": nameVia(context, SCHEME_PREFIX, activity.successorSchemeId) }),
    ...(activity.closedAt === null ? {} : { Closed: dayIn(new Date(activity.closedAt), timezone) }),
    ...(activity.closeReason === null ? {} : { Reason: activity.closeReason }),
    ...(project?.name === undefined ? {} : { Project: project.name }),
  }
  return {
    id: webIdOf(ACTIVITY_PREFIX, activity.id),
    name: `${label} · ${activity.subject}`,
    context: [provider, facts["Service area"]].filter((part) => part !== undefined).join(" · "),
    status: statusLabel(activity.status),
    owner: "",
    value: kindLabel(activity.kind),
    description: activity.body ?? "",
    related: [],
    ...stampFacts(activity, context.now),
    facts: { ...facts, Reading: reading },
    companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
    projectIds: [projectWebId],
    recordKind: ACTIVITY_RECORD_KIND,
    submittedValues: {
      projectId: projectWebId,
      [ACTIVITY_KIND_KEY]: activity.kind,
      [ACTIVITY_STATUS_KEY]: activity.status,
      serviceProviderId: webIdVia(context, PROVIDER_PREFIX, activity.serviceProviderId),
      serviceAreaId: activity.serviceAreaId === null ? "" : webIdVia(context, AREA_PREFIX, activity.serviceAreaId),
      subject: activity.subject,
      body: activity.body ?? "",
      dueOn: activity.dueOn ?? "",
      serviceDays: activity.serviceDays?.join(",") ?? "",
      effectiveFrom: activity.effectiveFrom ?? "",
      vehicleId: activity.vehicleId === null ? "" : webIdVia(context, VEHICLE_PREFIX, activity.vehicleId),
      driverId: activity.driverId === null ? "" : webIdVia(context, DRIVER_PREFIX, activity.driverId),
      containerIds: activity.containerIds?.map((id) => webIdVia(context, CONTAINER_PREFIX, id)).join(",") ?? "",
      wasteFractionIds: activity.wasteFractionIds?.map((id) => webIdVia(context, FRACTION_PREFIX, id)).join(",") ?? "",
    },
  }
}

const KIND_REFUSED = "Pick what kind of activity it is"
const ROUTE_REFUSED = "Pick a route of the group the change is about"
const DAYS_REFUSED = "Pick the days the group should run on"
const PROVIDER_REFUSED = "Pick the service provider"
const PROJECT_REFUSED = "Pick the service area it is about, or the project"
const AREA_REFUSED = "Pick a service area the API holds"
const VEHICLE_REFUSED = "Pick the vehicle the group should run with"
const DRIVER_REFUSED = "Pick a driver the API holds"
const STOPS_REFUSED = "Pick the containers the group should run on"
const FRACTIONS_REFUSED = "Pick the waste fractions the group's rule should collect"

/** The rows a form's multiselect names under `key`, in the order picked, as server ids; undefined for none, a refusal for one the API does not hold. */
function listOf(record: BusinessRecord, key: string, prefix: string, context: MappingContext, refused: string): string[] | undefined | LocalRefusal {
  const webIds = splitList(typed(record, key))
  if (webIds.length === 0) return undefined
  const ids: string[] = []
  for (const webId of webIds) {
    const id = referencedServerId(webId, prefix, context)
    if (id === undefined) return refusal(key, refused)
    ids.push(id)
  }
  return ids
}

/** The containers a form names, in the order picked. */
const containersOf = (record: BusinessRecord, context: MappingContext) => listOf(record, "containerIds", CONTAINER_PREFIX, context, STOPS_REFUSED)

/** The days a form names, each a weekday, Monday first; undefined for none, a refusal for a word that is no day. */
function daysOf(record: BusinessRecord, key: string): ServiceDay[] | undefined | LocalRefusal {
  const days = splitList(typed(record, key))
  if (days.length === 0) return undefined
  if (days.some((day) => !(SERVICE_DAYS as readonly string[]).includes(day))) return refusal(key, DAYS_REFUSED)
  return SERVICE_DAYS.filter((day) => days.includes(day))
}

/** A server id a record names under `key` by web id: the loaded row's, or its chip's; undefined when blank, a refusal when it is neither. */
function serverIdAt(record: BusinessRecord, key: string, prefix: string, context: MappingContext, refused: string): string | undefined | LocalRefusal {
  const webId = typed(record, key)
  if (webId === undefined) return undefined
  return referencedServerId(webId, prefix, context) ?? refusal(key, refused)
}

/** What a create is about: a proposal's route's project, scheme and group, or a follow-up's or a note's award's project or the picked project. */
function subjectOf(record: BusinessRecord, kind: ServiceProviderActivityCreate["kind"], context: MappingContext) {
  if (kind === "route-day-change" || kind === "vehicle-change" || kind === "stop-set-change" || kind === "waste-fraction-change") {
    const routeId = typed(record, "routeId")
    const route = routeId === undefined ? undefined : context.resolve.find((candidate) => candidate.id === routeId)
    if (route === undefined) return refusal("routeId", ROUTE_REFUSED)
    const projectId = serverIdAt(route, "projectId", PROJECT_PREFIX, context, ROUTE_REFUSED)
    const routeSchemeId = serverIdAt(route, "schemeId", SCHEME_PREFIX, context, ROUTE_REFUSED)
    const collectionGroupId = serverIdAt(route, "collectionGroupId", GROUP_PREFIX, context, ROUTE_REFUSED)
    for (const id of [projectId, routeSchemeId, collectionGroupId]) if (id === undefined || isLocalRefusal(id)) return refusal("routeId", ROUTE_REFUSED)
    return { projectId: projectId as string, routeSchemeId: routeSchemeId as string, collectionGroupId: collectionGroupId as string, serviceAreaId: undefined }
  }
  const serviceAreaId = serverIdAt(record, "serviceAreaId", AREA_PREFIX, context, AREA_REFUSED)
  if (isLocalRefusal(serviceAreaId)) return serviceAreaId
  const areaWebId = typed(record, "serviceAreaId")
  const area = areaWebId === undefined ? undefined : context.resolve.find((candidate) => candidate.id === areaWebId)
  const projectKey = area === undefined ? record : area
  const projectId = serverIdAt(projectKey, "projectId", PROJECT_PREFIX, context, PROJECT_REFUSED) ?? refusal("projectId", PROJECT_REFUSED)
  if (isLocalRefusal(projectId)) return projectId
  return { projectId, serviceAreaId }
}

export function toActivityCreateBody(record: BusinessRecord, context: MappingContext): ServiceProviderActivityCreate | LocalRefusal {
  const kind = typed(record, ACTIVITY_KIND_KEY)
  if (kind !== "route-day-change" && kind !== "vehicle-change" && kind !== "stop-set-change" && kind !== "waste-fraction-change" && kind !== "compliance-follow-up" && kind !== "coordination-note") return refusal("kind", KIND_REFUSED)
  const serviceProviderId = serverIdAt(record, "serviceProviderId", PROVIDER_PREFIX, context, PROVIDER_REFUSED) ?? refusal("serviceProviderId", PROVIDER_REFUSED)
  if (isLocalRefusal(serviceProviderId)) return serviceProviderId
  const subject = typed(record, "subject")
  if (subject === undefined) return refusal("subject", "An activity needs a subject")
  const about = subjectOf(record, kind, context)
  if (isLocalRefusal(about)) return about
  const base = { projectId: about.projectId, serviceProviderId, subject, ...(typed(record, "body") === undefined ? {} : { body: typed(record, "body") }) }
  if (kind === "route-day-change") {
    const serviceDays = daysOf(record, "serviceDays") ?? refusal("serviceDays", DAYS_REFUSED)
    if (isLocalRefusal(serviceDays)) return serviceDays
    const effectiveFrom = typed(record, "effectiveFrom")
    if (effectiveFrom === undefined) return refusal("effectiveFrom", "Pick the first day the group runs on its new days")
    return { ...base, kind, routeSchemeId: about.routeSchemeId as string, collectionGroupId: about.collectionGroupId as string, serviceDays, effectiveFrom }
  }
  if (kind === "vehicle-change") {
    const vehicleId = serverIdAt(record, "vehicleId", VEHICLE_PREFIX, context, VEHICLE_REFUSED) ?? refusal("vehicleId", VEHICLE_REFUSED)
    if (isLocalRefusal(vehicleId)) return vehicleId
    const driverId = serverIdAt(record, "driverId", DRIVER_PREFIX, context, DRIVER_REFUSED)
    if (isLocalRefusal(driverId)) return driverId
    const effectiveFrom = typed(record, "effectiveFrom")
    if (effectiveFrom === undefined) return refusal("effectiveFrom", "Pick the first day the group runs with the vehicle")
    return { ...base, kind, routeSchemeId: about.routeSchemeId as string, collectionGroupId: about.collectionGroupId as string, vehicleId, ...(driverId === undefined ? {} : { driverId }), effectiveFrom }
  }
  if (kind === "stop-set-change") {
    const containerIds = containersOf(record, context) ?? refusal("containerIds", STOPS_REFUSED)
    if (isLocalRefusal(containerIds)) return containerIds
    const effectiveFrom = typed(record, "effectiveFrom")
    if (effectiveFrom === undefined) return refusal("effectiveFrom", "Pick the first day the group runs on its new stops")
    return { ...base, kind, routeSchemeId: about.routeSchemeId as string, collectionGroupId: about.collectionGroupId as string, containerIds, effectiveFrom }
  }
  if (kind === "waste-fraction-change") {
    const wasteFractionIds = listOf(record, "wasteFractionIds", FRACTION_PREFIX, context, FRACTIONS_REFUSED) ?? refusal("wasteFractionIds", FRACTIONS_REFUSED)
    if (isLocalRefusal(wasteFractionIds)) return wasteFractionIds
    const effectiveFrom = typed(record, "effectiveFrom")
    if (effectiveFrom === undefined) return refusal("effectiveFrom", "Pick the first day the rule collects its new fractions")
    return { ...base, kind, routeSchemeId: about.routeSchemeId as string, collectionGroupId: about.collectionGroupId as string, wasteFractionIds, effectiveFrom }
  }
  const area = about.serviceAreaId === undefined ? {} : { serviceAreaId: about.serviceAreaId }
  if (kind === "compliance-follow-up") {
    const dueOn = typed(record, "dueOn")
    if (dueOn === undefined) return refusal("dueOn", "Pick the day the follow-up is due")
    return { ...base, ...area, kind, dueOn }
  }
  return { ...base, ...area, kind }
}

/** A correction: the words, a proposal's days and day, a follow-up's due day, each where it moved. */
export function toActivityPatchBody(before: BusinessRecord, after: BusinessRecord, context: MappingContext): ServiceProviderActivityPatch | null | LocalRefusal {
  const kind = typed(before, ACTIVITY_KIND_KEY)
  const body: ServiceProviderActivityPatch = {}
  const moved = (key: string) => (typed(after, key) ?? "") !== (typed(before, key) ?? "")
  if (moved("subject")) {
    const subject = typed(after, "subject")
    if (subject === undefined) return refusal("subject", "An activity needs a subject")
    body.subject = subject
  }
  if (moved("body")) body.body = typed(after, "body") ?? null
  if (kind === "route-day-change" && moved("serviceDays")) {
    const days = daysOf(after, "serviceDays") ?? refusal("serviceDays", DAYS_REFUSED)
    if (isLocalRefusal(days)) return days
    body.serviceDays = days
  }
  if (kind === "vehicle-change" && moved("vehicleId")) {
    const vehicleId = serverIdAt(after, "vehicleId", VEHICLE_PREFIX, context, VEHICLE_REFUSED) ?? refusal("vehicleId", VEHICLE_REFUSED)
    if (isLocalRefusal(vehicleId)) return vehicleId
    body.vehicleId = vehicleId
  }
  if (kind === "vehicle-change" && moved("driverId")) {
    const driverId = serverIdAt(after, "driverId", DRIVER_PREFIX, context, DRIVER_REFUSED)
    if (isLocalRefusal(driverId)) return driverId
    body.driverId = driverId ?? null
  }
  if (kind === "stop-set-change" && moved("containerIds")) {
    const containerIds = containersOf(after, context) ?? refusal("containerIds", STOPS_REFUSED)
    if (isLocalRefusal(containerIds)) return containerIds
    body.containerIds = containerIds
  }
  if (kind === "waste-fraction-change" && moved("wasteFractionIds")) {
    const wasteFractionIds = listOf(after, "wasteFractionIds", FRACTION_PREFIX, context, FRACTIONS_REFUSED) ?? refusal("wasteFractionIds", FRACTIONS_REFUSED)
    if (isLocalRefusal(wasteFractionIds)) return wasteFractionIds
    body.wasteFractionIds = wasteFractionIds
  }
  if ((kind === "route-day-change" || kind === "vehicle-change" || kind === "stop-set-change" || kind === "waste-fraction-change") && moved("effectiveFrom")) {
    const day = typed(after, "effectiveFrom")
    if (day === undefined) return refusal("effectiveFrom", "Pick the first day the group runs on its new days")
    body.effectiveFrom = day
  }
  if (kind === "compliance-follow-up" && moved("dueOn")) {
    const day = typed(after, "dueOn")
    if (day === undefined) return refusal("dueOn", "Pick the day the follow-up is due")
    body.dueOn = day
  }
  return Object.keys(body).length === 0 ? null : body
}

export const APPROVE_ACTIVITY = "approve"
export const REJECT_ACTIVITY = "reject"
export const WITHDRAW_ACTIVITY = "withdraw"
export const COMPLETE_ACTIVITY = "complete"
export const CANCEL_ACTIVITY = "cancel"

const closing = (name: string, refused: string, touches?: readonly string[]): RecordCommand<ServiceProviderActivity> => ({
  toBody: (input) => (name === REJECT_ACTIVITY ? rejectBodyOf(input as BusinessFormValues) : closeBodyOf(input as BusinessFormValues)),
  run: (client, serverId, body) => command<ServiceProviderActivity>(client, `/service-provider-activities/${serverId}/${name}`, body ?? {}),
  refused: (record) => `${record.name} ${refused}`,
  ...(touches === undefined ? {} : { touches }),
})

export const ACTIVITY_COMMANDS: Readonly<Record<string, RecordCommand<ServiceProviderActivity>>> = {
  // An approval writes the scheme's next version and ends the predecessor's routes from its day.
  [APPROVE_ACTIVITY]: closing(APPROVE_ACTIVITY, "was not approved", [SCHEMES_KEY, ROUTES_KEY]),
  [REJECT_ACTIVITY]: closing(REJECT_ACTIVITY, "was not rejected"),
  [WITHDRAW_ACTIVITY]: closing(WITHDRAW_ACTIVITY, "was not withdrawn"),
  [COMPLETE_ACTIVITY]: closing(COMPLETE_ACTIVITY, "was not completed"),
  [CANCEL_ACTIVITY]: closing(CANCEL_ACTIVITY, "was not cancelled"),
}

export const activityAdapter: ResourceAdapter<ServiceProviderActivity> = {
  prefix: ACTIVITY_PREFIX,
  auditTable: "service_provider_activity",
  // A row the workspace has just made is `activities-provider-activity-<clock>` until the server answers: owned by its recordKind.
  owns: ofKind(ACTIVITY_PREFIX, [ACTIVITY_RECORD_KIND]),
  statuses: undefined,
  list: (client) => listAll<ServiceProviderActivity>(client, "/service-provider-activities"),
  toRecord: toActivityRecord,
  toCreateBody: toActivityCreateBody,
  toPatchBody: toActivityPatchBody,
  create: (client, body) => create<ServiceProviderActivity>(client, "/service-provider-activities", body).then((created) => created.body),
  update: (client, serverId, body) => patch<ServiceProviderActivity>(client, `/service-provider-activities/${serverId}`, body),
  read: (client, serverId) => get<ServiceProviderActivity>(client, `/service-provider-activities/${serverId}`),
  commands: ACTIVITY_COMMANDS,
}

/** Service Providers › Activities: read after the providers, the awards, the schemes and the routes they name; an open follow-up is overdue by its project's day. */
export const providerActivitiesModule: ServerModule = {
  workspaceId: PROVIDER_ACTIVITIES_MODULE.workspaceId,
  moduleId: PROVIDER_ACTIVITIES_MODULE.moduleId,
  resources: [activityAdapter],
  readsTheDay: true,
}
