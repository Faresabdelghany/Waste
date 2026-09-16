// Scheme-level scope vocabulary (guided setup step 1, 2026-09-16 round 2):
// the service type a route scheme plans for. The waste fraction is the
// Settings master-data list (asset-management store) and is not repeated
// here. No service-type vocabulary existed anywhere in the repo before this;
// the five values below are the collection work a scheme's routes perform.
// Pure data — no UI or store dependencies.

export const SCHEME_SERVICE_TYPES = [
  "Collection",
  "Exchange",
  "Delivery",
  "Removal",
  "Cleaning",
] as const

export type SchemeServiceType = (typeof SCHEME_SERVICE_TYPES)[number]

export const isSchemeServiceType = (value: unknown): value is SchemeServiceType =>
  typeof value === "string" && (SCHEME_SERVICE_TYPES as readonly string[]).includes(value)
