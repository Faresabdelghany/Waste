// The generated half of the demo registry (moved here 2026-09-30 by issue
// #99): the fifty seeded properties and the hundred seeded containers beside
// the explicit fixture records. Two readers build from this one spelling —
// the web prototype's fixture registry (`apps/web/lib/data/business-modules.ts`)
// shapes each into a record, and `pnpm db:seed`
// (`packages/db/src/seed/registry.ts`) reads each into the Registry's
// columns — so `property-seed-101` is Ryesgade 3 in the browser and on the
// server alike, and `asset-seed-91001` is BIN-91001 standing at it.
//
// What lives here is what both readers need: the counts, the street, owner,
// type and fraction tables, the rotations and moduli over the index, and the
// ids and numbers derived from it. The values are spelled the way the
// prototype shows them ("Mixed use", "Two-wheel bin · 140 L", "Customer
// owned"); the seed states beside its own tables how it reads each into a
// column. What only the prototype shows (update labels, sensors, fill
// levels, calendars, route schemes) stays with the web's record shaping.
//
// Places go through `FIXTURE_GAZETTEER` (./gazetteer), which anchors every
// street here; ./__tests__ pins the rows both readers have shown.

/** A project the generated records are in: the fixture projects' keys. */
export type SeededProject = "copenhagen" | "harbor"

export const SEEDED_PROPERTY_COUNT = 50
/** The first thirty-five properties are Copenhagen Central's, the rest Harbor Commercial's. */
export const SEEDED_PROPERTY_COPENHAGEN_COUNT = 35
export const SEEDED_CONTAINER_COUNT = 100
/** The first seventy containers stand in Copenhagen Central, the rest in Harbor Commercial. */
export const SEEDED_CONTAINER_COPENHAGEN_COUNT = 70

/** A street and its postal district; the property index rotates through its project's list. */
const COPENHAGEN_STREETS: ReadonlyArray<readonly [string, string]> = [
  ["Ryesgade", "2200 København N"],
  ["Blegdamsvej", "2100 København Ø"],
  ["Jagtvej", "2200 København N"],
  ["Amagerbrogade", "2300 København S"],
  ["Istedgade", "1650 København V"],
  ["Godthåbsvej", "2000 Frederiksberg"],
  ["Falkoner Allé", "2000 Frederiksberg"],
  ["Strandboulevarden", "2100 København Ø"],
  ["Tagensvej", "2400 København NV"],
  ["Enghavevej", "1674 København V"],
  ["Østerbrogade", "2100 København Ø"],
  ["Vigerslev Allé", "2500 Valby"],
]

const HARBOR_STREETS: ReadonlyArray<readonly [string, string]> = [
  ["Sandkaj", "2150 Nordhavn"],
  ["Orientkaj", "2150 Nordhavn"],
  ["Sundkrogsgade", "2150 Nordhavn"],
  ["Trelleborggade", "2150 Nordhavn"],
  ["Helsinkigade", "2150 Nordhavn"],
]

const OWNERS = ["Østerbro Housing", "KAB Bolig", "Jeudan A/S", "DEAS Ejendomme", "Private", "By & Havn"] as const

export const SEEDED_PROPERTY_TYPES = ["Residential", "Commercial", "Mixed use"] as const
export type SeededPropertyType = (typeof SEEDED_PROPERTY_TYPES)[number]

export type SeededPropertyStatus = "Active" | "Prospect" | "On hold"

export type SeededProperty = {
  recordId: string
  project: SeededProject
  /** The street and house number: `Ryesgade 3`. */
  name: string
  /** The name and the postal district: `Ryesgade 3, 2200 København N`. */
  address: string
  propertyNumber: string
  propertyType: SeededPropertyType
  /** An organisation's name, or `Private`. */
  owner: string
  /** The owner, or `Municipal payer`. */
  payer: string
  status: SeededPropertyStatus
  /** The one agreement the property is served under: `AGR-2600`. */
  agreementNumber: string
}

export const SEEDED_WASTE_FRACTIONS = ["Residual", "Organic", "Paper", "Cardboard", "Glass", "Plastic", "Metal"] as const
export type SeededWasteFraction = (typeof SEEDED_WASTE_FRACTIONS)[number]

export const SEEDED_CONTAINER_TYPES = [
  "Two-wheel bin · 140 L",
  "Two-wheel bin · 240 L",
  "Four-wheel bin · 660 L",
  "Four-wheel bin · 1,100 L",
  "Igloo · 2,500 L",
  "Underground · 5,000 L",
] as const
export type SeededContainerType = (typeof SEEDED_CONTAINER_TYPES)[number]

export type SeededContainerStatus = "Available" | "Defect" | "Future" | "On hold" | "In storage"
export type SeededOwnership = "Company owned" | "Customer owned"

/** A planning area of the fixtures: its record id and its name. */
export type SeededPlanningArea = { id: string; name: string }

