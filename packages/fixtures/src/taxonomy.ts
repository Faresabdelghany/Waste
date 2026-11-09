// The demo tenant's container types and vehicle types, by the names the
// prototype shows them, and which vehicle type empties which container type.
// The web's stop matching resolves a fixture container against them, and
// `pnpm db:seed` writes them as the tenant's vehicle types and their
// compatibility rows (packages/db/src/seed/resources.ts), so the browser's
// rule preview and the server's generation agree on the demo tenant.

/** The container types, as the prototype names each: a kind and a volume. */
export const FIXTURE_CONTAINER_TYPES = [
  "Two-wheel bin · 140 L",
  "Two-wheel bin · 240 L",
  "Four-wheel bin · 660 L",
  "Four-wheel bin · 1,100 L",
  "Igloo · 2,500 L",
  "Underground · 5,000 L",
  "Wastewater tank · 3,000 L",
] as const
export type FixtureContainerType = (typeof FIXTURE_CONTAINER_TYPES)[number]

/**
 * The canonical vehicle types, taken from the fleet fixtures' "Type · depot"
 * context strings ("Rear loader 18 t · Nordhavn", "Glass crane 16 t · Amager",
 * "Organic sealed 12 t · Østerbro", "Paper compactor 14 t · Østerbro") plus
 * the vacuum tanker wastewater tanks require. There is no vehicle-type master
 * data entity in the prototype; this list is the working taxonomy.
 */
export const STOP_MATCH_VEHICLE_TYPES = [
  "Rear loader",
  "Organic sealed",
  "Paper compactor",
  "Glass crane",
  "Vacuum tanker",
] as const
export type StopMatchVehicleType = (typeof STOP_MATCH_VEHICLE_TYPES)[number]

/**
 * Which vehicle types can service each container type (the container side of
 * the server's "fraction + vehicle type" stop matching). Lift-lifted
 * bins take any compactor-style body; igloo and underground containers are
 * crane-emptied; wastewater tanks need suction. A container type absent from
 * this map has no compatibility profile — it is excluded (with a visible
 * reason) whenever the rule constrains the vehicle type, never silently
 * included.
 */
export const CONTAINER_VEHICLE_COMPATIBILITY: Readonly<Record<string, readonly string[]>> = {
  "Two-wheel bin · 140 L": ["Rear loader", "Organic sealed", "Paper compactor"],
  "Two-wheel bin · 240 L": ["Rear loader", "Organic sealed", "Paper compactor"],
  "Four-wheel bin · 660 L": ["Rear loader", "Organic sealed", "Paper compactor"],
  "Four-wheel bin · 1,100 L": ["Rear loader", "Organic sealed", "Paper compactor"],
  "Igloo · 2,500 L": ["Glass crane"],
  "Underground · 5,000 L": ["Glass crane"],
  "Wastewater tank · 3,000 L": ["Vacuum tanker"],
} satisfies Record<FixtureContainerType, readonly StopMatchVehicleType[]>
