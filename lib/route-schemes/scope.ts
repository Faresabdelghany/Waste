// Scheme-level scope vocabulary (guided setup step 1): the service type a
// route scheme plans for and, defined ONCE here, the container types each
// service type collects (round 3, 2026-09-16). The waste fraction is the
// Settings master-data list (asset-management store) and is not repeated
// here. No asset-type ↔ service-type relation exists in the data model, so
// this table is the mapping; the group editor offers only a service type's
// container types and checkCollectionGroups names a group whose types fall
// outside it. Pure data — no UI or store dependencies.
//
// The three values are the prototype's. Round 2's five (Collection, Exchange,
// Delivery, Removal, Cleaning) mapped to nothing and are not read: a stored
// "Collection" is treated as unset.

export const SCHEME_SERVICE_TYPES = [
  "Container collection",
  "Underground collection",
  "Kerbside collection",
] as const

export type SchemeServiceType = (typeof SCHEME_SERVICE_TYPES)[number]

export const isSchemeServiceType = (value: unknown): value is SchemeServiceType =>
  typeof value === "string" && (SCHEME_SERVICE_TYPES as readonly string[]).includes(value)

/**
 * Container types (display vocabulary, matching.ts) per service type. Two-
 * wheel 140 L bins are kerbside bins too — the prototype's vocabulary had no
 * 140 L. Igloo · 2,500 L and Wastewater tank · 3,000 L belong to no service
 * type yet (ticketed).
 */
export const SERVICE_TYPE_CONTAINER_TYPES: Readonly<Record<SchemeServiceType, readonly string[]>> = {
  "Container collection": ["Two-wheel bin · 240 L", "Four-wheel bin · 660 L", "Four-wheel bin · 1,100 L"],
  "Underground collection": ["Underground · 5,000 L"],
  "Kerbside collection": ["Two-wheel bin · 140 L", "Two-wheel bin · 240 L"],
}

/** The container types a scheme of this service type may collect; null = no service type, no restriction. */
export function allowedContainerTypes(serviceType: string | undefined): readonly string[] | null {
  return isSchemeServiceType(serviceType) ? SERVICE_TYPE_CONTAINER_TYPES[serviceType] : null
}

/** The given container types the service type does not collect, in the given order. */
export function containerTypesOutsideServiceType(
  containerTypes: readonly string[],
  serviceType: string | undefined,
): string[] {
  const allowed = allowedContainerTypes(serviceType)
  if (!allowed) return []
  return containerTypes.filter((type) => !allowed.includes(type))
}