// Planning-area links for declarative stop matching (issue #19): every
// container in service belongs to one planning area. Copenhagen containers
// rotate across the three Copenhagen areas; Harbor containers all sit in the
// harbor's.
const COPENHAGEN_AREAS: readonly SeededPlanningArea[] = [
  { id: "area-indreby", name: "Indre By Operations" },
  { id: "area-osterbro-contract", name: "Østerbro Zone 2" },
  { id: "area-amager-1", name: "Amager Zone 1" },
]
const HARBOR_AREA: SeededPlanningArea = { id: "area-harbor-1", name: "Nordhavn Harbor Area" }

export type SeededContainer = {
  recordId: string
  binNumber: number
  /** `BIN-91001`. */
  label: string
  project: SeededProject
  /** The seeded property it stands at, or would stand at once out of storage. */
  propertyIndex: number
  status: SeededContainerStatus
  /** Every status but In storage: standing at its property. */
  inService: boolean
  fraction: SeededWasteFraction
  containerType: SeededContainerType
  barcode: string
  /** Null where the prototype shows "Not recorded". */
  rfid: string | null
  serialNumber: string
  ownership: SeededOwnership
  /** The cadence it promises in service; none in storage. */
  serviceFrequencyId: "freq-every-2-weeks" | "freq-weekly" | null
  /** The planning area it files under in service; none in storage. */
  planningArea: SeededPlanningArea | null
}

function checkedIndex(index: number, count: number, what: string): number {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new RangeError(`there are ${count} seeded ${what}, numbered from 0; ${index} is none of them`)
  }
  return index
}

export function seededPropertyRecordId(index: number): string {
  return `property-seed-${101 + checkedIndex(index, SEEDED_PROPERTY_COUNT, "properties")}`
}

export function seededContainerRecordId(index: number): string {
  return `asset-seed-${91001 + checkedIndex(index, SEEDED_CONTAINER_COUNT, "containers")}`
}

export function seededProperty(index: number): SeededProperty {
  checkedIndex(index, SEEDED_PROPERTY_COUNT, "properties")
  const inCopenhagen = index < SEEDED_PROPERTY_COPENHAGEN_COUNT
  const streets = inCopenhagen ? COPENHAGEN_STREETS : HARBOR_STREETS
  const [street, postal] = streets[index % streets.length]
  const name = `${street} ${3 + ((index * 7) % 120)}`
  const owner = OWNERS[index % OWNERS.length]
  return {
    recordId: seededPropertyRecordId(index),
    project: inCopenhagen ? "copenhagen" : "harbor",
    name,
    address: `${name}, ${postal}`,
    propertyNumber: `CPH-9${1000 + index}`,
    propertyType: SEEDED_PROPERTY_TYPES[index % SEEDED_PROPERTY_TYPES.length],
    owner,
    payer: index % 4 === 3 ? "Municipal payer" : owner,
    status: index % 12 === 7 ? "Prospect" : index % 12 === 10 ? "On hold" : "Active",
    agreementNumber: `AGR-${2600 + index}`,
  }
}

/** The status a container's place in the cycle of twenty gives it. */
function containerStatus(cycle: number): SeededContainerStatus {
  if (cycle === 5) return "Defect"
  if (cycle === 8) return "Future"
  if (cycle === 11) return "On hold"
  if (cycle === 17) return "In storage"
  return "Available"
}

export function seededContainer(index: number): SeededContainer {
  checkedIndex(index, SEEDED_CONTAINER_COUNT, "containers")
  const inCopenhagen = index < SEEDED_CONTAINER_COPENHAGEN_COUNT
  const propertyIndex = inCopenhagen
    ? index % SEEDED_PROPERTY_COPENHAGEN_COUNT
    : SEEDED_PROPERTY_COPENHAGEN_COUNT +
      ((index - SEEDED_CONTAINER_COPENHAGEN_COUNT) % (SEEDED_PROPERTY_COUNT - SEEDED_PROPERTY_COPENHAGEN_COUNT))
  const binNumber = 91001 + index
  const status = containerStatus(index % 20)
  const inService = status !== "In storage"
  const area = inCopenhagen ? COPENHAGEN_AREAS[index % COPENHAGEN_AREAS.length] : HARBOR_AREA
  return {
    recordId: seededContainerRecordId(index),
    binNumber,
    label: `BIN-${binNumber}`,
    project: inCopenhagen ? "copenhagen" : "harbor",
    propertyIndex,
    status,
    inService,
    fraction: SEEDED_WASTE_FRACTIONS[index % SEEDED_WASTE_FRACTIONS.length],
    containerType: SEEDED_CONTAINER_TYPES[index % SEEDED_CONTAINER_TYPES.length],
    barcode: `WH${binNumber}`,
    rfid: index % 4 === 3 ? null : `E200${binNumber}`,
    serialNumber: `SEED-26-${binNumber}`,
    ownership: index % 5 === 4 ? "Customer owned" : "Company owned",
    serviceFrequencyId: inService ? (index % 2 === 0 ? "freq-every-2-weeks" : "freq-weekly") : null,
    planningArea: inService ? { ...area } : null,
  }
}
