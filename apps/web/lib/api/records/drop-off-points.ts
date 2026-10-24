// The Drop-off Points on the prototype's records (Issue #293, M3c):
// `resources.drop-off-points`, a project's recycling centres and bring banks,
// through the generic forms. The wire shapes are the contracts'
// (`@waste/contracts/drop-off-points`), imported as types so no zod reaches
// the bundle; the routes are apps/api/src/routes/drop-off-points.ts.
//
// The form speaks the places' field ids where it can (a point's project,
// code, name, address and coordinates are a depot's), and its three sets as
// the office types them: the fractions as the master module's multiselect,
// the weekly hours and the exceptions as one text each, read and written by
// lib/data/drop-off-points.ts in the domain's own words. A save writes the
// point's own fields through `PATCH` and each set that changed through its
// own `PUT`, never a set the form left as it was — judged on the sets the
// text reads to, so text retyped to the same hours writes nothing. On the
// project's clock, an exception the point held is dropped once its day has
// passed, so the set a save replaces stays the year ahead, and one typed for
// a day gone by is refused.
import type { DropOffPoint } from "@waste/contracts/drop-off-points"
import type { OpeningException, WeeklyWindow } from "@waste/domain/resources/drop-off-points"
import { DROP_OFF_POINT_KINDS, DROP_OFF_POINT_STATUSES } from "@waste/domain/resources/vocabulary"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { DROP_OFF_KIND_OPTIONS, exceptionsOf, exceptionsText, exceptionsToSave, weeklyHoursOf, weeklyHoursText } from "@/lib/data/drop-off-points"
import { MASTER_DATA_KIND_DETAILS } from "@/lib/data/master-data-kinds"

import { create, get, listAll, patch, put } from "../client"
import { hasPrefix, inheritedPresentation, isLocalRefusal, patchOf, stampFacts, statusLabel, typed, typedFlag, webIdOf, type LocalRefusal, type MappingContext, type ResourceAdapter, type ServerModule } from "./adapter"
import { projectTimezoneOf, wallClockIn } from "./clock"
import {
  coordinatesFact,
  coordinatesOf,
  createStatusOf,
  fractionServerIdsOf,
  patchStatusOf,
  pointOf,
  projectMoved,
  projectServerIdOf,
  referenced,
  refusal,
  requiredText,
  sameSet,
  tokenOf,
  withStatus,
} from "./places"

const PREFIX = "drop-off"
/** The form's keys for the three sets. */
export const DROP_OFF_FRACTIONS_KEY = "acceptedFractionIds"
export const DROP_OFF_HOURS_KEY = "weeklyHours"
export const DROP_OFF_EXCEPTIONS_KEY = "openingExceptions"

const KIND_LABELS = Object.fromEntries(DROP_OFF_KIND_OPTIONS.map((option) => [option.value, option.label])) as Record<(typeof DROP_OFF_POINT_KINDS)[number], string>

const located = "A drop-off point has a location: give the latitude and longitude"
const keepsLocation = "A drop-off point keeps a location: give the latitude and longitude"
const codeSetOnce = "The code is set once: a point that needs another code is another point"
const projectSetOnce = "A drop-off point stays in its project: register another point in the other project"

/** The project's today, on its own clock, for the exceptions a save keeps. */
const todayFor = (record: BusinessRecord, context: MappingContext): string => wallClockIn((context.now ?? new Date()).toISOString(), projectTimezoneOf(record, context)).slice(0, 10)

/** The weekly hours the form's text names, or the refusal at the field. */
function hoursFrom(record: BusinessRecord): WeeklyWindow[] | LocalRefusal {
  const read = weeklyHoursOf(typed(record, DROP_OFF_HOURS_KEY) ?? "")
  return "message" in read ? refusal(DROP_OFF_HOURS_KEY, read.message) : read
}

/** The exceptions the form's text names, read whole; the refusal at the field. */
function exceptionsRead(record: BusinessRecord): OpeningException[] | LocalRefusal {
  const read = exceptionsOf(typed(record, DROP_OFF_EXCEPTIONS_KEY) ?? "")
  return "message" in read ? refusal(DROP_OFF_EXCEPTIONS_KEY, read.message) : read
}

/** The exceptions a save writes: from today on, those the point held (`before`) dropped once past, one typed for a day gone by refused. */
function exceptionsFrom(record: BusinessRecord, context: MappingContext, before?: BusinessRecord): OpeningException[] | LocalRefusal {
  const read = exceptionsRead(record)
  if (isLocalRefusal(read)) return read
  const was = before === undefined ? [] : exceptionsRead(before)
  const held = new Set(isLocalRefusal(was) ? [] : was.map((exception) => exception.date))
  const kept = exceptionsToSave(read, todayFor(record, context), held)
  return "message" in kept ? refusal(DROP_OFF_EXCEPTIONS_KEY, kept.message) : kept
}

