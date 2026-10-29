// Vehicle maintenance plans (O20 of #290): a vehicle's service intervals —
// every so many days, kilometres or engine hours, any of the three — counted
// from when the service was last done, and the Maintenance Orders the office
// opens to do it.
//
// A plan is due on whichever interval comes first. The date is the last
// service's day plus the days; the kilometres and the hours are the last
// service's reading plus the interval, measured against the vehicle's latest
// reading — what a driver's pre-trip check last read off the dashboard (O13
// of #290), or the last service's own where no check has read one since. A
// plan is `due-soon` inside a margin of each limit — two weeks, a thousand
// kilometres, fifty hours — and `overdue` once a limit is passed; the worker's
// `maintenance-due` rule raises an alert for each (resolution/alert-rules.ts).
//
// Completing a plan's order is the service done: its day and its readings are
// the plan's new baseline, so the plan reads `ok` again and the alert clears.
// The rules here are pure; the API reads the rows and the readings and asks.

/** How long before a date limit a plan reads due soon. */
export const MAINTENANCE_WARNING_DAYS = 14
/** How many kilometres before a distance limit. */
export const MAINTENANCE_WARNING_KM = 1_000
/** How many engine hours before an hours limit. */
export const MAINTENANCE_WARNING_HOURS = 50

/** The largest interval a plan takes of each kind: ten years, two million kilometres, a hundred thousand hours. */
export const MAINTENANCE_INTERVAL_MAX = { days: 3_650, km: 2_000_000, hours: 100_000 } as const

/** Where a plan stands against its limits. */
export const MAINTENANCE_DUE_STATES = ["ok", "due-soon", "overdue"] as const
export type MaintenanceDueState = (typeof MAINTENANCE_DUE_STATES)[number]

/** A plan as the rules read it: its intervals and the baseline of the last service. */
export type MaintenancePlanState = {
  intervalDays: number | null
  intervalKm: number | null
  intervalHours: number | null
  lastDoneOn: string
  lastDoneKm: number | null
  lastDoneHours: number | null
}

/** The vehicle's latest readings, null where nothing has read one. */
export type VehicleReadings = { odometerKm: number | null; engineHours: number | null }

/** Where a plan stands: its next limits, the readings it was judged on, and its state. */
export type MaintenanceDue = {
  state: MaintenanceDueState
  nextDueOn: string | null
  nextDueKm: number | null
  nextDueHours: number | null
  /** The readings the plan was judged on: the vehicle's latest, else the last service's. */
  odometerKm: number | null
  engineHours: number | null
}

const DAY_MS = 86_400_000
const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)

const worse = (a: MaintenanceDueState, b: MaintenanceDueState): MaintenanceDueState => (MAINTENANCE_DUE_STATES.indexOf(a) >= MAINTENANCE_DUE_STATES.indexOf(b) ? a : b)

/** One limit against its reading: passed, within the margin, or not yet. */
const against = (reading: number | null, limit: number | null, margin: number): MaintenanceDueState => {
  if (reading === null || limit === null) return "ok"
  if (reading >= limit) return "overdue"
  return reading >= limit - margin ? "due-soon" : "ok"
}

/** Where a plan stands on a day, with the vehicle's latest readings: the worst of its limits. */
export function maintenanceDue(plan: MaintenancePlanState, today: string, latest: VehicleReadings): MaintenanceDue {
  const nextDueOn = plan.intervalDays === null ? null : addDays(plan.lastDoneOn, plan.intervalDays)
  const nextDueKm = plan.intervalKm === null || plan.lastDoneKm === null ? null : plan.lastDoneKm + plan.intervalKm
  const nextDueHours = plan.intervalHours === null || plan.lastDoneHours === null ? null : plan.lastDoneHours + plan.intervalHours
  // A reading older than the service is the service's own: the larger of the two is the latest.
  const odometerKm = latest.odometerKm === null ? plan.lastDoneKm : Math.max(latest.odometerKm, plan.lastDoneKm ?? 0)
  const engineHours = latest.engineHours === null ? plan.lastDoneHours : Math.max(latest.engineHours, plan.lastDoneHours ?? 0)
  const byDate: MaintenanceDueState = nextDueOn === null ? "ok" : today >= nextDueOn ? "overdue" : today >= addDays(nextDueOn, -MAINTENANCE_WARNING_DAYS) ? "due-soon" : "ok"
  const state = [byDate, against(odometerKm, nextDueKm, MAINTENANCE_WARNING_KM), against(engineHours, nextDueHours, MAINTENANCE_WARNING_HOURS)].reduce(worse, "ok")
  return { state, nextDueOn, nextDueKm, nextDueHours, odometerKm, engineHours }
}

/** What a plan without an interval is told. */
export const AN_INTERVAL = "Give the plan at least one interval: days, kilometres or engine hours"
/** What a distance interval without the odometer it counts from is told. */
export const KM_NEEDS_A_READING = "A distance interval counts from the odometer at the last service: give it"
/** What an hours interval without the engine hours it counts from is told. */
export const HOURS_NEED_A_READING = "An hours interval counts from the engine hours at the last service: give them"

/** The first way a plan's intervals and baseline will not do, at its field; undefined where they will. */
export function planIssue(plan: Omit<MaintenancePlanState, "lastDoneOn">): { path: string; message: string } | undefined {
  if (plan.intervalDays === null && plan.intervalKm === null && plan.intervalHours === null) return { path: "intervalDays", message: AN_INTERVAL }
  if (plan.intervalKm !== null && plan.lastDoneKm === null) return { path: "lastDoneKm", message: KM_NEEDS_A_READING }
  if (plan.intervalHours !== null && plan.lastDoneHours === null) return { path: "lastDoneHours", message: HOURS_NEED_A_READING }
  return undefined
}

/** A plan's next limits as a person reads them: "12 Nov 2026 · 190,000 km · 6,500 h". */
export function nextDueLine(due: Pick<MaintenanceDue, "nextDueOn" | "nextDueKm" | "nextDueHours">): string {
  const grouped = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return [due.nextDueOn, due.nextDueKm === null ? null : `${grouped(due.nextDueKm)} km`, due.nextDueHours === null ? null : `${grouped(due.nextDueHours)} h`].filter((part) => part !== null).join(" · ")
}
