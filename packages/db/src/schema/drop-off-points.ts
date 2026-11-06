// The Drop-off Points (Issue #293, M3): the places residents bring waste to
// themselves, a project's recycling centres and bring banks. Not a Depot, an
// Unloading Station or a Warehouse, which are where the operation's own
// vehicles start, empty and stock; a Drop-off Point is where the public
// comes, so it is always located (the public map draws it) and carries what
// a resident needs: the fractions it takes, when it is open, and a note.
//
// The point is the project's (`projectKey`), its code and name unique per
// project. Its three sets are project-scoped beside it and point at it with
// the project carried, each replaced whole through its own route:
//   drop_off_point_fraction   the fractions it takes, one row each;
//   drop_off_point_hours      its weekly windows, several a weekday allowed,
//                             each opening before it closes on the day;
//   drop_off_point_exception  a dated exception, its window or both times
//                             null for closed all day, one per date.
// `open_always` marks a point with no hours (a bring bank on a street), and
// `closed_on_holidays` closes it on the project's holidays, read from the
// project's holiday list as generation reads it. When a day is open is the
// domain's (`@waste/domain/resources/drop-off-points`), for the office's form
// and the public map alike.
//
// A status, not a period (ADR-0005: a place carries a status): a draft is
// the office's alone, an active point is on the public map, a closed one is
// kept for the record.
import { SERVICE_DAYS } from "@waste/domain/planning/vocabulary"
import { ON_THE_MAP } from "@waste/domain/resources/drop-off-points"
import { DROP_OFF_POINT_KINDS, DROP_OFF_POINT_STATUSES } from "@waste/domain/resources/vocabulary"
import { sql } from "drizzle-orm"
import { boolean, check, date, text, time, unique, uuid } from "drizzle-orm/pg-core"

import { quoted, tableObjectName } from "../names"
import { wasteFraction } from "./catalogue"
import { oneOf } from "./checks"
import { id, projectScoped, timestamps } from "./columns"
import { geometry, validGeometry } from "./geometry"
import { company, project } from "./organisation"
import { inPublishedProject, policies } from "./policies"
import { companyReference, projectKey, projectReference, tenantIndex, tenantReference, tenantUnique } from "./references"
import { wms } from "./wms"

export const dropOffPoint = wms.table(
  "drop_off_point",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    /** The stable reference a person quotes: `GS-AMAGER`. Set once; unique per project. */
    code: text().notNull(),
    name: text().notNull(),
    kind: text().notNull(),
    /** The address as one text, as a depot's. */
    address: text().notNull(),
    /** The public map draws it, so a point is always located. */
    location: geometry.point().notNull(),
    /** Open at all hours, with no weekly windows: a bring bank on a street. */
    openAlways: boolean().notNull().default(false),
    /** Closed on the project's holidays unless an exception says otherwise. */
    closedOnHolidays: boolean().notNull().default(false),
    /** What a resident is told beside the hours: `Bring ID`, `Vans need a permit`. */
    publicNote: text(),
    status: text().notNull(),
    /** The office's own notes, never shown on the public map. */
    notes: text(),
  },
  (t) => [
    companyReference(t, company),
    tenantReference(t, [t.projectId], project),
    tenantUnique(t, t.projectId, t.code),
    tenantUnique(t, t.projectId, t.name),
    projectKey(t),
    oneOf(t.kind, DROP_OFF_POINT_KINDS),
    oneOf(t.status, DROP_OFF_POINT_STATUSES),
    validGeometry(t.location),
  ],
)

export const dropOffPointPolicies = policies(dropOffPoint, {
  audited: {},
  door: {
    columns: [
      dropOffPoint.id,
      dropOffPoint.companyId,
      dropOffPoint.projectId,
      dropOffPoint.name,
      dropOffPoint.kind,
      dropOffPoint.address,
      dropOffPoint.location,
      dropOffPoint.openAlways,
      dropOffPoint.closedOnHolidays,
      dropOffPoint.publicNote,
      dropOffPoint.status,
    ],
    rows: `${inPublishedProject("drop_off_point")} and ${quoted("status")} = '${ON_THE_MAP}'`,
  },
})

