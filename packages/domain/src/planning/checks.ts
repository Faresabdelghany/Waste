// What a validated Route Scheme has to hold together (Issue #97, ADR-0002):
// the structural rules the API refuses a write with when the scheme is, or
// would become, `validated`. A `draft` accepts partial configuration; a
// validated scheme is what the generation job plans from, so every service
// day has a Collection Group that runs on it (the glossary's rule), a rule
// group names at least one waste fraction to match, a manual group picks at
// least one container, and a rule group has a Planning Area to match inside
// — all four of which the database cannot say across rows.
//
// Spelled once, over plain shapes, so the create, the scheme's patch, the
// group's create and patch and the two set replacements all answer the same
// sentences: `schemeStructureIssues` returns every sentence that holds, in a
// fixed order (the uncovered days, then each group's own sentence in group
// order, then the planning area once), and the route joins them into its 409.
// Nothing here knows a row, a body or a status: the caller decides when the
// rules apply and hands in what they are held against.
//
// The second rule the API holds across a scheme's groups is here too: no
// container is picked by two Collection Groups that run on a shared day,
// since one bin is collected by one route a day. `containerPickedTwice` finds
// the first container of a list that another group already picks on a day
// both run, so the route can refuse the entry by its position in the body.
//
// Resources (Issue #101, slice 6) gave a group its vehicle and its default
// driver, and with them the other half of the glossary's sentence — "no
// vehicle, driver, or container is on two groups the same day" — joins the
// structural rules: `resourcesOnTwoGroups` names every vehicle and every
// driver that two or more groups running on a shared day share, one sentence
// per resource and day ("Vehicle WH-24 is on two collection groups that run
// on monday: North, South"), vehicles before drivers, resources in the order
// the groups first name them, days in weekday order, and
// `schemeStructureIssues` lists them after the planning area. A group's
// `vehicle` and `driver` come in as an id and a label, since the rule compares
// ids and a person reads a callsign or a name, and the caller has the rows.
//
// The one rule here that is not structural is the group's own, whatever the
// scheme's status: a group naming both a vehicle and a driver names a driver
// who may take that vehicle (resources/licence.ts), judged on the day the
// scheme's period starts or today, whichever is later (#101 §6.18) — the
// weaker reading, since a scheme runs for years and a licence renews.
// `schemeLicenceDay` picks that day and says what it meant, so the expiry
// sentence ends "before the scheme starts" or "before today", and
// `groupDriverIssue` is the sentence or nothing; the route answers it as a
// 400 on `driverId`, the same words an allocation refuses with.
import { licenceRefusal, licenceSentence, type Licence } from "../resources/licence"
import type { LicenceClass } from "../resources/vocabulary"
import { SERVICE_DAYS } from "./vocabulary"

/** A vehicle or a driver as the two-groups rule sees it: the id the groups are compared on, and the label a person reads in the sentence. */
export type NamedResource = { id: string; label: string }

/** One Collection Group as the structural rules see it: what it is called, when it runs, how it finds its stops, and how many of each it names. */
export type GroupStructure = {
  name: string
  /** The weekdays the group runs on; a subset of the scheme's. */
  days: readonly string[]
  /** `rule` or `manual` — how the group finds its stops. */
  stopSource: string
  /** The waste fractions the rule matches; meaningful for a rule group. */
  fractionCount: number
  /** The containers picked by hand; meaningful for a manual group. */
  containerCount: number
  /** The vehicle the group runs with, or null while unsaid (Issue #101); absent when the caller has no fleet to speak of. */
  vehicle?: NamedResource | null
  /** The default driver, likewise. */
  driver?: NamedResource | null
}

/** A Route Scheme as the structural rules see it: the days it serves, whether it has a Planning Area, and its groups in position order. */
export type SchemeStructure = {
  serviceDays: readonly string[]
  hasPlanningArea: boolean
  collectionGroups: readonly GroupStructure[]
}

/** The sentence for the days no group runs on; the days are listed in weekday order, Monday first. */
export const serviceDaysWithoutGroup = (days: readonly string[]): string => `Service days without a collection group: ${days.join(", ")}`

/** The sentence for a rule group with nothing to match. */
export const ruleWithoutFraction = (group: string): string => `Collection group ${group} matches by rule but names no waste fraction`

/** The sentence for a manual group with nothing picked. */
export const manualWithoutContainer = (group: string): string => `Collection group ${group} picks containers but names none`

/** The sentence for a rule group with nowhere to match inside; said once, however many rule groups the scheme has. */
export const NO_PLANNING_AREA_FOR_RULE = "The scheme has no planning area and a collection group matches by rule"

/** The days of `days` in weekday order, Monday first, each once; a day outside the seven keeps its place at the end. */
function inWeekdayOrder(days: readonly string[]): string[] {
  const known = SERVICE_DAYS.filter((day) => days.includes(day))
  const unknown = [...new Set(days.filter((day) => !(SERVICE_DAYS as readonly string[]).includes(day)))]
  return [...known, ...unknown]
}

/**
 * Every structural sentence that holds against the scheme, in a fixed order,
 * or an empty list for a scheme that stands. A route answers a non-empty list
 * as a 409 listing them; a draft scheme is never asked.
 */
