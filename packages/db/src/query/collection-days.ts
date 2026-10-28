// What a property's collection days are computed from (Issue #293, M2): one
// read over a transaction, whatever role holds it — the public door's
// `wms_public` for a published project (ADR-0010), or the API's own role for
// the portal's signed-in customer — and `@waste/domain/planning/collection-days`
// turns it into dates. Every statement names the company and the project; a
// row the role may not see is simply absent, so the public role's grants and
// policies bound what this can return, not this code.
//
// The containers are the property's placements in force on some day the plan
// walks — from the lookback a shift can reach into the window, to its end —
// each with its period and the pauses of the subscription it serves (#291),
// so the domain counts a bin only while it is placed and not paused, as
// generation's matcher does;
// through the subscriptions the property holds (a shared collection point's
// members are not followed yet). The groups that collect them are a manual group's
// listed stops and a rule group's latest match (`generation_match`, the set
// the last run wrote for it), each counted only for the source the group now
// takes its stops from. Of those groups' schemes, the validated ones are
// planned at their cadence and their seasons', with the routes already standing for those groups in the window
// and the project's working week and holidays near it, as generation reads
// them.
import { holidayListOf, schemeRecurrenceOf, type ExistingRoute, type GenerationWindow } from "@waste/domain/planning/generation"
import { lookbackOf, type ServedContainer, type ServingGroup, type ServingScheme } from "@waste/domain/planning/collection-days"
import type { RecurrenceFrequency, SeasonFrequency, ServiceDay, StopSource, WeekRotation } from "@waste/domain/planning/vocabulary"
import type { RouteStatus } from "@waste/domain/execution/vocabulary"
import { SHIFT_SEARCH_DAYS, type HolidayPolicy, type SchemeCalendar } from "@waste/domain/route-schemes/occurrences"
import { addDays } from "@waste/domain/route-schemes/recurrence"
import { and, arrayOverlaps, asc, desc, eq, gte, ilike, inArray, lte, sql } from "drizzle-orm"
import type { PgColumn } from "drizzle-orm/pg-core"

import type { Tx } from "../client"
import { subscription, subscriptionPause } from "../schema/agreements"
import { wasteFraction } from "../schema/catalogue"
import { collectionCalendarHoliday } from "../schema/collection-calendars"
import { containerServicePlacement } from "../schema/containers"
import { property } from "../schema/customers"
import { route } from "../schema/execution"
import { generationMatch } from "../schema/generation"
import { project } from "../schema/organisation"
import { collectionGroup, collectionGroupContainer, routeScheme, routeSchemeSeason } from "../schema/route-schemes"
import { validOn } from "./valid-on"

/** A project's property, as a search names it. */
export type ScopedProject = { companyId: string; projectId: string }

/** What the domain plans a property's days from: the project's calendar and the schemes whose groups collect its containers. */
export type CollectionDayInputs = { calendar: SchemeCalendar; schemes: ServingScheme[] }

/** The most addresses one search answers with. */
export const ADDRESS_MATCHES_MAX = 10

/**
 * The project's properties whose address holds `text`, that hold a
 * subscription in force on `day`: the ones with something to collect. At most
 * `ADDRESS_MATCHES_MAX`, by address. Never a listing: the caller asks for a
 * text it has, and the answer is the address alone.
 */
export async function searchAddresses(tx: Tx, scope: ScopedProject, text: string, day: string): Promise<{ id: string; address: string }[]> {
  const pattern = `%${text.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`
  return tx
    .select({ id: property.id, address: property.address })
    .from(property)
    .where(
      and(
        eq(property.companyId, scope.companyId),
        eq(property.projectId, scope.projectId),
        ilike(property.address, pattern),
        sql`exists (select 1 from ${subscription} where ${subscription.companyId} = ${property.companyId} and ${subscription.propertyId} = ${property.id} and ${validOn(subscription, day)})`,
      ),
    )
    .orderBy(asc(property.address), asc(property.id))
    .limit(ADDRESS_MATCHES_MAX)
}

/** One property of the project by id, with something to collect on `day`; undefined when it is no such property. */
export async function findCollectedProperty(tx: Tx, scope: ScopedProject, propertyId: string, day: string): Promise<{ id: string; address: string } | undefined> {
  const [found] = await tx
    .select({ id: property.id, address: property.address })
    .from(property)
    .where(
      and(
        eq(property.companyId, scope.companyId),
        eq(property.projectId, scope.projectId),
        eq(property.id, propertyId),
        sql`exists (select 1 from ${subscription} where ${subscription.companyId} = ${property.companyId} and ${subscription.propertyId} = ${property.id} and ${validOn(subscription, day)})`,
      ),
    )
    .limit(1)
  return found
}

