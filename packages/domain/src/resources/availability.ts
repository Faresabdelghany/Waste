// When a driver or a vehicle is not there (O6 of #290): a driver's absence
// and a vehicle's unavailability are dated periods, half-open over days
// (ADR-0005) — `validFrom` the first day away, `validTo` the first day back,
// null while the return is not known — and one of each per driver or vehicle
// covers a day (the database's exclusion). Recording one is never refused for
// the work already planned on its days: somebody falls ill whatever the plan
// says. What refuses is naming them afresh — an allocation over the days, a
// collection group on its first run day from the day its crew is judged, a
// route on its operating date, a dispatch whose planned crew is away — each a
// 409 after every 400 of the command, in the sentences below, like the status
// gates.
//
// Generation reads the same periods (`crewOnDay`): a route it writes or
// refreshes on a day its group's driver is away, or its vehicle out of use,
// goes without that one, with the run's warning; a route the office holds
// keeps what the office set, and the run only warns. The periods are days,
// since what they are judged against is: a route's operating date, a group's
// service days, an allocation's window rendered as the project's days.
//
// Pure: days are `YYYY-MM-DD`, compared as strings; a person reads a period
// by its last day in, never the wire's first day out.

import { formatOccurrenceShortDate } from "../route-schemes/occurrences"
import { addDays, serviceDayOf, type ServiceDay } from "../route-schemes/recurrence"

/** A period a driver is away or a vehicle out of use: half-open over days, an open end while the return is not known. */
export type AwayPeriod = { validFrom: string; validTo: string | null; reason: string }

/** Whether the period touches the days `[from, toExclusive)`; a null end on either side reaches every later day. */
export const overlapsDays = (period: Pick<AwayPeriod, "validFrom" | "validTo">, from: string, toExclusive: string | null): boolean =>
  (toExclusive === null || period.validFrom < toExclusive) && (period.validTo === null || from < period.validTo)

/** The earliest period touching the days `[from, toExclusive)`, or undefined when none does. */
export function awayOver<P extends AwayPeriod>(periods: readonly P[], from: string, toExclusive: string | null): P | undefined {
  return [...periods].filter((period) => overlapsDays(period, from, toExclusive)).sort((a, b) => a.validFrom.localeCompare(b.validFrom))[0]
}

/** The period covering the day, or undefined. */
export const awayOn = <P extends AwayPeriod>(periods: readonly P[], day: string): P | undefined => awayOver(periods, day, addDays(day, 1))

/** The period as a person reads it, by its last day in: "on Mon 5 Oct", "Mon 5 Oct – Fri 9 Oct", "from Mon 5 Oct". */
export function periodPhrase(period: Pick<AwayPeriod, "validFrom" | "validTo">): string {
  if (period.validTo === null) return `from ${formatOccurrenceShortDate(period.validFrom)}`
  const lastDay = addDays(period.validTo, -1)
  return lastDay === period.validFrom ? `on ${formatOccurrenceShortDate(period.validFrom)}` : `${formatOccurrenceShortDate(period.validFrom)} – ${formatOccurrenceShortDate(lastDay)}`
}

/** What a command naming the driver or the vehicle needs it for, as its sentence says. */
export type AvailabilityNeed = "a route" | "a vehicle allocation" | "a collection group"

/** "Mads Jensen is absent Mon 5 Oct – Fri 9 Oct (holiday); a route needs a driver who is there". */
export const absentDriver = (name: string, period: AwayPeriod, need: AvailabilityNeed): string => `${name} is absent ${periodPhrase(period)} (${period.reason}); ${need} needs a driver who is there`

/** "CN 42 018 is unavailable on Tue 6 Oct (maintenance); a route needs a vehicle that is there". */
export const unavailableVehicle = (label: string, period: AwayPeriod, need: AvailabilityNeed, as: "vehicle" | "trailer" = "vehicle"): string =>
  `${label} is unavailable ${periodPhrase(period)} (${period.reason}); ${need} needs a ${as} that is there`

/** A dispatch to a planned driver who is away: "Mads Jensen is absent on Mon 5 Oct (sick); dispatch the route to a driver who is there". */
export const absentForDispatch = (name: string, period: AwayPeriod): string => `${name} is absent ${periodPhrase(period)} (${period.reason}); dispatch the route to a driver who is there`

