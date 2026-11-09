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
// reads one version against the day — the one in force, else the next to
// come, else the last to end — for its status, its dates and the version's
// id, so an edit patches that version. The day is the project's, not the
// browser's: a version that starts on the first of the month is in force
// in Copenhagen an hour before it is in London. The status is a reading, as
// the contracts say it is: Active with a version in force, Upcoming, Expired,
// Draft with none — no status is on the wire, so the store refuses every
// move. Only the version in force lends the record its geometry (a GeoJSON
// Polygon under `PLANNING_AREA_GEOMETRY_KEY`, which the map draws as it
// stands: lib/prototype/map-planning/areas), since the map shows what is in
// force today; an upcoming or ended version keeps its dates and its id for
// the form. A period's end is spelled two ways: the wire's `validTo` is the
// first day out of force (half-open, ADR-0005), the form's "Effective to"
// and "Valid to" the last day in, as every fixture end date reads; the
// adapter adds a day on the way out and takes one on the way in.
//
// The form's geometry text is read three ways. JSON that spells a polygon —
// a GeoJSON Polygon or a Feature around one, holes and all, or a list of
// `[lng, lat]` pairs or `{ lng, lat }` spots — is closed here at six
// decimals, as the contracts' header says the web adapter does. Text that is
// not JSON is a note: the area is registered undrawn, to be drawn later.
// JSON that spells no polygon a map could draw — a FeatureCollection, two
// points, a position with a string in it — is refused before the API, since
// a drawing that came out wrong is not a note. The reference (the code) is
// set once and the project does not move, so a change to either is refused
// too, in its own words; and a version's start does not move: on an area
// whose version has ended, a new polygon with a new start is the next
// version, added through the area's boundaries route.
//
// Boundary version history (O21 of #290). The API holds an area's versions
// one after another, never two in force on a day (`refuseOverlap`); the
// record carries all of them, by the day each starts, as JSON under
// `BOUNDARY_VERSIONS_KEY` — each version's id, its first day, its last day in
// force and whether it is in force, upcoming or ended on the project's day —
// which Areas & Zones lists. "Next version from" a day is the record's
// `NEXT_VERSION_FROM_KEY` with the new drawing under `NEXT_VERSION_GEOMETRY_KEY`:
// the write ends the version that would still be in force on that day there
// (its `validTo` the day, the first day out) and adds the next from it, the
// two requests in that order, since the API refuses the second while the
// first overlaps it. The day comes after that version's start; a version
// already ended before it is left as it stands, the next one added after the
// gap.
//
// A calendar carries no holidays (2026-11-05): a project's are the days of the
// company's Holiday List it names (holiday-lists.ts), so the record carries
// the calendar's name and period alone and an edit is one request.
//
// Ids. An area is `area-<uuid>` and a calendar `calendar-<uuid>`.
import type { CollectionCalendar, CollectionCalendarCreate, CollectionCalendarPatch } from "@waste/contracts/collection-calendars"
import type { FlatPolygon, Position2D } from "@waste/contracts/geojson"
import type { PlanningArea, PlanningAreaBoundary, PlanningAreaCreated } from "@waste/contracts/planning-areas"
import { PLANNING_AREA_GEOMETRY_KEY } from "@/lib/prototype/map-planning/areas"
import { PLANNING_AREA_PURPOSES, type PlanningAreaPurpose } from "@waste/domain/planning/vocabulary"
import { firstDayOut, inForceOn, lastDayIn, periodOn, type PeriodStanding } from "@waste/domain/periods"

import { type BusinessRecord } from "@/lib/data/business-modules"
import { COLLECTION_CALENDARS_MODULE } from "@/lib/data/collection-calendars"
import { isPlanningAreaRecord, PLANNING_AREAS_MODULE, planningAreaPurposeOptions } from "@/lib/data/planning-areas"

import { create, get, listAll, patch } from "../client"
import { holidayListAdapter } from "./holiday-lists"
import { patchOf, type Client, type ResourceAdapter, type ServerModule } from "./adapter"
import { ofKind, typed, webIdOf, type LocalRefusal } from "@/lib/records/fields"
import { todayIn } from "./clock"

const refusal = (path: string, message: string): LocalRefusal => ({ path, message })

/** Whether a typed form value differs between two records. */
const changedTyped = (before: BusinessRecord, after: BusinessRecord, key: string) => typed(before, key) !== typed(after, key)

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

