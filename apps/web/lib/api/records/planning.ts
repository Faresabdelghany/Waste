// Planning configuration on the prototype's records (Issue #175, slice 1 of
// #81): the planning areas as the `configure.areas` module and the collection
// calendars as `configure.calendars`, the two Settings panes' modules, which
// the map, the wizard and generation read by module. The wire shapes are the
// contracts' (`@waste/contracts/planning-areas`, `collection-calendars`),
// imported as types so no zod reaches the bundle; the routes are
// apps/api/src/routes/{planning-areas,collection-calendars}.ts.
//
// An area is two resources on the wire — the identity, and effective-dated
// boundary versions of its outline (ADR-0005) — and one record here: the
// read lists both and files every version under its area, and the record
// carries the version in force on the day as its geometry (a GeoJSON
// Polygon on `submittedValues.geometry`, which the map draws as it stands:
// @waste/domain/map-planning/areas, `storedOutline`), its dates, and the
// version's id, so an edit patches that version. The record's status is a
// reading of the versions against the day, as the contracts say it is:
// Active with one in force, Upcoming with only a later one, Expired with
// only ended ones, Draft with none — no status is on the wire, so the store
// refuses every move. A period's end is spelled two ways: the wire's
// `validTo` is the first day out of force (half-open, ADR-0005), the form's
// "Effective to" and "Valid to" the last day in, as every fixture end date
// reads; the adapter adds a day on the way out and takes one on the way in.
//
// The polygon a form's geometry text spells is closed here, as the contracts'
// header says the web adapter does: a GeoJSON Polygon or a Feature around
// one, or a list of `[lng, lat]` pairs or `{ lng, lat }` spots, becomes one
// closed flat ring at six decimals; text that is none of those is a note,
// and the area is registered undrawn, to be drawn later. The reference (the
// code) is set once and the project does not move, so a change to either is
// refused before the API, in its own words.
//
// A calendar travels with its holidays, replaced whole through their own
// route; the record spells them as the readers do — `holidayDates` as the
// dates and `holidayNames` as the names, the shape the Holiday lists pane
// writes — and a write names each day from the record's carried names,
// then from the project's holiday list, then not at all.
//
// Ids. A seeded area keeps its fixture's id (`area-indreby`), since the
// fixtures of modules still on the browser's path — containers, schemes,
// service areas — name areas by it; the mapping goes when those switch. A
// calendar is `calendar-<uuid>` from the start: nothing names a calendar by
// id — a project's calendars are found by project — so the fixture-id
// mapping retires here, as the plan on #81 has it.
import type { CollectionCalendar, CollectionCalendarHoliday } from "@waste/contracts/collection-calendars"
import type { FlatPolygon, Position2D } from "@waste/contracts/geojson"
import type { PlanningArea, PlanningAreaBoundary, PlanningAreaCreated } from "@waste/contracts/planning-areas"
import { PLANNING_AREA_PURPOSES, type PlanningAreaPurpose } from "@waste/domain/planning/vocabulary"
import { parseHolidayDates } from "@waste/domain/route-schemes/calendar"
import { holidayNamesFor } from "@waste/domain/route-schemes/holiday-names"
import { HOLIDAY_NAMES_KEY, parseHolidayNames, serializeHolidayNames } from "@waste/domain/route-schemes/holidays"
import { projectHolidayListName } from "@waste/domain/route-schemes/project-calendar"
import { addDays } from "@waste/domain/route-schemes/recurrence"

import { FIXTURE_COMPANY_ID, type BusinessRecord } from "@/lib/data/business-modules"
import { COLLECTION_CALENDARS_MODULE } from "@/lib/data/collection-calendars"
import { PLANNING_AREAS_MODULE, planningAreaPurposeOptions } from "@/lib/data/planning-areas"

import { create, get, listAll, patch, put } from "../client"
import {
  fixtureNamed,
  inheritedPresentation,
  ofKind,
  patchOf,
  stampFacts,
  typed,
  webIdOf,
  type Client,
  type LocalRefusal,
  type ResourceAdapter,
  type ServerModule,
} from "./adapter"

const refusal = (path: string, message: string): LocalRefusal => ({ path, message })

/** Whether a typed form value differs between two records. */
const changedTyped = (before: BusinessRecord, after: BusinessRecord, key: string) => typed(before, key) !== typed(after, key)