export function schemeStructureIssues(scheme: SchemeStructure): string[] {
  const issues: string[] = []

  const covered = new Set(scheme.collectionGroups.flatMap((group) => group.days))
  const uncovered = inWeekdayOrder(scheme.serviceDays.filter((day) => !covered.has(day)))
  if (uncovered.length > 0) issues.push(serviceDaysWithoutGroup(uncovered))

  let byRule = false
  for (const group of scheme.collectionGroups) {
    if (group.stopSource === "rule") {
      byRule = true
      if (group.fractionCount < 1) issues.push(ruleWithoutFraction(group.name))
    } else if (group.containerCount < 1) {
      issues.push(manualWithoutContainer(group.name))
    }
  }

  if (byRule && !scheme.hasPlanningArea) issues.push(NO_PLANNING_AREA_FOR_RULE)
  issues.push(...resourcesOnTwoGroups(scheme.collectionGroups))
  return issues
}

/** A count as a sentence spells it: "two collection groups"; past nine, digits. */
const SPELLED = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
const spelled = (n: number): string => SPELLED[n] ?? String(n)

/** The sentence for a vehicle or a driver two or more groups run with on one day, naming the groups in group order. */
export const onTwoGroups = (kind: "Vehicle" | "Driver", label: string, day: string, groups: readonly string[]): string =>
  `${kind} ${label} is on ${spelled(groups.length)} collection groups that run on ${day}: ${groups.join(", ")}`

/**
 * Every vehicle and every driver that two or more groups share on a day they
 * both run, one sentence per resource and day: vehicles first, then drivers;
 * resources in the order the groups first name them; days in weekday order.
 * Two groups that never share a day may share a vehicle — Monday's route and
 * Thursday's are the same truck — so a group with no days conflicts with
 * nothing, and a group naming no vehicle or no driver is left out.
 */
export function resourcesOnTwoGroups(groups: readonly GroupStructure[]): string[] {
  const issues: string[] = []
  const readers: readonly [kind: "Vehicle" | "Driver", of: (group: GroupStructure) => NamedResource | null | undefined][] = [
    ["Vehicle", (group) => group.vehicle],
    ["Driver", (group) => group.driver],
  ]
  for (const [kind, of] of readers) {
    const named = new Map<string, { label: string; groups: GroupStructure[] }>()
    for (const group of groups) {
      const resource = of(group)
      if (resource == null) continue
      const found = named.get(resource.id)
      if (found === undefined) named.set(resource.id, { label: resource.label, groups: [group] })
      else found.groups.push(group)
    }
    for (const { label, groups: sharing } of named.values()) {
      if (sharing.length < 2) continue
      for (const day of SERVICE_DAYS) {
        const onDay = sharing.filter((group) => group.days.includes(day))
        if (onDay.length >= 2) issues.push(onTwoGroups(kind, label, day, onDay.map((group) => group.name)))
      }
    }
  }
  return issues
}

/** The day a group's driver is judged on, and what that day meant, for the sentence. */
export type JudgedDay = { day: string; meaning: "the scheme starts" | "today" }

/**
 * The day a collection group's driver is held to their licence on: the day
 * the scheme's period starts, or today, whichever is later — a scheme that
 * started last year is asked about today, one starting next spring about
 * its first day. Both are `YYYY-MM-DD` days on the project's clock, so the
 * comparison is on the strings; the caller renders today in the project's
 * timezone. A scheme starting today is judged on the day it starts.
 */
export function schemeLicenceDay(validFrom: string, today: string): JudgedDay {
  return validFrom >= today ? { day: validFrom, meaning: "the scheme starts" } : { day: today, meaning: "today" }
}

/** What the group's rule reads of the pair it holds together: the vehicle's class and label, the driver's licence and name. */
export type GroupDriverCheck = {
  vehicle: { label: string; requiredLicenceClass: LicenceClass }
  driver: Licence & { name: string }
}

/**
 * Why the group's driver may not take the group's vehicle on the judged day,
 * as the sentence the route answers at `driverId`, or undefined when they
 * may: the licence rule of resources/licence.ts, the expiry sentence ending
 * with what the day meant.
 */
export function groupDriverIssue(check: GroupDriverCheck, judged: JudgedDay): string | undefined {
  const refusal = licenceRefusal(check.driver, check.vehicle.requiredLicenceClass, judged.day)
  if (refusal === undefined) return undefined
  return licenceSentence(refusal, { driver: check.driver.name, vehicle: check.vehicle.label }, judged.meaning)
}

/** A group's picks as the two-groups-one-day rule sees them: its name, its days and the containers it picks in stop order. */
export type ContainerPick = {
  group: string
  days: readonly string[]
  containerIds: readonly string[]
}

/** Which container of a list another group already picks, by which group and on which day. */
export type PickedTwice = {
  /** The position of the container in the list that was held. */
  index: number
  /** The group that already picks it. */
  group: string
  /** The first day, in weekday order, that both groups run on. */
  day: string
}

/** The sentence a container picked by two groups on a shared day is refused with, at the entry that was refused. */
export const alreadyPicked = (found: Pick<PickedTwice, "group" | "day">): string => `Already picked by ${found.group} on ${found.day}`

/**
 * The first container of `picked` that a group of `others` already picks on
 * a day both run on, or undefined when the list is free of them. Two groups
 * that never share a day may pick the same container — Monday's route and
 * Thursday's both empty the same bin — so a group with no days conflicts with
 * nothing. `others` is every group but the one being written: the ones
 * before it in a create body, or the scheme's other stored groups.
 */
export function containerPickedTwice(others: readonly ContainerPick[], picked: Pick<ContainerPick, "days" | "containerIds">): PickedTwice | undefined {
  const runsOn = new Set(picked.days)
  for (const [index, containerId] of picked.containerIds.entries()) {
    for (const other of others) {
      if (!other.containerIds.includes(containerId)) continue
      const shared = inWeekdayOrder(other.days.filter((day) => runsOn.has(day)))
      if (shared.length > 0) return { index, group: other.group, day: shared[0] }
    }
  }
  return undefined
}