/** A dispatch on a planned vehicle or trailer out of use: "NR-12 is unavailable on Fri 9 Oct (maintenance); dispatch the route with a vehicle that is there". */
export const unavailableForDispatch = (label: string, period: AwayPeriod, as: "vehicle" | "trailer" = "vehicle"): string =>
  `${label} is unavailable ${periodPhrase(period)} (${period.reason}); dispatch the route with a ${as} that is there`

/**
 * The day a collection group's crew is asked about: the first day on or after
 * `from` — the day its licence is judged, the scheme's first day or today —
 * that falls on one of the group's days, or undefined for a group parked
 * with none. A group recurs, so the days after it are generation's to judge,
 * route by route.
 */
export function firstRunDay(from: string, days: readonly ServiceDay[]): string | undefined {
  if (days.length === 0) return undefined
  for (let offset = 0; offset < 7; offset += 1) {
    const day = addDays(from, offset)
    if (days.includes(serviceDayOf(day))) return day
  }
  return undefined
}

/** A second absence over a day one already covers. */
export const alreadyAbsent = (name: string, period: AwayPeriod): string => `${name} is already absent ${periodPhrase(period)} (${period.reason}); one absence covers a day`

/** A second period of unavailability over a day one already covers. */
export const alreadyUnavailable = (label: string, period: AwayPeriod): string => `${label} is already unavailable ${periodPhrase(period)} (${period.reason}); one period covers a day`

/** Who a crew member is on a route: its driver, its vehicle or its trailer. */
export type CrewRole = "driver" | "vehicle" | "trailer"

/** The crew a route takes on its day: each member, less the one away, and the period that left each off. A trailer is a vehicle's period too. */
export type CrewOnDay = { driverId: string | null; vehicleId: string | null; trailerId: string | null; driverAway?: AwayPeriod; vehicleAway?: AwayPeriod; trailerAway?: AwayPeriod }

/** What generation writes of a crew on a route's operating date: each one, unless a period of theirs covers the day. */
export function crewOnDay(
  crew: { driverId: string | null; vehicleId: string | null; trailerId?: string | null },
  day: string,
  periods: { driver: ReadonlyMap<string, readonly AwayPeriod[]>; vehicle: ReadonlyMap<string, readonly AwayPeriod[]> },
): CrewOnDay {
  const trailerId = crew.trailerId ?? null
  const driverAway = crew.driverId === null ? undefined : awayOn(periods.driver.get(crew.driverId) ?? [], day)
  const vehicleAway = crew.vehicleId === null ? undefined : awayOn(periods.vehicle.get(crew.vehicleId) ?? [], day)
  const trailerAway = trailerId === null ? undefined : awayOn(periods.vehicle.get(trailerId) ?? [], day)
  return {
    driverId: driverAway === undefined ? crew.driverId : null,
    vehicleId: vehicleAway === undefined ? crew.vehicleId : null,
    trailerId: trailerAway === undefined ? trailerId : null,
    ...(driverAway === undefined ? {} : { driverAway }),
    ...(vehicleAway === undefined ? {} : { vehicleAway }),
    ...(trailerAway === undefined ? {} : { trailerAway }),
  }
}

const awayWord = (role: CrewRole) => (role === "driver" ? "absent" : "unavailable")

/** The run's warning for a route written without its group's driver or vehicle: "Mads Jensen is absent on Mon 12 Oct (holiday): RC-1042 is written without a planned driver". */
export const crewLeftOff = (role: CrewRole, name: string, day: string, period: AwayPeriod, route: string): string =>
  `${name} is ${awayWord(role)} on ${formatOccurrenceShortDate(day)} (${period.reason}): ${route} is written without a planned ${role}`

/** The run's warning for a route the office holds whose crew is away on its day: the office's word stands, and the run says so. */
export const heldCrewAway = (role: CrewRole, name: string, day: string, period: AwayPeriod, route: string): string =>
  `${name} is ${awayWord(role)} on ${formatOccurrenceShortDate(day)} (${period.reason}), and ${route}, which the office holds, still names ${role === "driver" ? "them" : "it"}`
