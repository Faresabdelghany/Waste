// The Driver App's position recorder (O8 of #290, decided on #344). This
// consciously reverses #125's Q7 and Q14 for an open session: until O8 a
// position travelled only with a driver's tap (location.ts); now, while a
// session is open, not paused, and its route's screen is shown, the phone is
// watched and where the vehicle is recorded, so the office sees a track and
// the stale-position rule has something to judge. Nothing is recorded on the
// start screen, while paused, after the route ends, or in the background: a
// web page gets no fixes once its screen is off or its tab hidden, and this
// promises nothing more.
//
// Which fix is kept is the domain's rule (`keepsFix`, POSITION_RULES): 100 m
// or better, 30 s and 25 m from the last kept fix, or 120 s after it wherever
// it is. Kept fixes collect in one open batch for the route, which is closed
// two minutes after its first fix or at sixty fixes (`batchDue`) — or at
// once, when the controller asks before a pause or the route's end, so the
// fixes reach the door before the command that would refuse them. The
// recorder holds no storage of its own: the controller is told of the open
// batch on every change (`changed`, which it keeps as the queue's
// `collecting` row, so a reload while offline loses none) and of a closed one
// (`closed`, which it queues as a `record-positions` command).
import type { PositionFix } from "@waste/domain/execution/positions"
import { batchDue, keepsFix, POSITION_RULES } from "@waste/domain/execution/positions"

import type { DriverRouteDetail } from "@waste/contracts/driver-commands"

import { BROWSER_TIMERS, type Timers } from "./timers"

/** The open batch: the route its session runs on, and the fixes kept so far, oldest first. */
export type PositionBatch = { routeId: string; points: PositionFix[] }

/** What the recorder watches the phone through: the browser's `navigator.geolocation`, a fake in the tests. */
export type PositionWatcher = Pick<Geolocation, "watchPosition" | "clearWatch">

export type PositionRecorderOptions = {
  geolocation: Partial<PositionWatcher> | null | undefined
  now?: () => number
  timers?: Timers
  /** The open batch changed, or is gone (null) because it closed or the recording stopped empty. */
  changed: (batch: PositionBatch | null) => void
  /** A batch closed with its fixes: queue it. */
  closed: (batch: PositionBatch) => void
}

export type PositionRecorder = {
  /** Records for this route from now on, no fix from before `since` (its session's start, which the door holds every fix to), or stops (null); a route followed already goes on as it was. Stopping closes the open batch. */
  follow: (routeId: string | null, since?: string) => void
  /** Closes the open batch now, if it holds a fix. */
  close: () => void
  /** Stops watching and drops the timer, closing nothing: the page is going, and the controller's `collecting` row is the next page's. */
  dispose: () => void
}

/** Whether the door's last read of a route has this driver's session open and not paused on it: what the controller records for, and what the route screen tells the driver it shares. */
export function sessionRecords(detail: Pick<DriverRouteDetail, "status" | "session">, driverId: string | undefined): boolean {
  const open = detail.session
  return detail.status === "active" && open !== null && open.endedAt === null && open.pausedAt === null && open.driverId === driverId
}

/** The fastest a road vehicle is said to go, in whole km/h: the contracts' bound on a fix's speed. */
const SPEED_MAX_KMH = 300

/** A phone's reading as a fix, in the contracts' whole units; the speed and the heading only where the phone gave them. */
export function fixOf({ coords, timestamp }: Pick<GeolocationPosition, "coords" | "timestamp">): PositionFix {
  const fix: PositionFix = {
    at: new Date(timestamp).toISOString(),
    location: { type: "Point", coordinates: [coords.longitude, coords.latitude] },
    accuracyM: Math.max(1, Math.ceil(coords.accuracy)),
  }
  if (typeof coords.speed === "number" && Number.isFinite(coords.speed) && coords.speed >= 0) fix.speedKmh = Math.min(SPEED_MAX_KMH, Math.round(coords.speed * 3.6))
  // A phone standing still gives no heading (null or NaN).
  if (typeof coords.heading === "number" && Number.isFinite(coords.heading) && coords.heading >= 0) fix.headingDeg = Math.round(coords.heading) % 360
  return fix
}

export function createPositionRecorder({ geolocation, now = Date.now, timers = BROWSER_TIMERS, changed, closed }: PositionRecorderOptions): PositionRecorder {
  let followed: string | null = null
  let since = Number.NEGATIVE_INFINITY
  let watchId: number | null = null
  let last: PositionFix | null = null
  let batch: PositionBatch | null = null
  let timer: unknown = null

  const clearTimer = () => {
    if (timer !== null) timers.clear(timer)
    timer = null
  }

  const close = () => {
    clearTimer()
    const done = batch
    batch = null
    if (done === null || done.points.length === 0) return
    changed(null)
    closed(done)
  }

  const kept = (routeId: string, position: GeolocationPosition) => {
    if (followed !== routeId) return
    const fix = fixOf(position)
    // A fix from ahead of the phone's own clock, or a cached one from before the session started, is a reading the door would refuse.
    const at = Date.parse(fix.at)
    if (at > now() || at < since) return
    if (!keepsFix(last, fix)) return
    last = fix
    if (batch === null) {
      batch = { routeId, points: [] }
      timer = timers.set(close, POSITION_RULES.batchMs)
    }
    batch = { routeId, points: [...batch.points, fix] }
    changed(batch)
    if (batchDue(batch.points, now())) close()
  }

  const stop = () => {
    if (watchId !== null) geolocation?.clearWatch?.(watchId)
    watchId = null
  }

  return {
    follow: (routeId, from) => {
      if (routeId === followed) return
      stop()
      close()
      followed = routeId
      since = from === undefined ? Number.NEGATIVE_INFINITY : Date.parse(from)
      last = null
      if (routeId === null || geolocation?.watchPosition === undefined) return
      try {
        // A fix up to ten seconds old is as good as a new one for a track kept every thirty.
        watchId = geolocation.watchPosition(
          (position) => kept(routeId, position),
          () => {
            // Refused or unavailable: nothing is recorded, and the office's stale-position rule says so.
          },
          { enableHighAccuracy: true, maximumAge: 10_000 },
        )
      } catch {
        // A browser that throws instead of calling back (an insecure origin in some) has no position to give.
        watchId = null
      }
    },
    close,
    dispose: () => {
      stop()
      clearTimer()
      followed = null
    },
  }
}
