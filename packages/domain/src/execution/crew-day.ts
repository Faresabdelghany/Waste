// A crew's day across routes (O7 of #290, row 3.18). A driver, a vehicle or
// a trailer may run two routes of one day — a morning round and an afternoon
// one — but not at once. Each route's span is its start and its work as the
// route read weighs it (`routeShift`: the planned start or the shift's, the
// active Plan's drive and waiting, the stops' time, the unloads, the break),
// and the spans are judged against each other:
//
// - a known overlap is refused outright: one person drives one truck;
// - known spans apart are taken, one ending as the other starts included;
// - a span not known — no start, or no measured Plan — is refused until the
//   office confirms the same day (`acceptSameDay`), which never takes back a
//   known overlap.
//
// An allocation reserving the vehicle, the trailer or the driver over the
// day with another crew is refused too, naming the allocation's window: the
// reservation is the plan, and a route against it is changed with it.
//
// Pure: a span is seconds of the operating day, `[from, to)`, its end past
// midnight where a route runs that late.
import { secondsOfDay } from "./shift"

/** A route's span of its operating day: seconds from midnight, half-open. */
export type DaySpan = readonly [number, number]

/** A route's span from its start and its work, or null where either is not known. */
export function spanOf(day: { startsAt: string | null; workSeconds: number | null }): DaySpan | null {
  if (day.startsAt === null || day.workSeconds === null) return null
  const from = secondsOfDay(day.startsAt)
  return [from, from + day.workSeconds]
}

/** Whether two spans share a moment; one ending as the other starts does not. */
export const spansOverlap = (a: DaySpan, b: DaySpan): boolean => a[0] < b[1] && b[0] < a[1]

/** Another route of the day sharing a crew member, by id, with its span. */
export type SameDayRoute = { id: string; span: DaySpan | null }

/** Why a route and another of its day cannot both have the crew member: a known overlap, or a span not known. */
export type SameDayClash = { kind: "overlap" | "unknown"; routeId: string }

/** The first other route a known span overlaps, else the first whose span — or the route's own — is not known, else nothing. */
export function sameDayClash(asked: DaySpan | null, others: readonly SameDayRoute[]): SameDayClash | undefined {
  if (asked !== null) {
    const overlapping = others.find((other) => other.span !== null && spansOverlap(asked, other.span))
    if (overlapping !== undefined) return { kind: "overlap", routeId: overlapping.id }
  }
  const unknown = others.find((other) => asked === null || other.span === null)
  return unknown === undefined ? undefined : { kind: "unknown", routeId: unknown.id }
}

const clock = (seconds: number): string => {
  const minutes = Math.round(seconds / 60) % (24 * 60)
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`
}

/** A span as a clock reads it: "07:00–11:30". */
export const clockOf = (span: DaySpan): string => `${clock(span[0])}–${clock(span[1])}`

/** "Mads Jensen is planned on route RC-1043 10:00–14:00, which overlaps route RC-1042's 07:00–11:00". */
export const overlappingRoute = (who: string, other: string, otherSpan: DaySpan, route: string, span: DaySpan): string =>
  `${who} is planned on route ${other} ${clockOf(otherSpan)}, which overlaps route ${route}'s ${clockOf(span)}`

/** A same day whose times are not both known, until the office confirms it. */
export const sameDayUnconfirmed = (who: string, other: string, route: string): string =>
  `${who} is planned on route ${other} the same day, and the times of it and route ${route} are not both known (a planned start and a measured Plan); confirm the same day to plan ${who} on both`

/** An allocation over the day reserving the crew member with others: "WH-24 is allocated Mon 5 Oct 06:00–14:00 with Freja Holm; …". */
export const allocatedWithOthers = (who: string, window: string, crew: readonly string[]): string =>
  `${who} is allocated ${window} with ${crew.length <= 1 ? crew.join("") : `${crew.slice(0, -1).join(", ")} and ${crew[crew.length - 1]}`}; plan the route with the allocation's crew, or change the allocation first`