/** The inputs of a property's collection days over the window, read as generation reads them. */
export async function readCollectionDayInputs(tx: Tx, scope: ScopedProject, propertyId: string, window: GenerationWindow): Promise<CollectionDayInputs> {
  const fenced = (table: { companyId: PgColumn; projectId: PgColumn }) => and(eq(table.companyId, scope.companyId), eq(table.projectId, scope.projectId))

  const [calendarRow] = await tx
    .select({ weekend: project.weekend, holidayList: project.holidayList })
    .from(project)
    .where(and(eq(project.companyId, scope.companyId), eq(project.id, scope.projectId)))
    .limit(1)
  const holidayRows =
    calendarRow?.holidayList == null
      ? []
      : await tx
          .select({ day: collectionCalendarHoliday.day, name: collectionCalendarHoliday.name })
          .from(collectionCalendarHoliday)
          .where(
            and(
              eq(collectionCalendarHoliday.companyId, scope.companyId),
              eq(collectionCalendarHoliday.projectId, scope.projectId),
              gte(collectionCalendarHoliday.day, addDays(lookbackOf(window), -SHIFT_SEARCH_DAYS)),
              lte(collectionCalendarHoliday.day, addDays(window.to, SHIFT_SEARCH_DAYS)),
            ),
          )
  const calendar: SchemeCalendar = { holidays: holidayListOf(holidayRows, calendarRow?.holidayList ?? null), weekend: (calendarRow?.weekend ?? []) as ServiceDay[] }

  // Every placement of the property's containers in force on some service date the plan walks: from the lookback a shift can reach from, to the window's end.
  const walkFrom = lookbackOf(window)
  const placements = await tx
    .select({
      containerId: containerServicePlacement.containerId,
      subscriptionId: containerServicePlacement.subscriptionId,
      fraction: wasteFraction.name,
      validFrom: containerServicePlacement.validFrom,
      validTo: containerServicePlacement.validTo,
    })
    .from(containerServicePlacement)
    .innerJoin(subscription, and(eq(subscription.companyId, containerServicePlacement.companyId), eq(subscription.id, containerServicePlacement.subscriptionId)))
    .innerJoin(wasteFraction, and(eq(wasteFraction.companyId, containerServicePlacement.companyId), eq(wasteFraction.id, containerServicePlacement.wasteFractionId)))
    .where(
      and(
        fenced(containerServicePlacement),
        eq(subscription.propertyId, propertyId),
        lte(containerServicePlacement.validFrom, window.to),
        sql`(${containerServicePlacement.validTo} is null or ${containerServicePlacement.validTo} > ${walkFrom})`,
      ),
    )
  // The pauses of those subscriptions over the walk: a paused day plans no stop for the bins serving it.
  const subscriptionIds = [...new Set(placements.map((row) => row.subscriptionId))]
  const pauses =
    subscriptionIds.length === 0
      ? []
      : await tx
          .select({ subscriptionId: subscriptionPause.subscriptionId, validFrom: subscriptionPause.validFrom, validTo: subscriptionPause.validTo })
          .from(subscriptionPause)
          .where(
            and(
              fenced(subscriptionPause),
              inArray(subscriptionPause.subscriptionId, subscriptionIds),
              lte(subscriptionPause.validFrom, window.to),
              sql`(${subscriptionPause.validTo} is null or ${subscriptionPause.validTo} > ${walkFrom})`,
            ),
          )
  const pausesOf = new Map<string, { validFrom: string; validTo: string | null }[]>()
  for (const pause of pauses) pausesOf.set(pause.subscriptionId, [...(pausesOf.get(pause.subscriptionId) ?? []), { validFrom: pause.validFrom, validTo: pause.validTo }])
  const placementsOf = new Map<string, ServedContainer[]>()
  for (const row of placements) {
    const served: ServedContainer = { fraction: row.fraction, validFrom: row.validFrom, validTo: row.validTo, pauses: pausesOf.get(row.subscriptionId) ?? [] }
    placementsOf.set(row.containerId, [...(placementsOf.get(row.containerId) ?? []), served])
  }
  if (placementsOf.size === 0) return { calendar, schemes: [] }
  const containerIds = [...placementsOf.keys()]

  // Which groups collect which of the containers: a manual group by its list, a rule group by its latest match.
  const listed = await tx
    .select({ groupId: collectionGroupContainer.collectionGroupId, containerId: collectionGroupContainer.containerId })
    .from(collectionGroupContainer)
    .where(and(fenced(collectionGroupContainer), inArray(collectionGroupContainer.containerId, containerIds)))
  // A rule group's latest match, and only where it holds one of the containers: the overlap is judged in the statement, on the latest row alone.
  const latest = tx
    .selectDistinctOn([generationMatch.collectionGroupId], { groupId: generationMatch.collectionGroupId, containerIds: generationMatch.containerIds })
    .from(generationMatch)
    .where(fenced(generationMatch))
    .orderBy(asc(generationMatch.collectionGroupId), desc(generationMatch.id))
    .as("latest")
  const latestMatches = await tx
    .select({ groupId: latest.groupId, containerIds: latest.containerIds })
    .from(latest)
    .where(arrayOverlaps(latest.containerIds, containerIds))
  const collected = new Map<string, { manual: Set<string>; rule: Set<string> }>()
  const note = (groupId: string, source: "manual" | "rule", containerId: string) => {
    const entry = collected.get(groupId) ?? { manual: new Set<string>(), rule: new Set<string>() }
    entry[source].add(containerId)
    collected.set(groupId, entry)
  }
  for (const row of listed) note(row.groupId, "manual", row.containerId)
  for (const match of latestMatches) for (const containerId of match.containerIds) if (placementsOf.has(containerId)) note(match.groupId, "rule", containerId)
  if (collected.size === 0) return { calendar, schemes: [] }

  const groups = await tx
    .select({ id: collectionGroup.id, routeSchemeId: collectionGroup.routeSchemeId, position: collectionGroup.position, days: collectionGroup.days, stopSource: collectionGroup.stopSource })
    .from(collectionGroup)
    .where(and(fenced(collectionGroup), inArray(collectionGroup.id, [...collected.keys()])))
  const serving = new Map<string, ServingGroup[]>()
  for (const group of groups) {
    const source = group.stopSource as StopSource
    const containers = collected.get(group.id)?.[source === "manual" ? "manual" : "rule"] ?? new Set<string>()
    if (containers.size === 0) continue
    const served = [...containers].flatMap((containerId) => placementsOf.get(containerId) ?? [])
    const list = serving.get(group.routeSchemeId) ?? []
    list.push({ id: group.id, position: group.position, days: group.days as ServiceDay[], stopSource: source, containers: served })
    serving.set(group.routeSchemeId, list)
  }
  if (serving.size === 0) return { calendar, schemes: [] }

  const schemes = await tx
    .select({
      id: routeScheme.id,
      frequency: routeScheme.frequency,
      serviceDays: routeScheme.serviceDays,
      weekRotation: routeScheme.weekRotation,
      validFrom: routeScheme.validFrom,
      validTo: routeScheme.validTo,
      holidayPolicy: routeScheme.holidayPolicy,
    })
    .from(routeScheme)
    .where(and(fenced(routeScheme), inArray(routeScheme.id, [...serving.keys()]), eq(routeScheme.status, "validated")))
  // The schemes' seasons (O17 of #290): the cadence for part of every year, which generation plans by too.
  const seasons =
    schemes.length === 0
      ? []
      : await tx
          .select({
            routeSchemeId: routeSchemeSeason.routeSchemeId,
            name: routeSchemeSeason.name,
            startsOn: routeSchemeSeason.startsOn,
            endsOn: routeSchemeSeason.endsOn,
            frequency: routeSchemeSeason.frequency,
            weekRotation: routeSchemeSeason.weekRotation,
          })
          .from(routeSchemeSeason)
          .where(and(fenced(routeSchemeSeason), inArray(routeSchemeSeason.routeSchemeId, schemes.map((scheme) => scheme.id))))
          .orderBy(asc(routeSchemeSeason.startsOn))
  const seasonsOf = (schemeId: string) =>
    seasons.filter((season) => season.routeSchemeId === schemeId).map(({ routeSchemeId: _scheme, ...season }) => ({ ...season, frequency: season.frequency as SeasonFrequency, weekRotation: season.weekRotation as WeekRotation | null }))
  const groupIds = schemes.flatMap((scheme) => (serving.get(scheme.id) ?? []).map((group) => group.id))
  const standing =
    groupIds.length === 0
      ? []
      : await tx
          .select({
            id: route.id,
            collectionGroupId: route.collectionGroupId,
            serviceDate: route.serviceDate,
            operatingDate: route.operatingDate,
            status: route.status,
            cancelledByGeneration: route.cancelledByGeneration,
            heldAt: route.heldAt,
          })
          .from(route)
          .where(and(fenced(route), inArray(route.collectionGroupId, groupIds), gte(route.serviceDate, walkFrom), lte(route.serviceDate, window.to)))
  const routesOf = new Map<string, ExistingRoute[]>()
  for (const row of standing) {
    if (row.collectionGroupId === null) continue
    const list = routesOf.get(row.collectionGroupId) ?? []
    // Whether a route carries an office stop decides only cancel against trim, and neither is a collection: false is enough here.
    list.push({ id: row.id, collectionGroupId: row.collectionGroupId, serviceDate: row.serviceDate, operatingDate: row.operatingDate, status: row.status as RouteStatus, cancelledByGeneration: row.cancelledByGeneration, held: row.heldAt !== null, officeStops: false })
    routesOf.set(row.collectionGroupId, list)
  }

  return {
    calendar,
    schemes: schemes.map((scheme) => {
      const schemeGroups = serving.get(scheme.id) ?? []
      return {
        recurrence: schemeRecurrenceOf({
          frequency: scheme.frequency as RecurrenceFrequency,
          serviceDays: scheme.serviceDays as ServiceDay[],
          weekRotation: scheme.weekRotation as WeekRotation | null,
          validFrom: scheme.validFrom,
          validTo: scheme.validTo,
          seasons: seasonsOf(scheme.id),
        }),
        holidayPolicy: scheme.holidayPolicy as HolidayPolicy,
        groups: schemeGroups,
        existingRoutes: schemeGroups.flatMap((group) => routesOf.get(group.id) ?? []),
      }
    }),
  }
}
