// A property's collection days (Issue #293, M2): the dates its containers are
// collected, as generation plans them. Nothing here guesses a day: for each
// scheme with a group that collects one of the property's containers, the
// domain's own `planRoutes` runs over the window — the scheme's recurrence,
// its holiday policy, the project's working week and holidays, the routes
// already standing — and the property's day is each decision that collects:
//
//   create, refresh  a route generation makes or keeps; its operating date,
//                    so a shift off a holiday shows as the day the truck
//                    comes, and a held route (#209) its own, as the job
//                    keeps it
//   leave            a route that ran or is about to (ready and beyond) keeps
//                    its own operating date; one cancelled is no collection
//   cancel, trim     the scheme no longer plans it: no collection
//
// A holiday the policy skips is read off the occurrences, not the decisions:
// a skipped date is a skipped day for each group that runs on it, whether a
// route stands there (cancelled by the run, or about to be) or none does —
// unless the office held that route on another day, which then collects.
//
// The plan starts `SHIFT_SEARCH_DAYS` before the window, the farthest a shift
// walks, so a collection a holiday or the office moved into the window from a
// service date before it is still found; what is answered is the days inside
// the window. A container counts on a day only while its placement is in
// force on the day's service date, so a bin delivered next week or taken away
// mid-window starts or stops where its placement does.
//
// The public door's calendar (`/public/:slug/addresses/:id/collection-days`)
// and the portal's read the same function over the same inputs
// (`@waste/db/query/collection-days`), so a resident and a customer are told
// one thing. A day's key — the group and the service date — is a route's
// identity (ADR-0002), stable across reads.
import { formatOccurrenceShortDate, SHIFT_SEARCH_DAYS, type HolidayPolicy, type SchemeCalendar } from "../route-schemes/occurrences"
import { addDays, serviceDayOf, type SchemeRecurrence } from "../route-schemes/recurrence"
import { planRoutes, skippedHoliday, type ExistingRoute, type GenerationGroup, type GenerationWindow } from "./generation"

/** A period, half-open: `validTo` the first day out of force, null while it runs. */
type Period = { validFrom: string; validTo: string | null }

/**
 * A container a group collects at the property: its fraction's name, its
 * placement's period, and the pauses of the subscription it serves (#291),
 * on whose days generation plans it no stop — none where it has no pause.
 */
export type ServedContainer = Period & { fraction: string; pauses?: readonly Period[] }

const covers = (period: Period, day: string): boolean => period.validFrom <= day && (period.validTo === null || period.validTo > day)

/** A group that collects at least one of the property's containers. */
export type ServingGroup = GenerationGroup & { containers: readonly ServedContainer[] }

/** A validated scheme with a group serving the property: what `planRoutes` needs, the serving groups alone, and the routes already standing for them. */
export type ServingScheme = {
  recurrence: SchemeRecurrence
  holidayPolicy: HolidayPolicy
  groups: readonly ServingGroup[]
  existingRoutes: readonly ExistingRoute[]
}

export type CollectionDayStatus = "collected" | "skipped"

/** One collection of the property: the day the truck comes, what it takes, and why the day moved where it did. */
export type CollectionDay = {
  /** The route's identity, `<group>|<service date>`: stable across reads. */
  key: string
  /** The day it happens (an operating date); for a skipped one, the day it would have been. */
  date: string
  /** The recurrence date it stems from; differs from `date` where a holiday or the office moved it. */
  serviceDate: string
  /** The fractions collected, by name, in order. */
  fractions: string[]
  status: CollectionDayStatus
  /** A shift, a holiday collection, a skip or the office's move, in a sentence; null for a usual day. */
  note: string | null
}

export type CollectionDaysInput = {
  window: GenerationWindow
  calendar: SchemeCalendar
  schemes: readonly ServingScheme[]
}

/** The first day the plan walks from, for a window: the farthest back a shift can reach into it. */
export const lookbackOf = (window: GenerationWindow): string => addDays(window.from, -SHIFT_SEARCH_DAYS)

/** The note a day the office moved carries, where the planner says nothing of its own. */
export const movedByOffice = (date: string): string => `Moved to ${formatOccurrenceShortDate(date)}`

const byName = (a: string, b: string): number => a.localeCompare(b)

/** The fractions of a group's containers in force and not paused on the service date, by name, once each. */
function fractionsOn(group: ServingGroup, serviceDate: string): string[] {
  const inForce = group.containers.filter((container) => covers(container, serviceDate) && !(container.pauses ?? []).some((pause) => covers(pause, serviceDate)))
  return [...new Set(inForce.map((container) => container.fraction))].sort(byName)
}

/** The property's collection days inside the window, by date, then by the first fraction's name. */
export function collectionDaysOf({ window, calendar, schemes }: CollectionDaysInput): CollectionDay[] {
  const days: CollectionDay[] = []
  const walk = { from: lookbackOf(window), to: window.to }
  for (const scheme of schemes) {
    if (scheme.groups.length === 0) continue
    const groupOf = new Map(scheme.groups.map((group) => [group.id, group]))
    const standing = new Map(scheme.existingRoutes.map((route) => [route.id, route]))
    const plan = planRoutes({ recurrence: scheme.recurrence, holidayPolicy: scheme.holidayPolicy, calendar, window: walk, groups: scheme.groups, existingRoutes: scheme.existingRoutes })
    const collected = new Set<string>()
    const collect = (groupId: string, serviceDate: string, date: string, note: string | null) => {
      const group = groupOf.get(groupId)
      const fractions = group === undefined ? [] : fractionsOn(group, serviceDate)
      if (fractions.length === 0) return
      const key = `${groupId}|${serviceDate}`
      collected.add(key)
      days.push({ key, serviceDate, fractions, date, status: "collected", note: note ?? (date === serviceDate ? null : movedByOffice(date)) })
    }
    for (const decision of plan.decisions) {
      switch (decision.kind) {
        case "create":
          collect(decision.groupId, decision.serviceDate, decision.operatingDate, decision.note)
          break
        case "refresh": {
          // A held route keeps the day the office moved it to (#209), as the job keeps it.
          const route = standing.get(decision.routeId)
          collect(decision.groupId, decision.serviceDate, route?.held === true ? route.operatingDate : decision.operatingDate, decision.note)
          break
        }
        case "leave": {
          const route = standing.get(decision.routeId)
          if (route !== undefined && decision.status !== "cancelled") collect(decision.groupId, decision.serviceDate, route.operatingDate, null)
          break
        }
        case "omit":
        case "cancel":
        case "trim":
          break
      }
    }
    for (const occurrence of plan.occurrences) {
      if (occurrence.status !== "skipped") continue
      const serviceDate = occurrence.plannedDate
      const weekday = serviceDayOf(serviceDate)
      for (const group of scheme.groups) {
        const key = `${group.id}|${serviceDate}`
        if (!group.days.includes(weekday) || collected.has(key)) continue
        const fractions = fractionsOn(group, serviceDate)
        if (fractions.length > 0) days.push({ key, serviceDate, fractions, date: serviceDate, status: "skipped", note: skippedHoliday(occurrence.note) })
      }
    }
  }
  return days
    .filter((day) => day.date >= window.from && day.date <= window.to)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byName(a.fractions[0] ?? "", b.fractions[0] ?? "") || a.key.localeCompare(b.key)))
}