export const dropOffPointFraction = wms.table(
  "drop_off_point_fraction",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    dropOffPointId: uuid().notNull(),
    wasteFractionId: uuid().notNull(),
  },
  (t) => [
    companyReference(t, company),
    projectReference(t, [t.dropOffPointId], dropOffPoint),
    tenantReference(t, [t.wasteFractionId], wasteFraction),
    // One row per fraction a point takes; the derived name would pass 63 bytes, so the key is named for what it holds.
    unique(tableObjectName(t.companyId.table, "membership_key", "dropOffPointFraction")).on(t.companyId, t.dropOffPointId, t.wasteFractionId),
    tenantIndex(t, t.wasteFractionId),
  ],
)

/** A set's rows of a point on the public map: the point itself is, so a draft's hours are no more readable than the draft. */
const ofPointOnTheMap = (table: string) =>
  `${inPublishedProject(table)} and exists (select 1 from "wms"."drop_off_point" "point" where "point"."company_id" = ${quoted(table)}.${quoted("company_id")} and "point"."id" = ${quoted(table)}.${quoted("drop_off_point_id")} and "point"."status" = '${ON_THE_MAP}')`

export const dropOffPointFractionPolicies = policies(dropOffPointFraction, {
  audited: { parent: dropOffPointFraction.dropOffPointId },
  door: {
    columns: [
      dropOffPointFraction.companyId,
      dropOffPointFraction.projectId,
      dropOffPointFraction.dropOffPointId,
      dropOffPointFraction.wasteFractionId,
    ],
    rows: ofPointOnTheMap("drop_off_point_fraction"),
  },
})

export const dropOffPointHours = wms.table(
  "drop_off_point_hours",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    dropOffPointId: uuid().notNull(),
    weekday: text().notNull(),
    /** On the project's clock; a window opens before it closes on the day. */
    opensAt: time().notNull(),
    closesAt: time().notNull(),
  },
  (t) => [
    companyReference(t, company),
    projectReference(t, [t.dropOffPointId], dropOffPoint),
    oneOf(t.weekday, SERVICE_DAYS),
    check(tableObjectName(t.id.table, "window_shape", "dropOffPointHours"), sql`${t.opensAt} < ${t.closesAt}`),
    tenantIndex(t, t.dropOffPointId),
  ],
)

export const dropOffPointHoursPolicies = policies(dropOffPointHours, {
  audited: { parent: dropOffPointHours.dropOffPointId },
  door: {
    columns: [
      dropOffPointHours.companyId,
      dropOffPointHours.projectId,
      dropOffPointHours.dropOffPointId,
      dropOffPointHours.weekday,
      dropOffPointHours.opensAt,
      dropOffPointHours.closesAt,
    ],
    rows: ofPointOnTheMap("drop_off_point_hours"),
  },
})

export const dropOffPointException = wms.table(
  "drop_off_point_exception",
  {
    ...id,
    ...projectScoped,
    ...timestamps,
    dropOffPointId: uuid().notNull(),
    day: date().notNull(),
    /** The day's window, or both null for closed all day. */
    opensAt: time(),
    closesAt: time(),
    /** Why, as a resident reads it: `Christmas Eve`, `Closed for maintenance`. */
    note: text(),
  },
  (t) => [
    companyReference(t, company),
    projectReference(t, [t.dropOffPointId], dropOffPoint),
    // One exception a date; the derived name would pass 63 bytes.
    unique(tableObjectName(t.companyId.table, "day_key", "dropOffPointException")).on(t.companyId, t.dropOffPointId, t.day),
    check(tableObjectName(t.id.table, "window_shape", "dropOffPointException"), sql`(${t.opensAt} is null) = (${t.closesAt} is null) and (${t.opensAt} is null or ${t.opensAt} < ${t.closesAt})`),
  ],
)

export const dropOffPointExceptionPolicies = policies(dropOffPointException, {
  audited: { parent: dropOffPointException.dropOffPointId },
  door: {
    columns: [
      dropOffPointException.companyId,
      dropOffPointException.projectId,
      dropOffPointException.dropOffPointId,
      dropOffPointException.day,
      dropOffPointException.opensAt,
      dropOffPointException.closesAt,
      dropOffPointException.note,
    ],
    rows: ofPointOnTheMap("drop_off_point_exception"),
  },
})
