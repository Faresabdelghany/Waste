// The due-from-last cadence (M11 of #293): a tank installation's emptying
// falls due its interval in months after the last one, not on a calendar's
// day. The scheme's own recurrence (generateOccurrences) still gives the days
// the tanker runs; on those days a tank is a stop from its due date on, and
// only on the first of them: once a stop is held for it, the later days pass
// it over until an emptying is completed and moves the due date on. The
// generation run (planning/generation.ts `resolveStops`) and every read of a
// tank's next emptying reckon it here.
// Pure date math — no UI, store, or fixture dependencies.

/** What the cadence reads of an installation: the day it was last emptied, if ever, and its interval. */
export type TankCadence = {
  /** The last emptying's day: a completed stop's, else the register's word for one before the platform; null for never. */
  lastEmptiedOn: string | null
  /** Whole months between emptyings. */
  intervalMonths: number
}

/** `iso` moved by `months` calendar months; a day the month lacks lands on its last day (30 November + 3 months is 28 February). */
export function addMonths(iso: string, months: number): string {
  const [year, month, day] = iso.split("-").map(Number) as [number, number, number]
  const index = year * 12 + (month - 1) + months
  const targetYear = Math.floor(index / 12)
  const targetMonth = (index % 12) + 1
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate()
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`
}

/** The day the next emptying falls due: the last one plus the interval; null for a tank never emptied, which is due now. */
export const tankDueOn = (cadence: TankCadence): string | null => (cadence.lastEmptiedOn === null ? null : addMonths(cadence.lastEmptiedOn, cadence.intervalMonths))

/** The day a run judges, and the tanks with a stop held on an earlier date of it: a planned stop not yet completed, or one the run planned. */
export type TankGate = { day: string; held: ReadonlySet<string> }

/** Whether a container waits on the gate's day: a tank not yet due, or due with its stop already held on an earlier date. A container that is no tank never waits. */
export function tankWaits(candidate: { containerId: string; tank: TankCadence | null }, gate: TankGate): boolean {
  if (candidate.tank === null) return false
  if (gate.held.has(candidate.containerId)) return true
  const due = tankDueOn(candidate.tank)
  return due !== null && gate.day < due
}
