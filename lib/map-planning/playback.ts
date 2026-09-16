// Route stop playback (2026-09-16): where the vehicle stands and what it has
// driven at a given progress — a fractional stop index, 0 at the first stop,
// stops.length − 1 at the last. With a road geometry the vehicle follows each
// leg by distance; without one it moves straight between stops. Also the
// clock arithmetic the caption shows (planned vs actual, "+9 min"). Pure.

import type { LngLat } from "./geo"
import type { RoadGeometry } from "./road-geometry"

/** How far a second of playback at 1× moves the vehicle, in stops. */
export const PLAYBACK_STOPS_PER_SECOND = 0.6

export type PlaybackFrame = {
  position: LngLat
  /** The path driven so far, first stop first, the position last. */
  travelled: LngLat[]
}

const METRES_PER_DEGREE_LAT = 111_320
const SAME_POINT_DEGREES = 1e-7

/** Flat-earth metres between two points, longitude scaled at the first point's latitude. */
function metresBetween(a: LngLat, b: LngLat): number {
  const cosLat = Math.cos((a.lat * Math.PI) / 180)
  return Math.hypot((b.lng - a.lng) * METRES_PER_DEGREE_LAT * cosLat, (b.lat - a.lat) * METRES_PER_DEGREE_LAT)
}

const lerp = (a: LngLat, b: LngLat, t: number): LngLat => ({
  lng: a.lng + (b.lng - a.lng) * t,
  lat: a.lat + (b.lat - a.lat) * t,
})

const samePoint = (a: LngLat, b: LngLat) =>
  Math.abs(a.lng - b.lng) < SAME_POINT_DEGREES && Math.abs(a.lat - b.lat) < SAME_POINT_DEGREES

/** The point `fraction` of the way along `path` by distance, and the vertices passed to get there. */
function walk(path: readonly LngLat[], fraction: number): { position: LngLat; passed: LngLat[] } {
  if (path.length === 1 || fraction <= 0) return { position: path[0], passed: [path[0]] }
  const lengths = path.slice(1).map((point, index) => metresBetween(path[index], point))
  let remaining = Math.min(1, fraction) * lengths.reduce((sum, length) => sum + length, 0)
  const passed: LngLat[] = [path[0]]
  for (let index = 1; index < path.length; index += 1) {
    const length = lengths[index - 1]
    if (remaining <= length || index === path.length - 1) {
      const t = length === 0 ? 1 : Math.min(1, remaining / length)
      return { position: lerp(path[index - 1], path[index], t), passed }
    }
    remaining -= length
    passed.push(path[index])
  }
  return { position: path[path.length - 1], passed }
}

export function playbackFrame(
  stops: readonly LngLat[],
  geometry: RoadGeometry | null,
  progress: number,
): PlaybackFrame | null {
  if (stops.length === 0) return null
  if (stops.length === 1) return { position: stops[0], travelled: [stops[0]] }
  const last = stops.length - 1
  const clamped = Math.min(Math.max(progress, 0), last)
  const leg = Math.min(Math.floor(clamped), last - 1)
  const fraction = clamped - leg
  const legPath = (index: number): readonly LngLat[] => {
    const road = geometry?.legs[index]
    return road && road.length >= 2 ? road : [stops[index], stops[index + 1]]
  }

  const travelled: LngLat[] = []
  const append = (point: LngLat) => {
    if (travelled.length === 0 || !samePoint(travelled[travelled.length - 1], point)) travelled.push(point)
  }
  for (let index = 0; index < leg; index += 1) legPath(index).forEach(append)
  const { position, passed } = walk(legPath(leg), fraction)
  passed.forEach(append)
  append(position)
  return { position, travelled }
}

/** "06:32" → 392 minutes since midnight; anything else → null. */
export function clockMinutes(value: string | null | undefined): number | null {
  const match = /^\s*(\d{1,2}):(\d{2})\s*$/.exec(value ?? "")
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null
}

/** Actual minus planned, in minutes, when both clocks are known. */
export function stopDelay(planned: string | null, actual: string | null): number | null {
  const plannedMinutes = clockMinutes(planned)
  const actualMinutes = clockMinutes(actual)
  return plannedMinutes === null || actualMinutes === null ? null : actualMinutes - plannedMinutes
}

export function formatDelay(minutes: number): string {
  if (minutes === 0) return "On time"
  return minutes > 0 ? `+${minutes} min` : `−${Math.abs(minutes)} min`
}

/** The next progress after `deltaMs` at `speed`, clamped to the last stop, which ends the journey. */
export function advancePlayback(
  progress: number,
  deltaMs: number,
  speed: number,
  stopCount: number,
): { progress: number; done: boolean } {
  const last = Math.max(0, stopCount - 1)
  const next = progress + (deltaMs / 1000) * speed * PLAYBACK_STOPS_PER_SECOND
  return next >= last ? { progress: last, done: true } : { progress: next, done: false }
}
