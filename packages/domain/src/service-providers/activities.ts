// Service Provider Activities (#474): one item of coordination between the
// office and one Service Provider about the work it holds under an award — a
// proposal that asks for the office's Approval, a compliance follow-up the
// office raises, or a note either side keeps. An Activity is a record of
// coordination, never a second copy of an operational record: a route's
// assignment is the route's own field and no Activity restates it.
//
// The status moves by command alone (`ACTIVITY_MOVES`), each command taken by
// some kinds only and from some sides only (`COMMAND_SIDES`): the office
// decides a proposal — approve or reject — and never its provider, whose
// account may withdraw it; the office completes or cancels its follow-up; a
// note is completed by either side. Every end is final: a changed mind is a
// new Activity. Overdue is a reading of an open follow-up's due day against
// the project's today, never a status.
//
// What approving a proposal applies is the API's (routes/
// service-provider-activities.ts): the scheme's next version from the
// proposal's day, written through the successor command. What it changes in
// that version is spelled here per kind, so the API and a preview read one rule.
import { SERVICE_DAYS, type RecurrenceFrequency, type ServiceDay } from "../planning/vocabulary"
import type { ServiceProviderActivityKind, ServiceProviderActivityStatus } from "./vocabulary"

/** The two sides of an Activity: the office's accounts and the provider's. */
export type ActivitySide = "office" | "provider"

/** The commands that move an Activity. */
export type ActivityCommand = "approve" | "reject" | "withdraw" | "complete" | "cancel"

/** The kinds that ask for an Approval. */
export const PROPOSAL_KINDS = ["route-day-change", "vehicle-change", "stop-set-change"] as const satisfies readonly ServiceProviderActivityKind[]

export const isProposal = (kind: ServiceProviderActivityKind): boolean => (PROPOSAL_KINDS as readonly string[]).includes(kind)

/** What an Activity is labelled by: the company's running number, as a letter or a call quotes it. */
export const activityLabel = (number: number): string => `ACT-${number}`

/** Where a new Activity of the kind stands. */
export const initialStatus = (kind: ServiceProviderActivityKind): ServiceProviderActivityStatus => (isProposal(kind) ? "pending-approval" : "open")

/** The sides that may open an Activity of each kind: the office raises its follow-ups, either side a proposal or a note. */
const CREATE_SIDES: Readonly<Record<ServiceProviderActivityKind, readonly ActivitySide[]>> = {
  "route-day-change": ["office", "provider"],
  "compliance-follow-up": ["office"],
  "coordination-note": ["office", "provider"],
  "vehicle-change": ["office", "provider"],
  "stop-set-change": ["office", "provider"],
}

export const OFFICE_RAISES_FOLLOW_UPS = "A compliance follow-up is the office's to raise"

/** Why the side may not open an Activity of the kind, or null where it may. */
export function createRefusal(kind: ServiceProviderActivityKind, side: ActivitySide): string | null {
  return CREATE_SIDES[kind].includes(side) ? null : OFFICE_RAISES_FOLLOW_UPS
}

/** The statuses an Activity may still be corrected in: a proposal while it is pending, any other kind while it is open. */
export const OPEN_STATUSES: readonly ServiceProviderActivityStatus[] = ["pending-approval", "open"]

/** What each command moves an Activity from, and to. */
export const ACTIVITY_MOVES: Readonly<Record<ActivityCommand, { from: ServiceProviderActivityStatus; to: ServiceProviderActivityStatus }>> = {
  approve: { from: "pending-approval", to: "approved" },
  reject: { from: "pending-approval", to: "rejected" },
  withdraw: { from: "pending-approval", to: "withdrawn" },
  complete: { from: "open", to: "completed" },
  cancel: { from: "open", to: "cancelled" },
}

/** The commands each kind takes, and the sides that may give each. */
const COMMAND_SIDES: Readonly<Record<ServiceProviderActivityKind, Partial<Record<ActivityCommand, readonly ActivitySide[]>>>> = {
  "route-day-change": { approve: ["office"], reject: ["office"], withdraw: ["office", "provider"] },
  "compliance-follow-up": { complete: ["office"], cancel: ["office"] },
  "coordination-note": { complete: ["office", "provider"] },
  "vehicle-change": { approve: ["office"], reject: ["office"], withdraw: ["office", "provider"] },
  "stop-set-change": { approve: ["office"], reject: ["office"], withdraw: ["office", "provider"] },
}

/** The sides that may give the command on an Activity of the kind; empty where the kind does not take it. */
export const sidesFor = (kind: ServiceProviderActivityKind, command: ActivityCommand): readonly ActivitySide[] => COMMAND_SIDES[kind][command] ?? []

/** A status in a sentence. */
const STATUS_WORDS: Readonly<Record<ServiceProviderActivityStatus, string>> = {
  "pending-approval": "pending approval",
  approved: "approved",
  rejected: "rejected",
  withdrawn: "withdrawn",
  open: "open",
  completed: "completed",
  cancelled: "cancelled",
}

/** A kind in a sentence. */
export const KIND_WORDS: Readonly<Record<ServiceProviderActivityKind, string>> = {
  "route-day-change": "route-day change",
  "compliance-follow-up": "compliance follow-up",
  "coordination-note": "coordination note",
  "vehicle-change": "vehicle change",
  "stop-set-change": "stop-set change",
}

