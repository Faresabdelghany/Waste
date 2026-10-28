// Live positions (O8 of #290, decided on #344): while a session runs, the
// Driver App records where the vehicle is, and the office reads it as a
// track. This reverses #125's Q7 and Q14 for an open session only — a
// position travelled only with a driver's tap before — and keeps what the
// owner decided on #344:
//
//   recording — only while the session is open, not paused, and the route
//               screen is shown; a fix of 100 m or better is kept when it is
//               30 s and 25 m from the last kept one, or 120 s after it
//               whatever the distance, so a parked vehicle still reads as
//               alive (`keepsFix`);
//   batching  — the kept fixes collect in one queued `record-positions`
//               command, closed after two minutes or sixty fixes, whichever
//               comes first (`POSITION_RULES`), and drained with the rest of
//               the Command Queue, so a position survives a dead zone and is
//               idempotent through the receipt like every command;
//   retention — personal location data (#381): a point is kept
//               `POSITION_RETENTION_DAYS` days, a Pilot setting, and never
//               more than `POSITION_RETENTION_CEILING_DAYS`, which is also
//               what the worker's purge keeps when the setting is unset.
//
// The rules here are the device's and the purge's; what the door judges of a
// command's points — the clock bounds and the session's start, point by
// point — is `decide`'s (commands.ts).
import type { FlatPoint } from "./commands"

/** One fix as the device kept it: when, where, how well it knew, and the speed and heading where the phone gave them, in whole units. */
export type PositionFix = {
  /** The fix's own instant, RFC 3339: the phone's `timestamp`, not the tap's. */
  at: string
  location: FlatPoint
  /** Whole metres, the coarser side of the phone's reading. */
  accuracyM: number
  /** Whole kilometres an hour, where the phone gave a speed. */
  speedKmh?: number
  /** Whole degrees clockwise from true north, 0..359, where the phone gave a heading. */
  headingDeg?: number
}

export const POSITION_RULES = {
  /** The coarsest fix kept: the bound a command's own position already takes (#125). */
  accuracyM: 100,
  /** A fix nearer in time than this to the last kept one is dropped, however far it moved. */
  minIntervalMs: 30_000,
  /** Beyond the interval, a fix nearer than this to the last kept one is dropped… */
  minDistanceM: 25,
  /** …until this long has passed, when it is kept wherever it is: a vehicle standing still is still heard of. */
  heartbeatMs: 120_000,
  /** A command's fixes are closed and queued this long after its first. */
  batchMs: 120_000,
  /** And no more than this many in one command: the contracts' `POSITIONS_MAX`. At a fix every thirty seconds the two minutes close a batch long before it, so this is the door's bound on any device, not the Driver App's pace. */
  batchMax: 60,
} as const

/** The longest a position is kept, in days, whatever the setting says; and what is kept when it says nothing. */
export const POSITION_RETENTION_CEILING_DAYS = 30

/** The days a purge keeps: the setting, never past the ceiling, and the ceiling when unset. */
export const positionRetentionDays = (setting: number | undefined): number => (setting === undefined ? POSITION_RETENTION_CEILING_DAYS : Math.min(setting, POSITION_RETENTION_CEILING_DAYS))

const EARTH_RADIUS_M = 6_371_008.8
const radians = (degrees: number): number => (degrees * Math.PI) / 180

/** The great-circle distance between two points, in metres: haversine over the mean Earth radius, near enough at a kerb's scale. */
export function metresBetween(a: FlatPoint, b: FlatPoint): number {
  const [lonA, latA] = a.coordinates
  const [lonB, latB] = b.coordinates
  const dLat = radians(latB - latA)
  const dLon = radians(lonB - lonA)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(latA)) * Math.cos(radians(latB)) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** Whether the device keeps this fix after the last kept one (null: none kept yet this session). */
export function keepsFix(last: PositionFix | null, next: PositionFix): boolean {
  if (next.accuracyM > POSITION_RULES.accuracyM) return false
  if (last === null) return true
  const elapsed = Date.parse(next.at) - Date.parse(last.at)
  if (elapsed < POSITION_RULES.minIntervalMs) return false
  if (elapsed >= POSITION_RULES.heartbeatMs) return true
  return metresBetween(last.location, next.location) >= POSITION_RULES.minDistanceM
}

/** Whether a command's open batch is due to be closed and queued: two minutes after its first fix, or full. */
export function batchDue(batch: readonly PositionFix[], now: number): boolean {
  const first = batch[0]
  if (first === undefined) return false
  return batch.length >= POSITION_RULES.batchMax || now - Date.parse(first.at) >= POSITION_RULES.batchMs
}
