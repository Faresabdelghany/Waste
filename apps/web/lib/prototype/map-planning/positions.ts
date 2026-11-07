// Where a container or a place sits on the planning map (2026-09-16). A
// record that carries typed `latitude` / `longitude` submitted values wins
// outright; otherwise its address is placed on the caller's gazetteer
// (@waste/fixtures/positions). Pure data logic — no map library, no store.

import type { LngLat } from "@waste/domain/map-planning/geo"
import { addressLocation, knownAddressLocation, type Gazetteer } from "@waste/fixtures/positions"
import type { BusinessRecord } from "../prototype-record"
import { cleanFact, typedString } from "../record-values"

/** Registry states that have no place on the map. */
const OUT_OF_SERVICE_STATUSES: ReadonlySet<string> = new Set(["In storage", "In transit", "Ended"])

function typedCoordinate(record: BusinessRecord, key: string, min: number, max: number): number | null {
  const raw = record.submittedValues?.[key]
  const value = typeof raw === "string" ? Number.parseFloat(raw) : typeof raw === "number" ? raw : NaN
  return Number.isFinite(value) && value >= min && value <= max ? value : null
}

/** The property a container belongs to — the key its position is shared under. */
export function containerPropertyKey(record: BusinessRecord): string | null {
  return cleanFact(record.facts.Property) ?? cleanFact(record.facts.Address) ?? null
}

/**
 * Where a container sits, or null when it has no place on the map: an
 * out-of-service status, or neither a property nor an address. Typed
 * coordinates win; otherwise the property's address decides.
 */
export function containerLocation(record: BusinessRecord, gazetteer: Gazetteer): LngLat | null {
  if (OUT_OF_SERVICE_STATUSES.has(record.status)) return null
  const lat = typedCoordinate(record, "latitude", -90, 90)
  const lng = typedCoordinate(record, "longitude", -180, 180)
  if (lat !== null && lng !== null) return { lng, lat }
  const key = containerPropertyKey(record)
  if (!key) return null
  return addressLocation(cleanFact(record.facts.Address) ?? key, gazetteer, key)
}

/**
 * Where a depot or an unloading station sits, or null when nothing places it
 * (Issue #39): its typed coordinates — the location form requires them —
 * else its address on a gazetteer street. Never a hashed spot: every route
 * of a scheme starts and ends here, and a base drawn where it is not would
 * bend every road on the map.
 */
export function placeLocation(record: BusinessRecord, gazetteer: Gazetteer): LngLat | null {
  const lat = typedCoordinate(record, "latitude", -90, 90)
  const lng = typedCoordinate(record, "longitude", -180, 180)
  if (lat !== null && lng !== null) return { lng, lat }
  const address = cleanFact(record.facts.Address) ?? typedString(record.submittedValues, "address")
  return address ? knownAddressLocation(address, gazetteer) : null
}
