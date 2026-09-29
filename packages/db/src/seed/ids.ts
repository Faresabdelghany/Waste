// The id scheme every demo row is spelled in (Issue #70, extended for the
// Registry). A UUID version 7 by hand: the first twelve hex digits are a
// millisecond (2026-09-24, when the seed was written), the third group's `7`
// the version and its other three digits the KIND of record, the fourth
// group's `8` the variant, and the last group an ordinal counted in hex — a
// counted constant is recognisable in a log where a random one is not, and
// these are demo data, not secrets. The local database and the hosted project
// hold the same ids, so a token minted against one opens the same rows on the
// other and a test can name a row without looking it up.
//
// The Organisation & Access ids stay spelled out in demo.ts as they were
// written; `demoId` is the same scheme as a function, for the Registry's
// hundreds of rows, and seed.test.ts holds the two spellings together. This
// module exists so registry.ts can name the company and the projects without
// importing demo.ts, which imports it.

/** The millisecond and the version nibble: everything before the kind. */
const BUCKET = "01a0d2a4-a280-7"

/**
 * Which kind of record an id names: the twelve bits after the version nibble.
 * Organisation & Access took 1 to 6; the Registry's fifteen tables follow in
 * the order the schema files read them (`src/schema/index.ts`: catalogue,
 * customers, agreements, containers), which is not the order drizzle-kit
 * wrote their CREATE TABLE statements into migration 0004. Planning,
 * Resources and Finance continue from `0x016` in the order #143 allocated
 * them, the seeding build order, one kind per table that receives rows —
 * `collection_group_container_type` receives none and has none.
 */
export const DEMO_KINDS = {
  company: 0x001,
  project: 0x002,
  serviceProvider: 0x003,
  role: 0x004,
  user: 0x005,
  serviceProviderAccess: 0x006,
  wasteFraction: 0x007,
  containerType: 0x008,
  serviceFrequency: 0x009,
  product: 0x00a,
  customer: 0x00b,
  property: 0x00c,
  propertyParty: 0x00d,
  propertyGroup: 0x00e,
  propertyGroupMember: 0x00f,
  sharedCollectionPoint: 0x010,
  sharedCollectionPointMember: 0x011,
  agreement: 0x012,
  subscription: 0x013,
  container: 0x014,
  containerServicePlacement: 0x015,
  planningArea: 0x016,
  planningAreaBoundary: 0x017,
  collectionCalendar: 0x018,
  collectionCalendarHoliday: 0x019,
  routeScheme: 0x01a,
  collectionGroup: 0x01b,
  collectionGroupFraction: 0x01c,
  collectionGroupContainer: 0x01d,
  vehicleType: 0x01e,
  containerTypeVehicleType: 0x01f,
  depot: 0x020,
  warehouse: 0x021,
  unloadingStation: 0x022,
  unloadingStationFraction: 0x023,
  vehicle: 0x024,
  vehicleCompartment: 0x025,
  vehicleCompartmentFraction: 0x026,
  driver: 0x027,
  priceList: 0x028,
  priceListRow: 0x029,
} as const

export type DemoKind = keyof typeof DEMO_KINDS

/** The id of the `ordinal`th record of a kind, counted from 1. */
export function demoId(kind: DemoKind, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 0xffff_ffff_ffff) {
    throw new Error(`demoId: the ordinal of a ${kind} must be a whole number from 1, not ${ordinal}`)
  }
  return `${BUCKET}${DEMO_KINDS[kind].toString(16).padStart(3, "0")}-8000-${ordinal.toString(16).padStart(12, "0")}`
}

/** Ids of one kind, handed out in the order the rows are built. */
export function counted(kind: DemoKind): () => string {
  let ordinal = 0
  return () => demoId(kind, ++ordinal)
}

/** One id of the kind per item, counted in the items' order and keyed by what `keyOf` calls the item; a key spelled twice is refused. */
export function keyed<T>(items: readonly T[], keyOf: (item: T) => string, kind: DemoKind): Record<string, string> {
  const next = counted(kind)
  const ids: Record<string, string> = {}
  for (const item of items) {
    const key = keyOf(item)
    if (ids[key]) throw new Error(`demo seed: ${key} is spelled twice`)
    ids[key] = next()
  }
  return ids
}

/** The id keyed `key`, or the seed's own sentence: a misspelled reference is never a 23502 from the database. */
export function required(ids: Readonly<Record<string, string>>, key: string, what: string): string {
  const id = ids[key]
  if (!id) throw new Error(`demo seed: no ${what} is keyed ${key}`)
  return id
}

/** The spec keyed `key`, the same way: never a TypeError from a Map. */
export function requiredSpec<T>(specs: ReadonlyMap<string, T>, key: string, what: string): T {
  const spec = specs.get(key)
  if (spec === undefined) throw new Error(`demo seed: no ${what} is keyed ${key}`)
  return spec
}

/** The demo company, Kystbyen Renovation: `demoId("company", 1)`, spelled out because every other row names it. */
export const DEMO_COMPANY_ID = "01a0d2a4-a280-7001-8000-000000000001"

/** The three projects; the Registry fixtures scope to the first two, Cairo has none. */
export const DEMO_PROJECT_IDS = {
  copenhagen: "01a0d2a4-a280-7002-8000-000000000001",
  harbor: "01a0d2a4-a280-7002-8000-000000000002",
  cairo: "01a0d2a4-a280-7002-8000-000000000003",
} as const

/** The two service providers, which Resources' vehicles and drivers name. */
export const DEMO_SERVICE_PROVIDER_IDS = {
  nordren: "01a0d2a4-a280-7003-8000-000000000001",
  cityhaul: "01a0d2a4-a280-7003-8000-000000000002",
} as const

/** The three accounts; Mads Jensen's is the one a driver profile names (#140, #143). */
export const DEMO_USER_IDS = {
  fares: "01a0d2a4-a280-7005-8000-000000000001",
  lars: "01a0d2a4-a280-7005-8000-000000000002",
  mads: "01a0d2a4-a280-7005-8000-000000000003",
} as const
