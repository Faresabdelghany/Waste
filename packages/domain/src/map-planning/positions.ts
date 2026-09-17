// Where a container sits on the planning map (2026-09-16). Container and
// property records carry no coordinates, so a position is DERIVED from the
// property address: a gazetteer of streets with real anchor coordinates, a
// house-number offset along the street, and a side-of-street offset by
// parity. Every container of one property resolves to the same spot, so
// same-address stacks cluster exactly as they do in the field. Unknown
// addresses hash to a stable point inside the Copenhagen bounds. A record
// that carries typed `latitude` / `longitude` submitted values wins outright.
//
// The gazetteer is the caller's (issue #58): it mirrors whatever registry
// the addresses come from — today the web app's fixture streets — and this
// package cannot see that registry, so it takes the table as an input the
// way statistics.ts takes the asset catalogue. Pure data logic — no map
// library, no store.

import type { BusinessRecord } from "../prototype-record"
import { cleanFact } from "../record-values"
import { avalancheHash } from "../route-schemes/hash"
import { offsetMetres, type LngLat, type LngLatBounds } from "./geo"

/** The default viewport centre: the sidebar identity is Copenhagen Central. */
export const COPENHAGEN_CENTER: LngLat = { lng: 12.5683, lat: 55.6867 }

/** Where hashed fallbacks land — the city inside its ring of suburbs. */
export const COPENHAGEN_BOUNDS: LngLatBounds = {
  west: 12.5,
  south: 55.64,
  east: 12.64,
  north: 55.73,
}

export type StreetAnchor = {
  /** The low-number end of the street. */
  start: LngLat
  /** Compass bearing the house numbers grow along, degrees clockwise from north. */
  bearing: number
}

/**
 * The streets addresses can be placed on, keyed by lower-cased street name
 * as parseAddress spells it ("falkoner allé", "harbor offices"). The
 * numbering direction may be approximate — the picture only has to be
 * plausible and stable.
 */
export type Gazetteer = Readonly<Record<string, StreetAnchor>>

/** Metres of street per house number, and the offset to each kerb. */
const METRES_PER_HOUSE_NUMBER = 9
const KERB_OFFSET_METRES = 14

// A house-number letter ("12A") is only allowed right after the number —
// otherwise it would eat the last letter of a number-less street name
// ("Harbor Offices, Dock 4") and miss the gazetteer.
const ADDRESS_SHAPE = /^\s*([^\d,]+?)\s*(?:(\d+)\s*[a-zA-Z]?)?\s*(?:,|$)/

/**
 * "Ryesgade 45, 2200 København N" → { street: "ryesgade", number: 45 }. The
 * street is composed (NFC) before lower-casing, so a decomposed "é" from a
 * paste still meets the gazetteer's key.
 */
function parseAddress(address: string): { street: string; number: number | null } | null {
  const match = ADDRESS_SHAPE.exec(address)
  if (!match) return null
  const street = match[1].trim().normalize("NFC").toLowerCase()
  if (!street) return null
  return { street, number: match[2] ? Number.parseInt(match[2], 10) : null }
}

function bearingOffset(point: LngLat, metres: number, bearing: number): LngLat {
  const rad = (bearing * Math.PI) / 180
  return offsetMetres(point, Math.sin(rad) * metres, Math.cos(rad) * metres)
}

/** A stable point inside the Copenhagen bounds for anything the gazetteer misses. */
function hashedLocation(seed: string): LngLat {
  const hash = avalancheHash(seed)
  const u = (hash % 9973) / 9973
  const v = (Math.floor(hash / 9973) % 9967) / 9967
  return {
    lng: COPENHAGEN_BOUNDS.west + u * (COPENHAGEN_BOUNDS.east - COPENHAGEN_BOUNDS.west),
    lat: COPENHAGEN_BOUNDS.south + v * (COPENHAGEN_BOUNDS.north - COPENHAGEN_BOUNDS.south),
  }
}

/**
 * The map position of a postal address. `seed` names the place for the
 * hashed fallback and the kerb side — pass the property so every container
 * at that property shares the result.
 */
export function addressLocation(address: string, gazetteer: Gazetteer, seed = address): LngLat {
  return knownAddressLocation(address, gazetteer, seed) ?? hashedLocation(seed || address)
}

/**
 * The kerb position of an address on a gazetteer street, or null when the
 * street is unknown — for callers that would rather leave a stop off the map
 * than scatter it at a hashed spot (route stops named only by address).
 */
export function knownAddressLocation(address: string, gazetteer: Gazetteer, seed = address): LngLat | null {
  const parsed = parseAddress(address)
  // Own keys only: a street called "constructor" must not find Object.prototype.
  const anchor = parsed && Object.hasOwn(gazetteer, parsed.street) ? gazetteer[parsed.street] : undefined
  if (!parsed || !anchor) return null
  const number = parsed.number ?? 1 + (avalancheHash(seed || address) % 40)
  const along = bearingOffset(anchor.start, number * METRES_PER_HOUSE_NUMBER, anchor.bearing)
  const side = number % 2 === 0 ? 1 : -1
  return bearingOffset(along, side * KERB_OFFSET_METRES, anchor.bearing + 90)
}

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