/** Every ring of the polygon the parsed JSON spells — the outer ring first, then any holes — each closed; undefined for JSON that spells none. */
function ringsOf(value: unknown): Position2D[][] | undefined {
  if (Array.isArray(value)) {
    const ring = closedRing(value.map(positionOf))
    return ring === undefined ? undefined : [ring]
  }
  if (!value || typeof value !== "object") return undefined
  const shape = value as { type?: unknown; coordinates?: unknown; geometry?: unknown }
  if (shape.type === "Feature") return ringsOf(shape.geometry)
  if (shape.type === "Polygon" && Array.isArray(shape.coordinates) && shape.coordinates.length > 0) {
    const rings = (shape.coordinates as unknown[]).map((ring) => (Array.isArray(ring) ? closedRing(ring.map(positionOf)) : undefined))
    return rings.every((ring) => ring !== undefined) ? (rings as Position2D[][]) : undefined
  }
  return undefined
}

/** What the create and the edit refuse JSON that spells no polygon with, at the geometry field. */
export const NOT_A_POLYGON = "This is not a polygon the map can draw: give a GeoJSON Polygon, a Feature around one, or a list of [lng, lat] positions that enclose an area"

/** The three readings of a form's geometry text: blank, a note in words, JSON that spells a polygon, and JSON that spells none. */
export type GeometryText = { kind: "none" } | { kind: "note" } | { kind: "malformed" } | { kind: "polygon"; polygon: FlatPolygon }

/**
 * A form's geometry text read: `none` for blank, `note` for text that is
 * not JSON (a description, the area to be drawn later), `polygon` for JSON
 * that spells one — a GeoJSON Polygon, a Feature around one, a list of
 * `[lng, lat]` pairs or of `{ lng, lat }` spots — closed on its first
 * position at six decimals, the decimetre the Registry's points keep, holes
 * kept; and `malformed` for JSON that spells no polygon a map could draw.
 */
export function geometryOfText(text: string | undefined): GeometryText {
  if (text === undefined || text.trim() === "") return { kind: "none" }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: "note" }
  }
  if (parsed === null || typeof parsed !== "object") return { kind: "note" }
  const rings = ringsOf(parsed)
  return rings === undefined ? { kind: "malformed" } : { kind: "polygon", polygon: { type: "Polygon", coordinates: rings } }
}

/** The flat polygon a form's geometry text spells, or undefined for text that spells none — a note or a malformed drawing alike. */
export function parsePolygonText(text: string | undefined): FlatPolygon | undefined {
  const geometry = geometryOfText(text)
  return geometry.kind === "polygon" ? geometry.polygon : undefined
}

// ---------------------------------------------------------------------------
// Planning areas
// ---------------------------------------------------------------------------

/** Where an area record carries every boundary version (O21 of #290): JSON, by the day each starts. */
export const BOUNDARY_VERSIONS_KEY = "boundaryVersions"
/** Where a "Next version from" asks for the day the next boundary version starts. */
export const NEXT_VERSION_FROM_KEY = "nextVersionFrom"
/** Where it carries the next version's drawing, the geometry text the form reads three ways. */
export const NEXT_VERSION_GEOMETRY_KEY = "nextVersionGeometry"

/** One boundary version as the record lists it: its first day, its last day in force (null while open) and how it stands on the project's day. */
export type BoundaryVersionRow = { id: string; validFrom: string; lastDay: string | null; standing: "in force" | "upcoming" | "ended" }

/** How a version row names its standing. */
const STANDING_WORDS: Record<PeriodStanding, BoundaryVersionRow["standing"]> = { upcoming: "upcoming", "in-force": "in force", ended: "ended" }

/** An area's versions as the record lists them, by the day each starts, read against the project's day. */
export function boundaryVersionRows(boundaries: readonly PlanningAreaBoundary[], day: string): BoundaryVersionRow[] {
  return [...boundaries]
    .sort((a, b) => a.validFrom.localeCompare(b.validFrom))
    .map((version) => ({
      id: version.id,
      validFrom: version.validFrom,
      lastDay: version.validTo === null ? null : lastDayIn(version.validTo),
      standing: STANDING_WORDS[periodOn(version, day)],
    }))
}

/** The versions a record carries, as `boundaryVersionRows` wrote them; none for a record without. */
export function boundaryVersionsOf(record: BusinessRecord): BoundaryVersionRow[] {
  const raw = record.submittedValues?.[BOUNDARY_VERSIONS_KEY]
  if (typeof raw !== "string" || raw === "") return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as BoundaryVersionRow[]) : []
  } catch {
    return []
  }
}

/** What a next version from a day that does not follow the version before it is told. */
export const nextVersionAfter = (validFrom: string): string => `The next version starts after the one before it does, on ${validFrom}`