const article = (words: string): string => (/^[aeiou]/.test(words) ? `an ${words}` : `a ${words}`)

export const OFFICE_DECIDES = "Only the office decides a proposal; its provider may withdraw it"
export const OFFICE_CLOSES_FOLLOW_UPS = "A compliance follow-up is the office's to close"

/** What a command given in the wrong status is told: "ACT-3 is approved; reject takes one pending approval". */
export function commandRefusal(label: string, status: ServiceProviderActivityStatus, command: ActivityCommand): string {
  return `${label} is ${STATUS_WORDS[status]}; ${command} takes one ${STATUS_WORDS[ACTIVITY_MOVES[command].from]}`
}

/** What a command the kind does not take is told: "ACT-5 is a coordination note; approve takes a proposal". */
function kindRefusal(label: string, kind: ServiceProviderActivityKind, command: ActivityCommand): string {
  const takers = ACTIVITY_MOVES[command].from === "pending-approval" ? "a proposal" : (Object.keys(COMMAND_SIDES) as ServiceProviderActivityKind[]).filter((other) => sidesFor(other, command).length > 0).map((other) => article(KIND_WORDS[other])).join(" or ")
  return `${label} is ${article(KIND_WORDS[kind])}; ${command} takes ${takers}`
}

export type Move = { ok: true; to: ServiceProviderActivityStatus } | { ok: false; status: 403 | 409; detail: string }

/**
 * Whether the side may give the command on the Activity, judged in the API's
 * order: the kind (a note is never approved, 409), the status (409), then the
 * side (403, the office deciding and closing its follow-ups).
 */
export function closesWith(activity: { number: number; kind: ServiceProviderActivityKind; status: ServiceProviderActivityStatus }, command: ActivityCommand, side: ActivitySide): Move {
  const label = activityLabel(activity.number)
  const sides = sidesFor(activity.kind, command)
  if (sides.length === 0) return { ok: false, status: 409, detail: kindRefusal(label, activity.kind, command) }
  if (activity.status !== ACTIVITY_MOVES[command].from) return { ok: false, status: 409, detail: commandRefusal(label, activity.status, command) }
  if (!sides.includes(side)) return { ok: false, status: 403, detail: isProposal(activity.kind) ? OFFICE_DECIDES : OFFICE_CLOSES_FOLLOW_UPS }
  return { ok: true, to: ACTIVITY_MOVES[command].to }
}

/** The sides that may correct an open Activity of the kind: the side that may open it. */
export const correctedBy = (kind: ServiceProviderActivityKind, side: ActivitySide): boolean => CREATE_SIDES[kind].includes(side)

type Reading = { kind: ServiceProviderActivityKind; status: ServiceProviderActivityStatus; dueOn: string | null }

/** An open Activity whose due day has passed on `day`; the due day itself is still in time. */
export const activityOverdue = (activity: Reading, day: string): boolean => activity.status === "open" && activity.dueOn !== null && day > activity.dueOn

/** An Activity as the office reads it on a day: its status in words, an overdue one said so. */
export function activityReading(activity: Reading, day: string): string {
  const words = STATUS_WORDS[activity.status]
  const status = words.charAt(0).toUpperCase() + words.slice(1)
  return activityOverdue(activity, day) ? `${status} · overdue` : status
}

export const SAME_DAYS = "The proposed days are the days the group runs on already"

/** Why a route-day change of a group running on `current` to `proposed` is no change, or null where it moves a day. */
export function routeDayChangeRefusal(current: readonly ServiceDay[], proposed: readonly ServiceDay[]): string | null {
  const same = current.length === proposed.length && proposed.every((day) => current.includes(day))
  return same ? SAME_DAYS : null
}

export const SAME_CREW = "The proposed vehicle and driver are the group's already"

/** Why a vehicle change of a group running with `current` to `proposed` is no change, or null where it moves the vehicle or the driver; a driver left unsaid keeps the group's. */
export function vehicleChangeRefusal(current: { vehicleId: string | null; driverId: string | null }, proposed: { vehicleId: string; driverId: string | null }): string | null {
  const driver = proposed.driverId ?? current.driverId
  return current.vehicleId === proposed.vehicleId && current.driverId === driver ? SAME_CREW : null
}

export const SAME_STOPS = "The proposed stops are the group's already, in the same order"
export const RULE_GROUP_STOPS = "This group finds its stops by its rule, not a list: propose a waste-fraction change to its rule instead"

/** Why a stop-set change of a group picking `current` to `proposed` is no change, or null where it moves a stop or their order: the list is stop order. */
export function stopSetChangeRefusal(current: readonly string[], proposed: readonly string[]): string | null {
  const same = current.length === proposed.length && current.every((id, index) => proposed[index] === id)
  return same ? SAME_STOPS : null
}

/**
 * The service days a scheme is left with once its groups run on their days
 * as an approval leaves them: the days some group runs on, Monday first. A
 * daily scheme serves every day already and keeps them; a day no group runs
 * on is then the scheme's structure rule to refuse.
 */
export function serviceDaysAfter(frequency: RecurrenceFrequency, serviceDays: readonly ServiceDay[], groups: readonly { days: readonly ServiceDay[] }[]): readonly ServiceDay[] {
  if (frequency === "daily") return serviceDays
  const run = new Set(groups.flatMap((group) => group.days))
  return SERVICE_DAYS.filter((day) => run.has(day))
}