/** The day as the browser's calendar has it: a stamp is presentation, and the version in force is read on the person's day. */
function localDay(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0")
  const day = String(now.getDate()).padStart(2, "0")
  return `${now.getFullYear()}-${month}-${day}`
}

/** The form's last day in force from the wire's first day out (half-open), and back. */
const lastDayIn = (firstDayOut: string) => addDays(firstDayOut, -1)
const firstDayOut = (lastDayIn: string) => addDays(lastDayIn, 1)

// ---------------------------------------------------------------------------
// The polygon a form's geometry text spells
// ---------------------------------------------------------------------------

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6

function positionOf(value: unknown): Position2D | undefined {
  if (Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number") return [round6(value[0]), round6(value[1])]
  if (value && typeof value === "object") {
    const spot = value as { lng?: unknown; lat?: unknown }
    if (typeof spot.lng === "number" && typeof spot.lat === "number") return [round6(spot.lng), round6(spot.lat)]
  }
  return undefined
}

/** A ring closed on its first position, with three distinct positions at least; undefined for anything less. */
function closedRing(positions: readonly (Position2D | undefined)[]): Position2D[] | undefined {
  if (positions.some((position) => position === undefined)) return undefined
  const ring = positions as Position2D[]
  const same = (a: Position2D, b: Position2D) => a[0] === b[0] && a[1] === b[1]
  const open = ring.length >= 2 && same(ring[0], ring[ring.length - 1]) ? ring.slice(0, -1) : ring
  if (new Set(open.map((position) => position.join(","))).size < 3) return undefined
  return [...open, open[0]]
}

function ringOf(value: unknown): Position2D[] | undefined {
  if (Array.isArray(value)) return closedRing(value.map(positionOf))
  if (!value || typeof value !== "object") return undefined
  const shape = value as { type?: unknown; coordinates?: unknown; geometry?: unknown }
  if (shape.type === "Feature") return ringOf(shape.geometry)
  if (shape.type === "Polygon" && Array.isArray(shape.coordinates) && Array.isArray(shape.coordinates[0])) {
    return closedRing((shape.coordinates[0] as unknown[]).map(positionOf))
  }
  return undefined
}

/**
 * The flat polygon a form's geometry text spells — a GeoJSON Polygon, a
 * Feature around one, a list of `[lng, lat]` pairs or of `{ lng, lat }` spots
 * — closed on its first position at six decimals, the decimetre the
 * Registry's points keep; undefined for text that is no polygon.
 */
export function parsePolygonText(text: string | undefined): FlatPolygon | undefined {
  if (text === undefined || text.trim() === "") return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  const ring = ringOf(parsed)
  return ring === undefined ? undefined : { type: "Polygon", coordinates: [ring] }
}

// ---------------------------------------------------------------------------
// Planning areas
// ---------------------------------------------------------------------------

/** An area with every boundary version the API holds for it: what the read lists and a write answers. */
export type PlanningAreaResource = PlanningArea & { boundaries: PlanningAreaBoundary[] }

/** The record's status as a reading of the versions against the day, and the version it reads. */
export function versionInForce(boundaries: readonly PlanningAreaBoundary[], day: string): { status: "Draft" | "Active" | "Upcoming" | "Expired"; version: PlanningAreaBoundary | null } {
  const inForce = boundaries.find((version) => version.validFrom <= day && (version.validTo === null || day < version.validTo))
  if (inForce) return { status: "Active", version: inForce }
  const upcoming = boundaries.filter((version) => version.validFrom > day).sort((a, b) => a.validFrom.localeCompare(b.validFrom))[0]
  if (upcoming) return { status: "Upcoming", version: upcoming }
  const ended = [...boundaries].sort((a, b) => b.validFrom.localeCompare(a.validFrom))[0]
  if (ended) return { status: "Expired", version: ended }
  return { status: "Draft", version: null }
}

const isPurpose = (value: string): value is PlanningAreaPurpose => (PLANNING_AREA_PURPOSES as readonly string[]).includes(value)

/** `Route planning`, the form's own label for the wire's token. */
const purposeLabel = (purpose: string) => planningAreaPurposeOptions().find((option) => option.value === purpose)?.label ?? purpose

/** The first version a create carries, or a version added later: the polygon, its start, and its end as the first day out. */
function boundaryCreateOf(record: BusinessRecord, polygon: FlatPolygon): { boundary: FlatPolygon; validFrom: string; validTo?: string } | LocalRefusal {
  const from = typed(record, "effectiveFrom")
  if (!from) return refusal("effectiveFrom", "A drawn area needs the day its boundary comes into force")
  const to = typed(record, "effectiveTo")
  return { boundary: polygon, validFrom: from, ...(to === undefined ? {} : { validTo: firstDayOut(to) }) }
}

/** What an area's update carries: a patch of the area, and one of the version in force or a first version, each to its own route. */
type PlanningAreaWrite = {
  area?: { name?: string; purpose?: string }
  boundary?: { id: string; patch: { boundary?: FlatPolygon; validTo?: string | null } } | { create: { boundary: FlatPolygon; validFrom: string; validTo?: string } }
}

export const planningAreaAdapter: ResourceAdapter<PlanningAreaResource> = {
  prefix: "area",
  owns: ofKind("area", ["Operational Planning Area version"]),
  // No status on the wire: the record's is a reading of its versions, and every move the lifecycle offers is refused.
  statuses: undefined,
  list: async (client) => {
    const [areas, boundaries] = await Promise.all([listAll<PlanningArea>(client, "/planning-areas"), listAll<PlanningAreaBoundary>(client, "/planning-area-boundaries")])
    return areas.map((area) => ({ ...area, boundaries: boundaries.filter((version) => version.planningAreaId === area.id) }))
  },
  toRecord: (area, context) => {
    const fixture = fixtureNamed(context.fixtures, "area", [area.name])
    const project = context.resolve.byServerId(area.projectId)
    const projectWebId = project?.id ?? webIdOf("project", area.projectId)
    const { status, version } = versionInForce(area.boundaries, localDay(context.now ?? new Date()))
    const purpose = purposeLabel(area.purpose)
    const effectiveTo = version === null || version.validTo === null ? undefined : lastDayIn(version.validTo)
    return {
      id: fixture?.id ?? webIdOf("area", area.id),
      name: area.name,
      context: `${purpose} · ${project?.name ?? "Project"}`,
      status,
      ...inheritedPresentation(fixture),
      ...stampFacts(area, context.now),
      // Nothing measures coverage; the fixture's figure is not the API's.
      value: "—",
      facts: {
        Code: area.code,
        "Area purpose": purpose,
        Project: project?.name ?? "Project",
        ...(version === null ? {} : { "Effective from": version.validFrom }),
        ...(effectiveTo === undefined ? {} : { "Effective to": effectiveTo }),
      },
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [projectWebId],
      recordKind: "Operational Planning Area version",
      submittedValues: {
        areaName: area.name,
        areaCode: area.code,
        projectId: projectWebId,
        purpose: area.purpose,
        ...(version === null
          ? {}
          : {
              effectiveFrom: version.validFrom,
              ...(effectiveTo === undefined ? {} : { effectiveTo }),
              geometry: JSON.stringify(version.boundary),
              boundaryId: version.id,
            }),
      },
    }
  },
  toCreateBody: (record, context) => {
    const name = typed(record, "areaName") ?? record.name
    const code = typed(record, "areaCode")
    if (!code) return refusal("areaCode", "An area needs a reference")
    const projectWebId = typed(record, "projectId") ?? record.projectIds?.[0]
    const projectId = projectWebId === undefined ? undefined : context.resolve.serverIdOf(projectWebId)
    if (projectId === undefined) return refusal("projectId", "Pick a project")
    const purpose = typed(record, "purpose")
    if (!purpose || !isPurpose(purpose)) return refusal("purpose", "Pick a purpose")
    const polygon = parsePolygonText(typed(record, "geometry"))
    if (polygon === undefined) return { projectId, code, name, purpose }
    const boundary = boundaryCreateOf(record, polygon)
    if ("path" in boundary) return boundary
    return { projectId, code, name, purpose, boundary }
  },
  toPatchBody: (before, after) => {
    if (changedTyped(before, after, "areaCode")) return refusal("areaCode", "The reference is set once: an area that needs another reference is another area")
    if (changedTyped(before, after, "projectId")) return refusal("projectId", "An area stays in its project")
    const area = patchOf(before, after, (record) => ({ name: typed(record, "areaName") ?? record.name, purpose: typed(record, "purpose") }))
    const versionId = typed(after, "boundaryId") ?? typed(before, "boundaryId")
    const drawnBefore = parsePolygonText(typed(before, "geometry"))
    const drawnAfter = parsePolygonText(typed(after, "geometry"))
    const redrawn = drawnAfter !== undefined && JSON.stringify(drawnBefore) !== JSON.stringify(drawnAfter)
    const endBefore = typed(before, "effectiveTo")
    const endAfter = typed(after, "effectiveTo")
    let boundary: PlanningAreaWrite["boundary"]
    if (versionId !== undefined) {
      if (changedTyped(before, after, "effectiveFrom")) return refusal("effectiveFrom", "A version's start does not move: end this one and draw the next")
      const versionPatch = {
        ...(redrawn ? { boundary: drawnAfter } : {}),
        ...(endBefore === endAfter ? {} : { validTo: endAfter === undefined ? null : firstDayOut(endAfter) }),
      }
      if (Object.keys(versionPatch).length > 0) boundary = { id: versionId, patch: versionPatch }
    } else if (drawnAfter !== undefined) {
      const first = boundaryCreateOf(after, drawnAfter)
      if ("path" in first) return first
      boundary = { create: first }
    }
    if (area === null && boundary === undefined) return null
    const write: PlanningAreaWrite = { ...(area === null ? {} : { area }), ...(boundary === undefined ? {} : { boundary }) }
    return write
  },
  create: (client, body) =>
    create<PlanningAreaCreated>(client, "/planning-areas", body).then(({ body: created }) => {
      const { boundary, ...area } = created
      return { ...area, boundaries: boundary === null ? [] : [boundary] }
    }),
  // Each part to its own route, then the versions read back, so the record shows what stands.
  update: async (client, serverId, body) => {
    const write = body as PlanningAreaWrite
    const patched = write.area === undefined ? undefined : await patch<PlanningArea>(client, `/planning-areas/${serverId}`, write.area)
    if (write.boundary !== undefined && "patch" in write.boundary) {
      await patch<PlanningAreaBoundary>(client, `/planning-area-boundaries/${write.boundary.id}`, write.boundary.patch)
    }
    if (write.boundary !== undefined && "create" in write.boundary) {
      await create<PlanningAreaBoundary>(client, `/planning-areas/${serverId}/boundaries`, write.boundary.create)
    }
    const area = patched ?? (await get<PlanningArea>(client, `/planning-areas/${serverId}`))
    const boundaries = await listAll<PlanningAreaBoundary>(client, `/planning-areas/${serverId}/boundaries`)
    return { ...area, boundaries }
  },
}

// ---------------------------------------------------------------------------
// Collection calendars
// ---------------------------------------------------------------------------

/** A calendar's holidays as the record's typed values spell them, named from the record first and the project's list second. */
function holidaysOf(record: BusinessRecord, project: BusinessRecord | undefined): CollectionCalendarHoliday[] {
  const carried = parseHolidayNames(record.submittedValues?.[HOLIDAY_NAMES_KEY])
  const listed = holidayNamesFor(projectHolidayListName(project) ?? undefined)
  return parseHolidayDates(typed(record, "holidayDates")).map((day) => ({ day, name: carried.get(day) ?? listed(day) ?? null }))
}

type CollectionCalendarWrite = {
  calendar?: { name?: string; validFrom?: string; validTo?: string | null }
  holidays?: CollectionCalendarHoliday[]
}

export const collectionCalendarAdapter: ResourceAdapter<CollectionCalendar> = {
  prefix: "calendar",
  owns: ofKind("calendar", ["Collection Calendar"]),
  // No status on the wire: a calendar is in force or not by its period, which the readers judge.
  statuses: undefined,
  list: (client) => listAll<CollectionCalendar>(client, "/collection-calendars"),
  toRecord: (calendar, context) => {
    const project = context.resolve.byServerId(calendar.projectId)
    const projectWebId = project?.id ?? webIdOf("project", calendar.projectId)
    const lastDay = calendar.validTo === null ? undefined : lastDayIn(calendar.validTo)
    const days = calendar.holidays.map((holiday) => holiday.day)
    const names = new Map(calendar.holidays.flatMap((holiday) => (holiday.name === null ? [] : [[holiday.day, holiday.name] as const])))
    const validity = `${calendar.validFrom} – ${lastDay ?? "open"}`
    const projectName = project?.name ?? "Project"
    return {
      id: webIdOf("calendar", calendar.id),
      name: calendar.name,
      context: `${projectName} · ${validity}`,
      status: "Active",
      ...inheritedPresentation(undefined),
      ...stampFacts(calendar, context.now),
      value: "—",
      facts: { Project: projectName, Holidays: String(days.length), Validity: validity },
      companyId: context.companyRecordId ?? FIXTURE_COMPANY_ID,
      projectIds: [projectWebId],
      recordKind: "Collection Calendar",
      submittedValues: {
        calendarName: calendar.name,
        projectId: projectWebId,
        validFrom: calendar.validFrom,
        ...(lastDay === undefined ? {} : { validTo: lastDay }),
        holidayDates: days.join(", "),
        ...(names.size === 0 ? {} : { [HOLIDAY_NAMES_KEY]: serializeHolidayNames(names) }),
      },
    }
  },
  toCreateBody: (record, context) => {
    const name = typed(record, "calendarName") ?? record.name
    const projectWebId = typed(record, "projectId") ?? record.projectIds?.[0]
    const projectId = projectWebId === undefined ? undefined : context.resolve.serverIdOf(projectWebId)
    if (projectId === undefined) return refusal("projectId", "Pick a project")
    const validFrom = typed(record, "validFrom")
    if (!validFrom) return refusal("validFrom", "A calendar needs the first day it is in force")
    const lastDay = typed(record, "validTo")
    return {
      projectId,
      name,
      validFrom,
      ...(lastDay === undefined ? {} : { validTo: firstDayOut(lastDay) }),
      holidays: holidaysOf(record, context.resolve.byServerId(projectId)),
    }
  },
  toPatchBody: (before, after, context) => {
    if (changedTyped(before, after, "projectId")) return refusal("projectId", "A calendar stays in its project")
    const calendar = patchOf(before, after, (record) => {
      const lastDay = typed(record, "validTo")
      return { name: typed(record, "calendarName") ?? record.name, validFrom: typed(record, "validFrom"), validTo: lastDay === undefined ? null : firstDayOut(lastDay) }
    })
    const projectWebId = typed(after, "projectId") ?? after.projectIds?.[0]
    const projectId = projectWebId === undefined ? undefined : context.resolve.serverIdOf(projectWebId)
    const project = projectId === undefined ? undefined : context.resolve.byServerId(projectId)
    const was = holidaysOf(before, project)
    const is = holidaysOf(after, project)
    const holidays = JSON.stringify(was) === JSON.stringify(is) ? undefined : is
    if (calendar === null && holidays === undefined) return null
    const write: CollectionCalendarWrite = { ...(calendar === null ? {} : { calendar }), ...(holidays === undefined ? {} : { holidays }) }
    return write
  },
  create: (client, body) => create<CollectionCalendar>(client, "/collection-calendars", body).then((created) => created.body),
  // The calendar first, then the whole set of holidays; the answer is the calendar as it now stands.
  update: async (client, serverId, body) => {
    const write = body as CollectionCalendarWrite
    let calendar = write.calendar === undefined ? undefined : await patch<CollectionCalendar>(client, `/collection-calendars/${serverId}`, write.calendar)
    if (write.holidays !== undefined) calendar = await put<CollectionCalendar>(client, `/collection-calendars/${serverId}/holidays`, { holidays: write.holidays })
    return calendar ?? (await get<CollectionCalendar>(client, `/collection-calendars/${serverId}`))
  },
}

// ---------------------------------------------------------------------------
// The modules
// ---------------------------------------------------------------------------

/** Settings → Areas & Zones, and the map's outlines. */
export const planningAreasModule: ServerModule = {
  workspaceId: PLANNING_AREAS_MODULE.workspaceId,
  moduleId: PLANNING_AREAS_MODULE.moduleId,
  resources: [planningAreaAdapter],
}

/** Settings → Collection calendars, and what the wizard and generation read a project's holidays from. */
export const collectionCalendarsModule: ServerModule = {
  workspaceId: COLLECTION_CALENDARS_MODULE.workspaceId,
  moduleId: COLLECTION_CALENDARS_MODULE.moduleId,
  resources: [collectionCalendarAdapter],
}

export type { Client }