/** An area with every boundary version the API holds for it: what the read lists and a write answers. */
export type PlanningAreaResource = PlanningArea & { boundaries: PlanningAreaBoundary[] }

/** The record's status as a reading of the versions against the day, and the version it reads. */
export function versionInForce(boundaries: readonly PlanningAreaBoundary[], day: string): { status: "Draft" | "Active" | "Upcoming" | "Expired"; version: PlanningAreaBoundary | null } {
  const inForce = boundaries.find((version) => inForceOn(version, day))
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

/** A version to add — the first, or the next after one that ended: the polygon, its start, and its end as the first day out. */
function boundaryCreateOf(polygon: FlatPolygon, from: string | undefined, to: string | undefined): { boundary: FlatPolygon; validFrom: string; validTo?: string } | LocalRefusal {
  if (!from) return refusal("effectiveFrom", "A drawn area needs the day its boundary comes into force")
  return { boundary: polygon, validFrom: from, ...(to === undefined ? {} : { validTo: firstDayOut(to) }) }
}

/** What an area's update carries: a patch of the area, and one of the version the record reads or a version to add, each to its own route. */
type PlanningAreaWrite = {
  area?: { name?: string; purpose?: string }
  boundary?:
    | { id: string; patch: { boundary?: FlatPolygon; validTo?: string | null } }
    | { create: { boundary: FlatPolygon; validFrom: string; validTo?: string } }
    /** The next version from a day (O21 of #290): the version still in force then ended on it, where one is, and the next added. */
    | { successor: { endId: string | null; create: { boundary: FlatPolygon; validFrom: string } } }
}

/**
 * The next version a record asks for, from the versions it carries: the one
 * still in force on the day ended there, and the drawing added from it; null
 * where the record asks for none, a refusal where it cannot be.
 */
function successorWriteOf(before: BusinessRecord, after: BusinessRecord): NonNullable<PlanningAreaWrite["boundary"]> | LocalRefusal | null {
  const from = typed(after, NEXT_VERSION_FROM_KEY)
  if (from === undefined || from === typed(before, NEXT_VERSION_FROM_KEY)) return null
  const drawn = geometryOfText(typed(after, NEXT_VERSION_GEOMETRY_KEY))
  if (drawn.kind === "malformed") return refusal(NEXT_VERSION_GEOMETRY_KEY, NOT_A_POLYGON)
  if (drawn.kind !== "polygon") return refusal(NEXT_VERSION_GEOMETRY_KEY, "The next version needs its boundary: give the polygon it draws")
  const versions = boundaryVersionsOf(before)
  const latest = versions.at(-1)
  if (latest !== undefined && from <= latest.validFrom) return refusal(NEXT_VERSION_FROM_KEY, nextVersionAfter(latest.validFrom))
  // The version still in force on the day — open, or ending after it — ends there; one that ended before it stays as it is.
  const ending = latest !== undefined && (latest.lastDay === null || latest.lastDay >= from) ? latest.id : null
  return { successor: { endId: ending, create: { boundary: drawn.polygon, validFrom: from } } }
}

export const planningAreaAdapter: ResourceAdapter<PlanningAreaResource, unknown, PlanningAreaWrite> = {
  prefix: "area",
  auditTable: "planning_area",
  owns: isPlanningAreaRecord,
  // No status on the wire: the record's is a reading of its versions, and every move the lifecycle offers is refused.
  statuses: undefined,
  list: async (client) => {
    const [areas, boundaries] = await Promise.all([listAll<PlanningArea>(client, "/planning-areas"), listAll<PlanningAreaBoundary>(client, "/planning-area-boundaries")])
    return areas.map((area) => ({ ...area, boundaries: boundaries.filter((version) => version.planningAreaId === area.id) }))
  },
  toRecord: (area, context) => {
    const project = context.resolve.byServerId(area.projectId)
    const projectWebId = project?.id ?? webIdOf("project", area.projectId)
    const day = todayIn(context, project === undefined ? undefined : typed(project, "timezone"))
    const { status, version } = versionInForce(area.boundaries, day)
    const purpose = purposeLabel(area.purpose)
    const effectiveTo = version === null || version.validTo === null ? undefined : lastDayIn(version.validTo)
    return {
      name: area.name,
      context: `${purpose} · ${project?.name ?? "Project"}`,
      status,
      // Nothing measures coverage.
      value: "—",
      facts: {
        Code: area.code,
        "Area purpose": purpose,
        Project: project?.name ?? "Project",
        ...(version === null ? {} : { "Effective from": version.validFrom }),
        ...(effectiveTo === undefined ? {} : { "Effective to": effectiveTo }),
      },
      projectIds: [projectWebId],
      recordKind: "Operational Planning Area version",
      submittedValues: {
        areaName: area.name,
        areaCode: area.code,
        projectId: projectWebId,
        purpose: area.purpose,
        // Every version, by the day each starts (O21 of #290): Areas & Zones' history.
        [BOUNDARY_VERSIONS_KEY]: JSON.stringify(boundaryVersionRows(area.boundaries, day)),
        ...(version === null
          ? {}
          : {
              effectiveFrom: version.validFrom,
              ...(effectiveTo === undefined ? {} : { effectiveTo }),
              boundaryId: version.id,
              // The form's confirmation that the drawing passed: a version the API holds has.
              geometryConfirmed: true,
              // The map draws what is in force today, so only that version is the record's geometry.
              ...(status === "Active" ? { [PLANNING_AREA_GEOMETRY_KEY]: JSON.stringify(version.boundary) } : {}),
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
    const drawn = geometryOfText(typed(record, PLANNING_AREA_GEOMETRY_KEY))
    if (drawn.kind === "malformed") return refusal(PLANNING_AREA_GEOMETRY_KEY, NOT_A_POLYGON)
    if (drawn.kind !== "polygon") return { projectId, code, name, purpose }
    const boundary = boundaryCreateOf(drawn.polygon, typed(record, "effectiveFrom"), typed(record, "effectiveTo"))
    if ("path" in boundary) return boundary
    return { projectId, code, name, purpose, boundary }
  },
  toPatchBody: (before, after) => {
    if (changedTyped(before, after, "areaCode")) return refusal("areaCode", "The reference is set once: an area that needs another reference is another area")
    if (changedTyped(before, after, "projectId")) return refusal("projectId", "An area stays in its project")
    const successor = successorWriteOf(before, after)
    if (successor !== null && "path" in successor) return successor
    if (successor !== null) {
      const renamed = patchOf(before, after, (record) => ({ name: typed(record, "areaName") ?? record.name, purpose: typed(record, "purpose") }))
      const write: PlanningAreaWrite = { ...(renamed === null ? {} : { area: renamed }), boundary: successor }
      return write
    }
    const area = patchOf(before, after, (record) => ({ name: typed(record, "areaName") ?? record.name, purpose: typed(record, "purpose") }))
    const drawn = geometryOfText(typed(after, PLANNING_AREA_GEOMETRY_KEY))
    if (drawn.kind === "malformed") return refusal(PLANNING_AREA_GEOMETRY_KEY, NOT_A_POLYGON)
    const drawnAfter = drawn.kind === "polygon" ? drawn.polygon : undefined
    const drawnBefore = parsePolygonText(typed(before, PLANNING_AREA_GEOMETRY_KEY))
    const redrawn = drawnAfter !== undefined && JSON.stringify(drawnBefore) !== JSON.stringify(drawnAfter)
    const versionId = typed(after, "boundaryId") ?? typed(before, "boundaryId")
    const startMoved = changedTyped(before, after, "effectiveFrom")
    const endBefore = typed(before, "effectiveTo")
    const endAfter = typed(after, "effectiveTo")
    // On an area whose version has ended, a new polygon or a new start is the
    // next version; its end alone moved is that version reopened or ended anew.
    const nextVersion = before.status === "Expired" && (drawnAfter !== undefined || startMoved)
    let boundary: PlanningAreaWrite["boundary"]
    if (versionId !== undefined && !nextVersion) {
      if (startMoved) return refusal("effectiveFrom", "A version's start does not move: end this one and draw the next")
      const versionPatch = {
        ...(redrawn ? { boundary: drawnAfter } : {}),
        ...(endBefore === endAfter ? {} : { validTo: endAfter === undefined ? null : firstDayOut(endAfter) }),
      }
      if (Object.keys(versionPatch).length > 0) boundary = { id: versionId, patch: versionPatch }
    } else if (drawnAfter !== undefined || nextVersion) {
      if (nextVersion && !startMoved) return refusal("effectiveFrom", "This version has ended: give the day the next one comes into force")
      if (drawnAfter === undefined) return refusal(PLANNING_AREA_GEOMETRY_KEY, "The next version needs its boundary: give the polygon it draws")
      // The ended version's end, left as the form showed it, says nothing about the next version's.
      const end = nextVersion && endBefore === endAfter ? undefined : endAfter
      const next = boundaryCreateOf(drawnAfter, typed(after, "effectiveFrom"), end)
      if ("path" in next) return next
      boundary = { create: next }
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
  // The version first — the request the API is likeliest to refuse, an
  // overlap or a polygon PostGIS rejects — so a refusal leaves the area as
  // it was; then the area, then the versions read back, so the record shows
  // what stands. Two requests are still two: a version written before an
  // area patch the API refuses stays written, and the store says it was saved
  // only in part, in the API's sentence, keeps the row as typed and reads the
  // module again (#263), so a second save sends the rename alone.
  update: async (client, serverId, write) => {
    if (write.boundary !== undefined && "patch" in write.boundary) {
      await patch<PlanningAreaBoundary>(client, `/planning-area-boundaries/${write.boundary.id}`, write.boundary.patch)
    }
    if (write.boundary !== undefined && "create" in write.boundary) {
      await create<PlanningAreaBoundary>(client, `/planning-areas/${serverId}/boundaries`, write.boundary.create)
    }
    // The next version (O21 of #290): the version in force on the day ended there first, since the API refuses an overlap, then the next added from it.
    if (write.boundary !== undefined && "successor" in write.boundary) {
      const { endId, create: next } = write.boundary.successor
      if (endId !== null) await patch<PlanningAreaBoundary>(client, `/planning-area-boundaries/${endId}`, { validTo: next.validFrom })
      await create<PlanningAreaBoundary>(client, `/planning-areas/${serverId}/boundaries`, next)
    }
    const area = write.area === undefined ? await get<PlanningArea>(client, `/planning-areas/${serverId}`) : await patch<PlanningArea>(client, `/planning-areas/${serverId}`, write.area)
    const boundaries = await listAll<PlanningAreaBoundary>(client, `/planning-areas/${serverId}/boundaries`)
    return { ...area, boundaries }
  },
}

// ---------------------------------------------------------------------------
// Collection calendars
// ---------------------------------------------------------------------------

export const collectionCalendarAdapter: ResourceAdapter<CollectionCalendar, CollectionCalendarCreate, CollectionCalendarPatch> = {
  prefix: "calendar",
  auditTable: "collection_calendar",
  owns: ofKind("calendar", ["Collection Calendar"]),
  // No status on the wire: a calendar is in force or not by its period, which the readers judge.
  statuses: undefined,
  list: (client) => listAll<CollectionCalendar>(client, "/collection-calendars"),
  toRecord: (calendar, context) => {
    const project = context.resolve.byServerId(calendar.projectId)
    const projectWebId = project?.id ?? webIdOf("project", calendar.projectId)
    const lastDay = calendar.validTo === null ? undefined : lastDayIn(calendar.validTo)
    const validity = `${calendar.validFrom} – ${lastDay ?? "open"}`
    const projectName = project?.name ?? "Project"
    return {
      name: calendar.name,
      context: `${projectName} · ${validity}`,
      status: "Active",
      value: "—",
      facts: { Project: projectName, Validity: validity },
      projectIds: [projectWebId],
      recordKind: "Collection Calendar",
      submittedValues: {
        calendarName: calendar.name,
        projectId: projectWebId,
        validFrom: calendar.validFrom,
        ...(lastDay === undefined ? {} : { validTo: lastDay }),
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
    }
  },
  toPatchBody: (before, after) => {
    if (changedTyped(before, after, "projectId")) return refusal("projectId", "A calendar stays in its project")
    return patchOf(before, after, (record) => {
      const lastDay = typed(record, "validTo")
      return { name: typed(record, "calendarName") ?? record.name, validFrom: typed(record, "validFrom"), validTo: lastDay === undefined ? null : firstDayOut(lastDay) }
    })
  },
  create: (client, body) => create<CollectionCalendar>(client, "/collection-calendars", body).then((created) => created.body),
  update: (client, serverId, body) => patch<CollectionCalendar>(client, `/collection-calendars/${serverId}`, body),
}

// ---------------------------------------------------------------------------
// The modules
// ---------------------------------------------------------------------------

/** Settings → Areas & Zones, and the map's outlines: each carries the boundary version in force on the project's day (#232). */
export const planningAreasModule = {
  ...PLANNING_AREAS_MODULE,
  resources: [planningAreaAdapter],
} satisfies ServerModule

/**
 * Settings → Collection calendars and Holiday lists, and what the wizard and
 * generation read a project's holidays from: the per-year calendars, and the
 * company's Holiday Lists beside them (holiday-lists.ts), the grant both are
 * read under.
 */
export const collectionCalendarsModule = {
  ...COLLECTION_CALENDARS_MODULE,
  resources: [collectionCalendarAdapter, holidayListAdapter],
} satisfies ServerModule

export type { Client }