/** The sets as their canonical text: two texts that read to the same set are the same set. */
const sameHours = (a: readonly WeeklyWindow[], b: readonly WeeklyWindow[]) => weeklyHoursText(a) === weeklyHoursText(b)
const sameExceptions = (a: readonly OpeningException[], b: readonly OpeningException[]) => exceptionsText(a) === exceptionsText(b)

/** What a save sends: the point's own fields, and each set that changed. */
type DropOffWrite = { point?: object; wasteFractionIds?: string[]; hours?: WeeklyWindow[]; exceptions?: OpeningException[] }

export const dropOffPointAdapter: ResourceAdapter<DropOffPoint> = {
  prefix: PREFIX,
  auditTable: "drop_off_point",
  owns: hasPrefix(PREFIX),
  statuses: DROP_OFF_POINT_STATUSES,
  list: (client) => listAll<DropOffPoint>(client, "/drop-off-points"),
  toRecord: (point, context) => {
    const project = referenced(context, "project", point.projectId)
    const fractions = point.wasteFractionIds.map((id) => referenced(context, MASTER_DATA_KIND_DETAILS["waste-fraction"].prefix, id))
    const hours = weeklyHoursText(point.hours)
    const opening = point.openAlways ? "Open always" : hours.replaceAll("\n", " · ")
    const facts: Record<string, string> = {
      Kind: KIND_LABELS[point.kind],
      Code: point.code,
      Address: point.address,
      Coordinates: coordinatesFact(point.location),
      Opening: opening === "" ? "No hours yet" : opening,
    }
    if (point.closedOnHolidays) facts.Holidays = "Closed on the project's holidays"
    if (fractions.length > 0) facts.Takes = fractions.map((fraction) => fraction.name ?? fraction.webId).join(" · ")
    if (point.exceptions.length > 0) facts.Exceptions = String(point.exceptions.length)
    if (point.publicNote !== null) facts["Public note"] = point.publicNote
    if (project.name !== undefined) facts.Project = project.name
    return {
      id: webIdOf(PREFIX, point.id),
      name: point.name,
      context: `${KIND_LABELS[point.kind]} · ${project.name ?? "Project"}`,
      status: statusLabel(point.status),
      ...inheritedPresentation(undefined),
      ...stampFacts(point, context.now),
      value: point.openAlways ? "Open always" : (hours.split("\n")[0] ?? ""),
      description: point.notes ?? "",
      facts,
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [project.webId],
      recordKind: "Drop-off Point",
      submittedValues: {
        projectId: project.webId,
        kind: point.kind,
        // The form's status field, so an edit opens on the point's own status and never on the create default.
        status: point.status,
        name: point.name,
        code: point.code,
        address: point.address,
        ...coordinatesOf(point.location),
        openAlways: point.openAlways,
        closedOnHolidays: point.closedOnHolidays,
        publicNote: point.publicNote ?? "",
        notes: point.notes ?? "",
        [DROP_OFF_FRACTIONS_KEY]: fractions.map((fraction) => fraction.webId).join(","),
        [DROP_OFF_HOURS_KEY]: hours,
        [DROP_OFF_EXCEPTIONS_KEY]: exceptionsText(point.exceptions),
      },
    }
  },
  toCreateBody: (record, context) => {
    const projectId = projectServerIdOf(record, context)
    if (isLocalRefusal(projectId)) return projectId
    const code = requiredText(record, "code", "A drop-off point", "a code")
    if (isLocalRefusal(code)) return code
    const name = requiredText(record, "name", "A drop-off point", "a name")
    if (isLocalRefusal(name)) return name
    const kind = tokenOf(record, "kind", DROP_OFF_POINT_KINDS, "kind", "a drop-off point") ?? refusal("kind", "Say what kind of point it is: a recycling centre or a bring bank")
    if (isLocalRefusal(kind)) return kind
    const address = requiredText(record, "address", "A drop-off point", "an address")
    if (isLocalRefusal(address)) return address
    const location = pointOf(record, located)
    if (isLocalRefusal(location)) return location
    if (location === null) return refusal("latitude", located)
    const wasteFractionIds = fractionServerIdsOf(record, DROP_OFF_FRACTIONS_KEY, context)
    if (isLocalRefusal(wasteFractionIds)) return wasteFractionIds
    const hours = hoursFrom(record)
    if (isLocalRefusal(hours)) return hours
    const exceptions = exceptionsFrom(record, context)
    if (isLocalRefusal(exceptions)) return exceptions
    const status = createStatusOf(record, DROP_OFF_POINT_STATUSES, "a drop-off point")
    if (isLocalRefusal(status)) return status
    const publicNote = typed(record, "publicNote")
    const notes = typed(record, "notes")
    return {
      projectId,
      code,
      name,
      kind,
      address,
      location,
      openAlways: typedFlag(record, "openAlways") ?? false,
      closedOnHolidays: typedFlag(record, "closedOnHolidays") ?? false,
      ...(publicNote === undefined ? {} : { publicNote }),
      ...(notes === undefined ? {} : { notes }),
      ...(status === undefined ? {} : { status }),
      wasteFractionIds,
      hours,
      exceptions,
    }
  },
  toPatchBody: (before, after, context) => {
    if (projectMoved(before, after)) return refusal("projectId", projectSetOnce)
    if (typed(after, "code") !== typed(before, "code")) return refusal("code", codeSetOnce)
    const location = pointOf(after, keepsLocation)
    if (isLocalRefusal(location)) return location
    if (location === null) return refusal("latitude", keepsLocation)
    const kind = tokenOf(after, "kind", DROP_OFF_POINT_KINDS, "kind", "a drop-off point")
    if (isLocalRefusal(kind)) return kind
    const status = patchStatusOf(before, after, DROP_OFF_POINT_STATUSES, "a drop-off point")
    if (isLocalRefusal(status)) return status
    const isFractions = fractionServerIdsOf(after, DROP_OFF_FRACTIONS_KEY, context)
    if (isLocalRefusal(isFractions)) return isFractions
    const wasFractions = fractionServerIdsOf(before, DROP_OFF_FRACTIONS_KEY, context)
    const hours = hoursFrom(after)
    if (isLocalRefusal(hours)) return hours
    const exceptions = exceptionsFrom(after, context, before)
    if (isLocalRefusal(exceptions)) return exceptions
    const wasHours = hoursFrom(before)
    const wasExceptions = exceptionsFrom(before, context, before)
    const pointBody = withStatus(
      patchOf(before, after, (record) => {
        const at = pointOf(record, "")
        return {
          name: typed(record, "name") ?? record.name,
          kind: typed(record, "kind"),
          address: typed(record, "address"),
          location: isLocalRefusal(at) || at === null ? undefined : at,
          openAlways: typedFlag(record, "openAlways"),
          closedOnHolidays: typedFlag(record, "closedOnHolidays"),
          publicNote: typed(record, "publicNote") ?? null,
          notes: typed(record, "notes") ?? null,
        }
      }),
      before,
      status,
      DROP_OFF_POINT_STATUSES,
    )
    // Each set is written only where the form changed what it reads to: a set read and saved unchanged, or retyped to the same, writes nothing.
    const wasIds = isLocalRefusal(wasFractions) ? undefined : wasFractions
    const write: DropOffWrite = {
      ...(pointBody === null ? {} : { point: pointBody }),
      ...(wasIds !== undefined && sameSet(wasIds, isFractions) ? {} : { wasteFractionIds: isFractions }),
      ...(!isLocalRefusal(wasHours) && sameHours(wasHours, hours) ? {} : { hours }),
      ...(!isLocalRefusal(wasExceptions) && sameExceptions(wasExceptions, exceptions) ? {} : { exceptions }),
    }
    return Object.keys(write).length === 0 ? null : write
  },
  create: (client, body) => create<DropOffPoint>(client, "/drop-off-points", body).then((created) => created.body),
  // The point first, then each set through its own route; the answer is the point as it now stands.
  update: async (client, serverId, body) => {
    const write = body as DropOffWrite
    let point: DropOffPoint | undefined
    if (write.point !== undefined) point = await patch<DropOffPoint>(client, `/drop-off-points/${serverId}`, write.point)
    if (write.wasteFractionIds !== undefined) point = await put<DropOffPoint>(client, `/drop-off-points/${serverId}/fractions`, { wasteFractionIds: write.wasteFractionIds })
    if (write.hours !== undefined) point = await put<DropOffPoint>(client, `/drop-off-points/${serverId}/hours`, { hours: write.hours })
    if (write.exceptions !== undefined) point = await put<DropOffPoint>(client, `/drop-off-points/${serverId}/exceptions`, { exceptions: write.exceptions })
    return point ?? (await get<DropOffPoint>(client, `/drop-off-points/${serverId}`))
  },
  read: (client, serverId) => get<DropOffPoint>(client, `/drop-off-points/${serverId}`),
}

export const dropOffPointsModule: ServerModule = {
  workspaceId: "resources",
  moduleId: "drop-off-points",
  resources: [dropOffPointAdapter],
}
