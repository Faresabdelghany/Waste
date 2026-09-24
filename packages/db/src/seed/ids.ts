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
 * the order their migration creates them.
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
} as const

export type DemoKind = keyof typeof DEMO_KINDS

/** The id of the `ordinal`th record of a kind, counted from 1. */
export function demoId(kind: DemoKind, ordinal: number): string {
  if (!Number.isInteger(ordinal) || ordinal < 1 || ordinal > 0xffff_ffff_ffff) {
    throw new Error(`demoId: the ordinal of a ${kind} must be a whole number from 1, not ${ordinal}`)
  }
  return `${BUCKET}${DEMO_KINDS[kind].toString(16).padStart(3, "0")}-8000-${ordinal.toString(16).padStart(12, "0")}`
}

/** The demo company, Kystbyen Renovation: `demoId("company", 1)`, spelled out because every other row names it. */
export const DEMO_COMPANY_ID = "01a0d2a4-a280-7001-8000-000000000001"

/** The three projects; the Registry fixtures scope to the first two, Cairo has none. */
export const DEMO_PROJECT_IDS = {
  copenhagen: "01a0d2a4-a280-7002-8000-000000000001",
  harbor: "01a0d2a4-a280-7002-8000-000000000002",
  cairo: "01a0d2a4-a280-7002-8000-000000000003",
} as const
