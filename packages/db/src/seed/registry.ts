// The Registry's demo rows (2026-09-25): what `pnpm db:seed` writes into the
// fifteen tables of Issue #78, derived from the web prototype's fixtures so
// that the adapter of build-order step 4 ("fixtures become seed data") has the
// same company to show on the server as the browser shows from
// `apps/web/lib/data/business-modules.ts`.
//
// Derived, not imported: `packages/db` may not depend on the web (ADR-0001 runs
// the other way, and the web may not depend on this package either), so the
// explicit fixture records are copied here as literals and the two generated
// sets — the fifty seeded properties and the hundred seeded containers — are
// rebuilt from the same literal tables and the same arithmetic as the web's
// `buildSeededPropertyRecords` and `buildSeededContainerRecords`, index by
// index, so `property-seed-101` here is the Ryesgade 3 the prototype shows and
// `asset-seed-91001` is BIN-91001 standing at it. The copy is deliberate and
// temporary: the generator's tables and arithmetic and the gazetteer are now
// spelled twice, here and in the web, with nothing holding them together, and
// their one home is `@waste/domain` (pure, imported by both), which a
// follow-up issue moves them to; until then a change to the web's generator
// does not reach here by itself, and the header of that file says so too.
// REGISTRY_IDS keys every row by the prototype's record id (`asset-82014`,
// `property-seed-101`, `AGR-2408`) so the adapter can map one onto the other
// without a lookup table of its own.
//
// Where a fixture value is read into a column it does not spell exactly, the
// rule is written beside the table it applies to, and every such rule is
// listed in the pull request that added it. The ones that shape the picture:
//
//   Scope. Waste fractions, container types and customers are the company's;
//   everything else is a project's. The prototype scopes its products and
//   frequencies to Copenhagen Central AND Harbor Commercial, so both carry a
//   row per product and per cadence; Cairo Operations has no Registry
//   fixture and gets nothing here.
//
//   Statuses and kinds. A closed list here is
//   `@waste/domain/registry/vocabulary`. A property the prototype calls Active
//   or Data issue is `active`; Prospect and On hold are `inactive` (not served
//   today). A shared point with a Billing issue is `open` — the issue is
//   Finance's flag, the point takes waste. A property's kind is the fixture's
//   Property type; Sundbyvej 91's own record carries none, and the one fixture
//   fact that names it is its container BIN-44831's "Property type:
//   Commercial", so it is `commercial`. Every other status maps by name.
//
//   Parties. A property's Owner and Payer facts become `property_party` rows
//   on a Customer of that name; an Owner of `Private` is a person Customer of
//   this property's own (`Private owner · Ryesgade 31`), since a person has
//   no natural key and the prototype names none, and a Payer of `Municipal
//   payer` is one organisation, Københavns Kommune. Harbor Offices ApS is the
//   `tenant` of Dock 4 (Harbor Properties owns it) and its payer is
//   unconfirmed, so there is no payer row. Mikkel Sørensen is the
//   `service-contact` of every Østerbro East property, the portfolio the
//   prototype makes him the contact of.
//
//   Agreements. The two fixture agreements, AGR-2408 and AGR-2512, plus the
//   ones the prototype names by number and nowhere else: AGR-2188 on
//   Sundbyvej 91 (BIN-44831's) and AGR-2600 to AGR-2649, one per seeded
//   property, active from 2026-01-01 except a Prospect's, which is a draft
//   from 2026-10-01. AGR-2512 has no start date in the fixture ("Start date
//   pending"); its container's agreement "starts next month" with a first
//   collection on 3 Sep 2026, so it runs from 2026-09-01, still a draft. Its
//   payer is unconfirmed in the fixture, and `payer_customer_id` is NOT NULL,
//   so the payer is the customer until one is confirmed — the rule every
//   agreement here follows unless the fixture names another payer. Every
//   agreement is billed monthly in DKK. AGR-2331 (Nørrebrogade 144) and
//   AGR-1844 (Vesterbrogade 72) are not here: their properties are not
//   fixture properties.
//
//   Placements. A placement serves a subscription, and a subscription is a
//   product at a place; the prototype's catalogue has a container-collection
//   product for residual waste, for cardboard (its fraction is labelled
//   "Paper & cardboard", so paper too) and for glass, and none for organic,
//   plastic, metal, mixed or wastewater. A container in service whose fraction
//   one of those products collects is placed under it at its property, in the
//   agreement the prototype names; its fixture container type stays on the
//   container row even where the product is sold with another size (a 5,000 L
//   underground residual container under the 240 L residual product). A
//   container of any other fraction is seeded and stands unplaced — BIN-82014
//   at Parkvej 18 among them, since no organic product exists — as does one
//   in storage, in transit, ended, or at a property that is not a fixture
//   (BIN-66420). The subscription's quantity is the number of containers
//   placed under it, at least one; AGR-2408 also carries the residual and the
//   paper subscription its description names, with nothing placed under them.
//   A subscription runs for its agreement's period, and a placement inside its
//   subscription's: from the subscription's start, or from 2026-10-01 for a
//   container the prototype marks Future, to the subscription's end — the
//   containment the API refuses to break (routes/periods.ts), held here when
//   the rows are built. A placement whose cadence equals the product's default
//   carries null, since the effective cadence is read through `coalesce`, and
//   one whose cadence differs carries its own.
//
//   Points. A property on a gazetteer street is located where the map places
//   it: `knownAddressLocation` from @waste/domain over a literal copy of the
//   web's FIXTURE_GAZETTEER, rounded to six decimals (about a decimetre), so
//   the stored point is the derived one. Dock 4's own service address is not
//   on a gazetteer street; it is placed as its container BIN-77104 is, by the
//   container's Address fact "Harbor Offices, Dock 4" with the container's
//   Property fact, "Harbor Offices", as the seed — not the property's name.
//   The two shared points have no fixture coordinates and need one: Kongens
//   Nytorv is at the square itself (12.5855, 55.6805), the Nordhavn dock point
//   at the gazetteer's Sandkaj anchor (12.5965, 55.7085), and both take the
//   street as their address.
//
//   Members. The fixtures name member counts, not members, so a membership
//   follows a rule the fixture states, over the properties of the group's or
//   point's own project: Østerbro East Portfolio gathers the properties
//   Østerbro Housing owns; Valby Organic Service Group the properties in 2500
//   Valby; Nordhavn Dock Shared Cardboard the properties of kind commercial,
//   as service members; Kongens Nytorv serves properties within 350 m, and no
//   fixture property is, so it has none.
//
//   Invoicing (Issue #156). A product carries its fixture's Invoice name and
//   Invoice code and its VAT, 25 % on every one, in both projects: the three
//   columns migration 0010 gave the product, which Finance & Contracting's
//   billable events read. Its prices are Finance's rows (finance.ts).
//
//   Map places (Issue #156). A container's Planning area, Address and
//   Property facts are copied as where the prototype's map places it
//   (`mapped`): no Registry column holds them — a container carries no
//   location and no area — and Planning's seed draws each planning area's
//   boundary around them (planning.ts).
//
//   Left out, having no column: a property's PropertyID (P-88014) — its
//   Property number (CPH-001882) is the `registry_id` — an agreement's
//   Template and PriceList, a product's price (a Price List's row, Finance's),
//   a container's sensor, fill level, calendar and route scheme (Planning's
//   and Resources' own rows say those), and every metric and free-text count
//   ("24 records", "118 properties").
//
// Every reference from one row to another goes through `required` or
// `requiredSpec`, so a key misspelled here is this file's own sentence and
// not a 23502 from the database or a TypeError from a Map.
import type { Point } from "@waste/contracts/geojson"
import { knownAddressLocation, type Gazetteer } from "@waste/domain/map-planning/positions"
import type {
  AgreementStatus,
  ContainerOwnership,
  CustomerKind,
  ProductKind,
  ProductStatus,
  ProductUnit,
  PropertyKind,
  PropertyPartyRole,
  PropertyStatus,
} from "@waste/domain/registry/vocabulary"

import type { Tx } from "../client"
import { agreement, subscription } from "../schema/agreements"
import { containerType, product, serviceFrequency, wasteFraction } from "../schema/catalogue"
import { container, containerServicePlacement } from "../schema/containers"
import {
  customer,
  property,
  propertyGroup,
  propertyGroupMember,
  propertyParty,
  sharedCollectionPoint,
  sharedCollectionPointMember,
} from "../schema/customers"
import { counted, DEMO_COMPANY_ID, DEMO_PROJECT_IDS, keyed, required, type DemoKind } from "./ids"
import { upsertOwned } from "./upsert"

const COMPANY_ID = DEMO_COMPANY_ID

/** The projects the Registry fixtures scope to; Cairo Operations has none. */
const REGISTRY_PROJECTS = ["copenhagen", "harbor"] as const
/** A project the catalogue, and so a product or a price list, is in. */
export type RegistryProject = (typeof REGISTRY_PROJECTS)[number]
const projectIdOf = (project: RegistryProject): string => DEMO_PROJECT_IDS[project]

/* ------------------------------ the catalogue ------------------------------ */

// The seven fractions the seeded containers rotate through, then the two only
// the explicit containers carry (BIN-66420 takes "Residual · Mixed", BIN-11862
// wastewater). The key is the container form's option value where the form
// has one; the name is the display vocabulary the fixtures spell.
const WASTE_FRACTIONS = [
  ["residual", "Residual"],
  ["organic", "Organic"],
  ["paper", "Paper"],
  ["cardboard", "Cardboard"],
  ["glass", "Glass"],
  ["plastic", "Plastic"],
  ["metal", "Metal"],
  ["mixed", "Mixed"],
  ["wastewater", "Wastewater"],
] as const
type WasteFractionKey = (typeof WASTE_FRACTIONS)[number][0]

// The domain's CONTAINER_VEHICLE_COMPATIBILITY keys, the one container type
// vocabulary, with the volume read off the name. The key follows the
// container form's enum ids (`two-wheel-240`, `four-wheel-660`,
// `four-wheel-1100`, `wastewater-3000`) and spells the rest the same way.
const CONTAINER_TYPES = [
  ["two-wheel-140", "Two-wheel bin · 140 L", 140],
  ["two-wheel-240", "Two-wheel bin · 240 L", 240],
  ["four-wheel-660", "Four-wheel bin · 660 L", 660],
  ["four-wheel-1100", "Four-wheel bin · 1,100 L", 1100],
  ["igloo-2500", "Igloo · 2,500 L", 2500],
  ["underground-5000", "Underground · 5,000 L", 5000],
  ["wastewater-3000", "Wastewater tank · 3,000 L", 3000],
] as const
type ContainerTypeKey = (typeof CONTAINER_TYPES)[number][0]

/** A container type's key by the name the domain's tables spell it in: `Two-wheel bin · 240 L` is `two-wheel-240`. */
export const CONTAINER_TYPE_KEYS: Readonly<Record<string, ContainerTypeKey>> = Object.fromEntries(CONTAINER_TYPES.map(([key, name]) => [name, key]))

// @waste/domain/service-frequencies SERVICE_FREQUENCIES, one row per project
// the definition names (both). The shape satisfies `service_frequency_shape`:
// a rate with one interval or none, or no rate and no interval.
const SERVICE_FREQUENCIES = [
  ["freq-weekly", "Every week", "One collection per week on the serviced weekday.", 1, 1, null],
  ["freq-every-2-weeks", "Every 2 weeks", "One collection every second week (14-day service).", 1, 2, null],
  [
    "freq-monthly",
    "Once a month",
    "The first serviced weekday of each month. No faithful weeks-between value exists — the real model is strictly week-based.",
    1,
    null,
    null,
  ],
  ["freq-on-demand", "On demand", "No standing cadence — collections are ordered per occasion.", null, null, null],
] as const
type ServiceFrequencyKey = (typeof SERVICE_FREQUENCIES)[number][0]

// The seven `commercial.products` fixtures, one row per project. Container
// types are read from the fixture's own label: "240L bin" is the 240 L
// two-wheel bin, "660L container" the 660 L four-wheel bin, and "Igloo 3m³",
// which the type vocabulary does not have, the 2,500 L igloo. "Paper &
// cardboard" is the cardboard fraction. Only the residual product names a
// cadence in the fixture.
type ProductSpec = {
  key: string
  name: string
  kind: ProductKind
  status: ProductStatus
  unit: ProductUnit
  containerType: ContainerTypeKey | null
  wasteFraction: WasteFractionKey | null
  serviceFrequency: ServiceFrequencyKey | null
  invoiceName: string
  invoiceCode: string
  vatPercent: number
}
const PRODUCTS: readonly ProductSpec[] = [
  {
    key: "product-res-240",
    name: "Residual waste · 240L bin",
    kind: "container-collection",
    status: "active",
    unit: "pickup",
    containerType: "two-wheel-240",
    wasteFraction: "residual",
    serviceFrequency: "freq-every-2-weeks",
    invoiceName: "Residual waste collection 240L",
    invoiceCode: "RES-240",
    vatPercent: 25,
  },
  {
    key: "product-card-660",
    name: "Cardboard · 660L container",
    kind: "container-collection",
    status: "active",
    unit: "pickup",
    containerType: "four-wheel-660",
    wasteFraction: "cardboard",
    serviceFrequency: null,
    invoiceName: "Cardboard collection 660L",
    invoiceCode: "CRD-660",
    vatPercent: 25,
  },
  {
    key: "product-glass-igloo",
    name: "Glass igloo emptying",
    kind: "container-collection",
    status: "active",
    unit: "pickup",
    containerType: "igloo-2500",
    wasteFraction: "glass",
    serviceFrequency: null,
    invoiceName: "Glass igloo emptying",
    invoiceCode: "GLS-IGL",
    vatPercent: 25,
  },
  {
    key: "product-clean-monthly",
    name: "Bin cleaning · monthly",
    kind: "recurring-service",
    status: "active",
    unit: "month",
    containerType: null,
    wasteFraction: null,
    serviceFrequency: null,
    invoiceName: "Bin cleaning subscription",
    invoiceCode: "SRV-CLN",
    vatPercent: 25,
  },
  {
    key: "product-bulky",
    name: "Bulky waste pickup",
    kind: "additional-service",
    status: "active",
    unit: "job",
    containerType: null,
    wasteFraction: null,
    serviceFrequency: null,
    invoiceName: "Bulky waste pickup",
    invoiceCode: "SRV-BLK",
    vatPercent: 25,
  },
  {
    key: "product-bagtag",
    name: "Extra bag tag",
    kind: "additional-service",
    status: "active",
    unit: "job",
    containerType: null,
    wasteFraction: "residual",
    serviceFrequency: null,
    invoiceName: "Extra bag tag",
    invoiceCode: "SRV-TAG",
    vatPercent: 25,
  },
  {
    key: "product-xmas",
    name: "Christmas tree collection",
    kind: "additional-service",
    status: "draft",
    unit: "job",
    containerType: null,
    wasteFraction: "organic",
    serviceFrequency: null,
    invoiceName: "Christmas tree collection",
    invoiceCode: "SRV-XMS",
    vatPercent: 25,
  },
]

/**
 * The product a container of a fraction is placed under. A fraction absent
 * here has no product, and its containers stand unplaced by design — the one
 * lookup in this file whose miss is a meaning and not a mistake.
 */
const PRODUCT_BY_FRACTION: Partial<Record<WasteFractionKey, string>> = {
  residual: "product-res-240",
  paper: "product-card-660",
  cardboard: "product-card-660",
  glass: "product-glass-igloo",
}

/* ----------------------------- who and where ------------------------------ */

// The web's FIXTURE_GAZETTEER (apps/web/lib/data/street-gazetteer.ts), copied:
// the anchor of each fixture street's low-number end and the bearing the
// numbers grow along. Keys are lower-cased NFC street names as
// knownAddressLocation parses them.
const GAZETTEER: Gazetteer = Object.fromEntries(
  Object.entries({
    ryesgade: { start: { lng: 12.5605, lat: 55.6905 }, bearing: 45 },
    blegdamsvej: { start: { lng: 12.5615, lat: 55.6935 }, bearing: 50 },
    jagtvej: { start: { lng: 12.5445, lat: 55.6935 }, bearing: 45 },
    amagerbrogade: { start: { lng: 12.5985, lat: 55.6685 }, bearing: 165 },
    istedgade: { start: { lng: 12.5615, lat: 55.6725 }, bearing: 250 },
    godthåbsvej: { start: { lng: 12.5405, lat: 55.6865 }, bearing: 260 },
    "falkoner allé": { start: { lng: 12.5335, lat: 55.6765 }, bearing: 10 },
    strandboulevarden: { start: { lng: 12.5865, lat: 55.7105 }, bearing: 200 },
    tagensvej: { start: { lng: 12.5575, lat: 55.6975 }, bearing: 320 },
    enghavevej: { start: { lng: 12.5475, lat: 55.6705 }, bearing: 180 },
    østerbrogade: { start: { lng: 12.5735, lat: 55.6975 }, bearing: 30 },
    "vigerslev allé": { start: { lng: 12.5195, lat: 55.6595 }, bearing: 265 },
    sandkaj: { start: { lng: 12.5965, lat: 55.7085 }, bearing: 60 },
    orientkaj: { start: { lng: 12.6025, lat: 55.7115 }, bearing: 70 },
    sundkrogsgade: { start: { lng: 12.5905, lat: 55.7065 }, bearing: 40 },
    trelleborggade: { start: { lng: 12.5985, lat: 55.7125 }, bearing: 90 },
    helsinkigade: { start: { lng: 12.6005, lat: 55.7095 }, bearing: 80 },
    parkvej: { start: { lng: 12.5745, lat: 55.7025 }, bearing: 60 },
    sundbyvej: { start: { lng: 12.6035, lat: 55.6575 }, bearing: 100 },
    nørrebrogade: { start: { lng: 12.5565, lat: 55.6865 }, bearing: 315 },
    vesterbrogade: { start: { lng: 12.5655, lat: 55.6745 }, bearing: 245 },
    "harbor offices": { start: { lng: 12.5975, lat: 55.7085 }, bearing: 60 },
  }).map(([street, anchor]) => [street.normalize("NFC"), anchor]),
)

const round6 = (value: number): number => Math.round(value * 1e6) / 1e6

/** Where the map places an address, as the point the column stores; null off the gazetteer. */
function placedAt(address: string, seed: string): Point | null {
  const at = knownAddressLocation(address, GAZETTEER, seed)
  return at ? { type: "Point", coordinates: [round6(at.lng), round6(at.lat)] } : null
}

// The explicit customers of `customers.contacts`. A CVR the fixture spells
// with its country ("DK-38112009") is stored as the number. The organisations
// the property fixtures name only as Owner or Payer follow, with nothing but
// a name; "Municipal payer" is Københavns Kommune.
type CustomerSpec = {
  key: string
  kind: CustomerKind
  name: string
  registrationNumber?: string
  email?: string
  phone?: string
  billingAddress?: string
}
const EXPLICIT_CUSTOMERS: readonly CustomerSpec[] = [
  { key: "contact-mikkel", kind: "person", name: "Mikkel Sørensen", email: "mikkel.sorensen@example.dk", phone: "+45 20 11 88 04" },
  { key: "company-osterbro-housing", kind: "organisation", name: "Østerbro Housing", registrationNumber: "38112009", email: "service@osterbro-housing.example" },
  { key: "company-harbor", kind: "organisation", name: "Harbor Offices ApS", registrationNumber: "43881209", billingAddress: "Dock 1, Nordhavn" },
  { key: "customer-kab-bolig", kind: "organisation", name: "KAB Bolig" },
  { key: "customer-jeudan", kind: "organisation", name: "Jeudan A/S" },
  { key: "customer-deas", kind: "organisation", name: "DEAS Ejendomme" },
  { key: "customer-by-og-havn", kind: "organisation", name: "By & Havn" },
  { key: "customer-harbor-properties", kind: "organisation", name: "Harbor Properties" },
  { key: "customer-amager-district", kind: "organisation", name: "Amager District" },
  { key: "customer-municipality", kind: "organisation", name: "Københavns Kommune" },
]

/** The Owner and Payer labels the property fixtures use, on the customers above. `Private` is resolved per property. */
const CUSTOMER_BY_LABEL: Readonly<Record<string, string>> = {
  "Østerbro Housing": "company-osterbro-housing",
  "Harbor Offices ApS": "company-harbor",
  "KAB Bolig": "customer-kab-bolig",
  "Jeudan A/S": "customer-jeudan",
  "DEAS Ejendomme": "customer-deas",
  "By & Havn": "customer-by-og-havn",
  "Harbor Properties": "customer-harbor-properties",
  "Amager District": "customer-amager-district",
  "Municipal payer": "customer-municipality",
}
const PRIVATE = "Private"

type PropertySpec = {
  key: string
  project: RegistryProject
  name: string
  address: string
  /** Where the map places it when that is not its own address: Dock 4 is placed as its container is. */
  placedAs?: { address: string; seed: string }
  registryId: string
  kind: PropertyKind
  status: PropertyStatus
  notes: string | null
  /** A fixture label: a customer's name, or `Private`. */
  owner: string
  /** A fixture label, or null when the payer is unconfirmed. */
  payer: string | null
  /** A customer key: who occupies it, where that is not the owner. */
  tenant?: string
}

const PARKVEJ_18: PropertySpec = {
  key: "property-parkvej-18",
  project: "copenhagen",
  name: "Parkvej 18",
  address: "Parkvej 18, 2100 København Ø",
  registryId: "CPH-001882",
  kind: "residential",
  status: "active",
  notes: "Multi-unit residential property with locked-yard access and organic, paper, and residual services.",
  owner: "Østerbro Housing",
  payer: "Østerbro Housing",
}

// A Prospect: not served yet, so `inactive`, its payer unconfirmed. Placed by
// BIN-77104's Address and Property facts, since "Dock 4, Nordhavn" is on no
// gazetteer street.
const DOCK_4: PropertySpec = {
  key: "property-dock-4",
  project: "harbor",
  name: "Dock 4 · Harbor Offices",
  address: "Dock 4, Nordhavn",
  placedAs: { address: "Harbor Offices, Dock 4", seed: "Harbor Offices" },
  registryId: "CPH-004201",
  kind: "commercial",
  status: "inactive",
  notes: "Commercial property awaiting payer confirmation and container capacity review.",
  owner: "Harbor Properties",
  payer: null,
  tenant: "company-harbor",
}

// A Data issue in the prototype: still served, so `active`. Its record names
// no type; its container BIN-44831 says "Property type: Commercial".
const SUNDBYVEJ_91: PropertySpec = {
  key: "property-sundbyvej-91",
  project: "copenhagen",
  name: "Sundbyvej 91",
  address: "Sundbyvej 91, 2300 København S",
  registryId: "CPH-009114",
  kind: "commercial",
  status: "active",
  notes: "Registry synchronization found a duplicate service address and conflicting building identifier.",
  owner: PRIVATE,
  payer: "Amager District",
}

const EXPLICIT_PROPERTIES: readonly PropertySpec[] = [PARKVEJ_18, DOCK_4, SUNDBYVEJ_91]

// The web's seeded-property generator (business-modules.ts,
// seededPropertyProfile and buildSeededPropertyRecords), index for index.
const SEEDED_COPENHAGEN_STREETS: ReadonlyArray<readonly [string, string]> = [
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
const SEEDED_HARBOR_STREETS: ReadonlyArray<readonly [string, string]> = [
  ["Sandkaj", "2150 Nordhavn"],
  ["Orientkaj", "2150 Nordhavn"],
  ["Sundkrogsgade", "2150 Nordhavn"],
  ["Trelleborggade", "2150 Nordhavn"],
  ["Helsinkigade", "2150 Nordhavn"],
]
const SEEDED_PROPERTY_OWNERS = ["Østerbro Housing", "KAB Bolig", "Jeudan A/S", "DEAS Ejendomme", PRIVATE, "By & Havn"] as const
const SEEDED_PROPERTY_KINDS: readonly PropertyKind[] = ["residential", "commercial", "mixed"] // Residential, Commercial, Mixed use
const SEEDED_PROPERTY_COUNT = 50
const SEEDED_PROPERTY_COPENHAGEN_COUNT = 35
const SEEDED_CONTAINER_COUNT = 100
const SEEDED_CONTAINER_COPENHAGEN_COUNT = 70

const seededPropertyKey = (index: number): string => `property-seed-${101 + index}`
const seededAgreementNumber = (index: number): string => `AGR-${2600 + index}`
const isProspect = (index: number): boolean => index % 12 === 7
const isOnHold = (index: number): boolean => index % 12 === 10

function seededProperty(index: number): PropertySpec {
  const inCopenhagen = index < SEEDED_PROPERTY_COPENHAGEN_COUNT
  const streets = inCopenhagen ? SEEDED_COPENHAGEN_STREETS : SEEDED_HARBOR_STREETS
  const [street, postal] = streets[index % streets.length]
  const name = `${street} ${3 + ((index * 7) % 120)}`
  const owner = SEEDED_PROPERTY_OWNERS[index % SEEDED_PROPERTY_OWNERS.length]
  return {
    key: seededPropertyKey(index),
    project: inCopenhagen ? "copenhagen" : "harbor",
    name,
    address: `${name}, ${postal}`,
    registryId: `CPH-9${1000 + index}`,
    kind: SEEDED_PROPERTY_KINDS[index % SEEDED_PROPERTY_KINDS.length],
    status: isProspect(index) || isOnHold(index) ? "inactive" : "active",
    notes: null,
    owner,
    payer: index % 4 === 3 ? "Municipal payer" : owner,
  }
}

/** The explicit properties, then the fifty seeded ones: `PROPERTIES[EXPLICIT_PROPERTIES.length + index]` is `seededProperty(index)`. */
const PROPERTIES: readonly PropertySpec[] = [...EXPLICIT_PROPERTIES, ...Array.from({ length: SEEDED_PROPERTY_COUNT }, (_, index) => seededProperty(index))]
const SEEDED_PROPERTIES: readonly PropertySpec[] = PROPERTIES.slice(EXPLICIT_PROPERTIES.length)

/** The person a `Private` owner is: one Customer per privately owned property. */
const privateOwnerKey = (propertySpec: PropertySpec): string => `owner-${propertySpec.key}`

/** The customer key a property's Owner or Payer label resolves to. */
function customerKeyOf(label: string, of: PropertySpec): string {
  if (label === PRIVATE) return privateOwnerKey(of)
  const key = CUSTOMER_BY_LABEL[label]
  if (!key) throw new Error(`registry seed: no customer is named ${label} (on ${of.key})`)
  return key
}

const CUSTOMERS: readonly CustomerSpec[] = [
  ...EXPLICIT_CUSTOMERS,
  ...PROPERTIES.filter((spec) => spec.owner === PRIVATE).map(
    (spec): CustomerSpec => ({ key: privateOwnerKey(spec), kind: "person", name: `Private owner · ${spec.name}` }),
  ),
]

/* ------------------------ groups and shared points ------------------------ */

/** A group or point: its rule for the properties of its own project. */
type Gathering = { project: RegistryProject; members: (spec: PropertySpec) => boolean }

/** Whether a property is a member: in the gathering's project and named by its rule. */
const memberOf = (gathering: Gathering, spec: PropertySpec): boolean => spec.project === gathering.project && gathering.members(spec)

type GroupSpec = Gathering & {
  key: string
  name: string
  purpose: (typeof propertyGroup.$inferInsert)["purpose"]
  responsibleCustomer: string | null
  status: (typeof propertyGroup.$inferInsert)["status"]
}
const OSTERBRO_EAST: GroupSpec = {
  key: "group-osterbro-east",
  project: "copenhagen",
  name: "Østerbro East Portfolio",
  purpose: "administration",
  responsibleCustomer: "company-osterbro-housing",
  status: "active",
  members: (spec) => spec.owner === "Østerbro Housing",
}
const VALBY_ORGANIC: GroupSpec = {
  key: "group-valby-organic",
  project: "copenhagen",
  name: "Valby Organic Service Group",
  purpose: "service",
  responsibleCustomer: null,
  status: "active",
  members: (spec) => spec.address.endsWith("2500 Valby"),
}
const GROUPS: readonly GroupSpec[] = [OSTERBRO_EAST, VALBY_ORGANIC]

type PointSpec = Gathering & {
  key: string
  name: string
  kind: (typeof sharedCollectionPoint.$inferInsert)["kind"]
  address: string
  location: Point
  eligibilityDistanceM: number | null
  operatingModel: (typeof sharedCollectionPoint.$inferInsert)["operatingModel"]
  accessMode: (typeof sharedCollectionPoint.$inferInsert)["accessMode"]
  accessConditions: string | null
  availability: string | null
  billingMode: (typeof sharedCollectionPoint.$inferInsert)["billingMode"]
  status: (typeof sharedCollectionPoint.$inferInsert)["status"]
}
const POINTS: readonly PointSpec[] = [
  {
    // "Municipal · Open access", Type Underground, Access 24/7, Eligibility
    // within 350 m; no fixture property is that close to the square.
    key: "shared-point-17",
    project: "copenhagen",
    name: "Kongens Nytorv Shared Point",
    kind: "underground",
    address: "Kongens Nytorv, 1050 København K",
    location: { type: "Point", coordinates: [12.5855, 55.6805] },
    eligibilityDistanceM: 350,
    operatingModel: "municipal",
    accessMode: "open",
    accessConditions: null,
    availability: "24/7",
    billingMode: "municipal",
    status: "open",
    members: () => false,
  },
  {
    // "Commercial · Member access", Type Surface containers, Access Business
    // hours, Billing Member share, Eligibility Invited members; the fixture's
    // "Billing issue" is Finance's flag, the point is open.
    key: "shared-point-23",
    project: "harbor",
    name: "Nordhavn Dock Shared Cardboard",
    kind: "surface",
    address: "Sandkaj, 2150 Nordhavn",
    location: { type: "Point", coordinates: [12.5965, 55.7085] },
    eligibilityDistanceM: null,
    operatingModel: "member-funded",
    accessMode: "member",
    accessConditions: "Invited members",
    availability: "Business hours",
    billingMode: "member-share",
    status: "open",
    members: (spec) => spec.kind === "commercial",
  },
]

/* ------------------------------ agreements -------------------------------- */

type AgreementSpec = {
  number: string
  project: RegistryProject
  customer: string
  payer: string
  status: AgreementStatus
  validFrom: string
  validTo: string | null
}
const AGREEMENTS: readonly AgreementSpec[] = [
  // "1 Jan–31 Dec 2026": the end is the first day out of force.
  { number: "AGR-2408", project: "copenhagen", customer: "company-osterbro-housing", payer: "company-osterbro-housing", status: "active", validFrom: "2026-01-01", validTo: "2027-01-01" },
  // "Payer unconfirmed" in the fixture: `payer_customer_id` is NOT NULL, so
  // the payer is the customer until one is confirmed.
  { number: "AGR-2512", project: "harbor", customer: "company-harbor", payer: "company-harbor", status: "draft", validFrom: "2026-09-01", validTo: null },
  { number: "AGR-2188", project: "copenhagen", customer: privateOwnerKey(SUNDBYVEJ_91), payer: "customer-amager-district", status: "active", validFrom: "2026-01-01", validTo: null },
  // One per seeded property, from its "Agreement AGR-n" fact; the property's
  // owner is the customer and its payer the payer.
  ...SEEDED_PROPERTIES.map(
    (spec, index): AgreementSpec => ({
      number: seededAgreementNumber(index),
      project: spec.project,
      customer: customerKeyOf(spec.owner, spec),
      payer: customerKeyOf(spec.payer ?? spec.owner, spec),
      status: isProspect(index) ? "draft" : "active",
      validFrom: isProspect(index) ? "2026-10-01" : "2026-01-01",
      validTo: null,
    }),
  ),
]

/** The subscriptions a fixture agreement names without a container under them. */
const EXPLICIT_SUBSCRIPTIONS: readonly { agreement: string; product: string; property: string }[] = [
  { agreement: "AGR-2408", product: "product-res-240", property: PARKVEJ_18.key },
  { agreement: "AGR-2408", product: "product-card-660", property: PARKVEJ_18.key },
]

/* ------------------------------- containers ------------------------------- */

type StandsSpec = {
  property: string
  agreement: string
  fraction: WasteFractionKey
  frequency: ServiceFrequencyKey | null
  /** The prototype's Future: installed for a placement that starts later. */
  future?: boolean
}
/**
 * Where the prototype's map places a container, and the planning area its
 * record files it under: its Address fact, placed with its Property fact as
 * the seed, and its planning-area link — the typed `planningAreaId` the
 * stop-match resolver read, a prototype record id. Nothing of it is a
 * Registry column (a container carries no location and no area); Planning's
 * seed draws each area's boundary around these (planning.ts).
 */
type MappedSpec = { area: string; address: string; seed: string }
type ContainerSpec = {
  key: string
  project: RegistryProject
  label: string
  containerType: ContainerTypeKey
  barcode: string
  rfid: string | null
  serialNumber: string
  ownership: ContainerOwnership
  /** Where the prototype says it stands, or null for one in storage, in transit or ended. */
  stands: StandsSpec | null
  /** Where its map places it, or null for one the map does not place: in storage, in transit or ended. */
  mapped: MappedSpec | null
}
const SEEDED_WASTE_FRACTIONS: readonly WasteFractionKey[] = ["residual", "organic", "paper", "cardboard", "glass", "plastic", "metal"]
const SEEDED_CONTAINER_TYPES: readonly ContainerTypeKey[] = ["two-wheel-140", "two-wheel-240", "four-wheel-660", "four-wheel-1100", "igloo-2500", "underground-5000"]

const EXPLICIT_CONTAINERS: readonly ContainerSpec[] = [
  {
    key: "asset-82014",
    project: "copenhagen",
    label: "BIN-82014",
    containerType: "two-wheel-240",
    barcode: "WH82014",
    rfid: "E2003412",
    serialNumber: "OTTO-24-82014",
    ownership: "company",
    stands: { property: PARKVEJ_18.key, agreement: "AGR-2408", fraction: "organic", frequency: "freq-every-2-weeks" },
    mapped: { area: "area-osterbro-contract", address: "Parkvej 18, 2100 Copenhagen Ø", seed: "Parkvej 18" },
  },
  {
    key: "asset-44831",
    project: "copenhagen",
    label: "BIN-44831",
    containerType: "four-wheel-1100",
    barcode: "WH44831",
    rfid: null,
    serialNumber: "SULO-22-44831",
    ownership: "customer",
    stands: { property: SUNDBYVEJ_91.key, agreement: "AGR-2188", fraction: "glass", frequency: "freq-monthly" },
    mapped: { area: "area-amager-1", address: "Sundbyvej 91, 2300 Copenhagen S", seed: "Sundbyvej 91" },
  },
  {
    key: "asset-99017",
    project: "copenhagen",
    label: "BIN-99017",
    containerType: "four-wheel-660",
    barcode: "WH99017",
    rfid: "E2008890",
    serialNumber: "SSI-26-99017",
    ownership: "company",
    stands: null,
    mapped: null,
  },
  {
    key: "asset-77104",
    project: "harbor",
    label: "BIN-77104",
    containerType: "four-wheel-1100",
    barcode: "WH77104",
    rfid: "E20077104",
    serialNumber: "SULO-26-77104",
    ownership: "company",
    stands: { property: DOCK_4.key, agreement: "AGR-2512", fraction: "cardboard", frequency: "freq-weekly" },
    mapped: { area: "area-harbor-1", address: "Harbor Offices, Dock 4", seed: "Harbor Offices" },
  },
  {
    // Nørrebrogade 144 is not a fixture property, so the container stands
    // unplaced; the map still places it, on a street it knows.
    key: "asset-66420",
    project: "copenhagen",
    label: "BIN-66420",
    containerType: "four-wheel-660",
    barcode: "WH66420",
    rfid: null,
    serialNumber: "SSI-23-66420",
    ownership: "unrecorded",
    stands: null,
    mapped: { area: "area-indreby", address: "Nørrebrogade 144, 2200 Copenhagen N", seed: "Nørrebrogade 144" },
  },
  {
    key: "asset-50318",
    project: "copenhagen",
    label: "BIN-50318",
    containerType: "two-wheel-240",
    barcode: "WH50318",
    rfid: "E20050318",
    serialNumber: "OTTO-18-50318",
    ownership: "customer",
    stands: null,
    mapped: null,
  },
  {
    key: "asset-11862",
    project: "copenhagen",
    label: "BIN-11862",
    containerType: "wastewater-3000",
    barcode: "WH11862",
    rfid: "E20011862",
    serialNumber: "WTT-25-11862",
    ownership: "company",
    stands: null,
    mapped: null,
  },
]

/** The planning areas the web's generator rotates a Copenhagen container through, by index; a Harbor one is always in the harbor's. */
const SEEDED_COPENHAGEN_AREAS = ["area-indreby", "area-osterbro-contract", "area-amager-1"] as const
const SEEDED_HARBOR_AREA = "area-harbor-1"

// The web's buildSeededContainerRecords, index for index: the property it
// stands at, its fraction and type, its frequency promise, whether the
// prototype's status cycle puts it in storage (unplaced) or in the future,
// and, in service, the planning area it rotates into and the address the map
// places it at, its property's.
function seededContainer(index: number): ContainerSpec {
  const inCopenhagen = index < SEEDED_CONTAINER_COPENHAGEN_COUNT
  const propertyIndex = inCopenhagen
    ? index % SEEDED_PROPERTY_COPENHAGEN_COUNT
    : SEEDED_PROPERTY_COPENHAGEN_COUNT + ((index - SEEDED_CONTAINER_COPENHAGEN_COUNT) % (SEEDED_PROPERTY_COUNT - SEEDED_PROPERTY_COPENHAGEN_COUNT))
  const binNumber = 91001 + index
  const cycle = index % 20
  const inStorage = cycle === 17
  const standsAt = seededProperty(propertyIndex)
  return {
    key: `asset-seed-${binNumber}`,
    project: inCopenhagen ? "copenhagen" : "harbor",
    label: `BIN-${binNumber}`,
    containerType: SEEDED_CONTAINER_TYPES[index % SEEDED_CONTAINER_TYPES.length],
    barcode: `WH${binNumber}`,
    rfid: index % 4 === 3 ? null : `E200${binNumber}`,
    serialNumber: `SEED-26-${binNumber}`,
    ownership: index % 5 === 4 ? "customer" : "company",
    stands: inStorage
      ? null
      : {
          property: seededPropertyKey(propertyIndex),
          agreement: seededAgreementNumber(propertyIndex),
          fraction: SEEDED_WASTE_FRACTIONS[index % SEEDED_WASTE_FRACTIONS.length],
          frequency: index % 2 === 0 ? "freq-every-2-weeks" : "freq-weekly",
          future: cycle === 8,
        },
    mapped: inStorage
      ? null
      : {
          area: inCopenhagen ? SEEDED_COPENHAGEN_AREAS[index % SEEDED_COPENHAGEN_AREAS.length] : SEEDED_HARBOR_AREA,
          address: standsAt.address,
          seed: standsAt.name,
        },
  }
}

const CONTAINERS: readonly ContainerSpec[] = [...EXPLICIT_CONTAINERS, ...Array.from({ length: SEEDED_CONTAINER_COUNT }, (_, index) => seededContainer(index))]

/** The day a placement the prototype marks Future starts. */
const FUTURE_PLACEMENT_FROM = "2026-10-01"

/* --------------------------------- rows ----------------------------------- */

/** The spec keyed `key`, or this file's own sentence: never a TypeError from a Map. */
function requiredSpec<T>(specs: ReadonlyMap<string, T>, key: string, what: string): T {
  const spec = specs.get(key)
  if (spec === undefined) throw new Error(`registry seed: no ${what} is keyed ${key}`)
  return spec
}

/** Every Registry id, keyed by the prototype's record id (or the number, name or membership it goes by). */
export type RegistryIds = {
  wasteFractions: Readonly<Record<string, string>>
  containerTypes: Readonly<Record<string, string>>
  serviceFrequencies: Readonly<Record<RegistryProject, Readonly<Record<string, string>>>>
  products: Readonly<Record<RegistryProject, Readonly<Record<string, string>>>>
  customers: Readonly<Record<string, string>>
  properties: Readonly<Record<string, string>>
  /** `<property>:<customer>:<role>` */
  propertyParties: Readonly<Record<string, string>>
  propertyGroups: Readonly<Record<string, string>>
  /** `<group>:<property>` */
  propertyGroupMembers: Readonly<Record<string, string>>
  sharedCollectionPoints: Readonly<Record<string, string>>
  /** `<point>:<property>` */
  sharedCollectionPointMembers: Readonly<Record<string, string>>
  /** By agreement number: `AGR-2408`. */
  agreements: Readonly<Record<string, string>>
  /** `<agreement number>:<product>:<property>` */
  subscriptions: Readonly<Record<string, string>>
  containers: Readonly<Record<string, string>>
  /** By the container placed. */
  containerServicePlacements: Readonly<Record<string, string>>
}

type RegistryRows = {
  wasteFractions: (typeof wasteFraction.$inferInsert)[]
  containerTypes: (typeof containerType.$inferInsert)[]
  serviceFrequencies: (typeof serviceFrequency.$inferInsert)[]
  products: (typeof product.$inferInsert)[]
  customers: (typeof customer.$inferInsert)[]
  properties: (typeof property.$inferInsert)[]
  propertyParties: (typeof propertyParty.$inferInsert)[]
  propertyGroups: (typeof propertyGroup.$inferInsert)[]
  propertyGroupMembers: (typeof propertyGroupMember.$inferInsert)[]
  sharedCollectionPoints: (typeof sharedCollectionPoint.$inferInsert)[]
  sharedCollectionPointMembers: (typeof sharedCollectionPointMember.$inferInsert)[]
  agreements: (typeof agreement.$inferInsert)[]
  subscriptions: (typeof subscription.$inferInsert)[]
  containers: (typeof container.$inferInsert)[]
  containerServicePlacements: (typeof containerServicePlacement.$inferInsert)[]
}

/** How many rows the Registry seed holds per table. */
export type RegistryCounts = { [K in keyof RegistryRows]: number }

function build(): { ids: RegistryIds; rows: RegistryRows } {
  const wasteFractionIds = keyed(WASTE_FRACTIONS, ([key]) => key, "wasteFraction")
  const containerTypeIds = keyed(CONTAINER_TYPES, ([key]) => key, "containerType")
  const perProject = (kind: DemoKind, keys: readonly string[]): Record<RegistryProject, Record<string, string>> => {
    const next = counted(kind)
    return Object.fromEntries(REGISTRY_PROJECTS.map((project) => [project, Object.fromEntries(keys.map((key) => [key, next()]))])) as Record<
      RegistryProject,
      Record<string, string>
    >
  }
  const serviceFrequencyIds = perProject(
    "serviceFrequency",
    SERVICE_FREQUENCIES.map(([key]) => key),
  )
  const productIds = perProject(
    "product",
    PRODUCTS.map((spec) => spec.key),
  )
  const customerIds = keyed(CUSTOMERS, (spec) => spec.key, "customer")
  const propertyIds = keyed(PROPERTIES, (spec) => spec.key, "property")
  const propertyByKey = new Map(PROPERTIES.map((spec) => [spec.key, spec]))
  const groupIds = keyed(GROUPS, (spec) => spec.key, "propertyGroup")
  const pointIds = keyed(POINTS, (spec) => spec.key, "sharedCollectionPoint")
  const agreementIds = keyed(AGREEMENTS, (spec) => spec.number, "agreement")
  const agreementByNumber = new Map(AGREEMENTS.map((spec) => [spec.number, spec]))
  const containerIds = keyed(CONTAINERS, (spec) => spec.key, "container")
  const productByKey = new Map(PRODUCTS.map((spec) => [spec.key, spec]))

  const wasteFractionId = (key: string) => required(wasteFractionIds, key, "waste fraction")
  const containerTypeId = (key: string) => required(containerTypeIds, key, "container type")
  const serviceFrequencyId = (project: RegistryProject, key: string) => required(serviceFrequencyIds[project], key, `${project} service frequency`)
  const productId = (project: RegistryProject, key: string) => required(productIds[project], key, `${project} product`)
  const customerId = (key: string) => required(customerIds, key, "customer")
  const propertyId = (key: string) => required(propertyIds, key, "property")
  const propertyOf = (key: string) => requiredSpec(propertyByKey, key, "property")
  const agreementOf = (number: string) => requiredSpec(agreementByNumber, number, "agreement")
  const productOf = (key: string) => requiredSpec(productByKey, key, "product")

  const rows: RegistryRows = {
    wasteFractions: WASTE_FRACTIONS.map(([key, name]) => ({ id: wasteFractionId(key), companyId: COMPANY_ID, key, name })),
    containerTypes: CONTAINER_TYPES.map(([key, name, volumeLitres]) => ({ id: containerTypeId(key), companyId: COMPANY_ID, name, volumeLitres })),
    serviceFrequencies: REGISTRY_PROJECTS.flatMap((project) =>
      SERVICE_FREQUENCIES.map(([key, name, description, collectionsPerWeek, weeksBetween, daysBetween]) => ({
        id: serviceFrequencyId(project, key),
        companyId: COMPANY_ID,
        projectId: projectIdOf(project),
        name,
        description,
        collectionsPerWeek,
        weeksBetween,
        daysBetween,
      })),
    ),
    products: REGISTRY_PROJECTS.flatMap((project) =>
      PRODUCTS.map((spec) => ({
        id: productId(project, spec.key),
        companyId: COMPANY_ID,
        projectId: projectIdOf(project),
        name: spec.name,
        kind: spec.kind,
        status: spec.status,
        unit: spec.unit,
        containerTypeId: spec.containerType ? containerTypeId(spec.containerType) : null,
        wasteFractionId: spec.wasteFraction ? wasteFractionId(spec.wasteFraction) : null,
        serviceFrequencyId: spec.serviceFrequency ? serviceFrequencyId(project, spec.serviceFrequency) : null,
        invoiceName: spec.invoiceName,
        invoiceCode: spec.invoiceCode,
        vatPercent: spec.vatPercent,
      })),
    ),
    customers: CUSTOMERS.map((spec) => ({
      id: customerId(spec.key),
      companyId: COMPANY_ID,
      kind: spec.kind,
      name: spec.name,
      registrationNumber: spec.registrationNumber ?? null,
      email: spec.email ?? null,
      phone: spec.phone ?? null,
      billingAddress: spec.billingAddress ?? null,
      serviceMessagesAllowed: true,
      status: "active",
    })),
    properties: PROPERTIES.map((spec) => ({
      id: propertyId(spec.key),
      companyId: COMPANY_ID,
      projectId: projectIdOf(spec.project),
      name: spec.name,
      address: spec.address,
      registryId: spec.registryId,
      kind: spec.kind,
      location: spec.placedAs ? placedAt(spec.placedAs.address, spec.placedAs.seed) : placedAt(spec.address, spec.name),
      notes: spec.notes,
      status: spec.status,
    })),
    propertyParties: [],
    propertyGroups: GROUPS.map((spec) => ({
      id: required(groupIds, spec.key, "property group"),
      companyId: COMPANY_ID,
      projectId: projectIdOf(spec.project),
      name: spec.name,
      purpose: spec.purpose,
      responsibleCustomerId: spec.responsibleCustomer ? customerId(spec.responsibleCustomer) : null,
      status: spec.status,
    })),
    propertyGroupMembers: [],
    sharedCollectionPoints: POINTS.map((spec) => ({
      id: required(pointIds, spec.key, "shared collection point"),
      companyId: COMPANY_ID,
      projectId: projectIdOf(spec.project),
      name: spec.name,
      kind: spec.kind,
      address: spec.address,
      location: spec.location,
      eligibilityDistanceM: spec.eligibilityDistanceM,
      operatingModel: spec.operatingModel,
      accessMode: spec.accessMode,
      accessConditions: spec.accessConditions,
      availability: spec.availability,
      billingMode: spec.billingMode,
      responsibleCustomerId: null,
      status: spec.status,
    })),
    sharedCollectionPointMembers: [],
    agreements: AGREEMENTS.map((spec) => ({
      id: required(agreementIds, spec.number, "agreement"),
      companyId: COMPANY_ID,
      projectId: projectIdOf(spec.project),
      validFrom: spec.validFrom,
      validTo: spec.validTo,
      number: spec.number,
      customerId: customerId(spec.customer),
      payerCustomerId: customerId(spec.payer),
      status: spec.status,
      billingCadence: "monthly",
      currency: "DKK",
      notes: null,
    })),
    subscriptions: [],
    containers: CONTAINERS.map((spec) => ({
      id: required(containerIds, spec.key, "container"),
      companyId: COMPANY_ID,
      projectId: projectIdOf(spec.project),
      label: spec.label,
      containerTypeId: containerTypeId(spec.containerType),
      barcode: spec.barcode,
      rfid: spec.rfid,
      serialNumber: spec.serialNumber,
      ownership: spec.ownership,
      notes: null,
    })),
    containerServicePlacements: [],
  }

  // Parties: the owner, the payer where there is one, the tenant where there
  // is one, and the service contact of the Østerbro East portfolio.
  type Party = { property: string; customer: string; role: PropertyPartyRole }
  const parties: Party[] = []
  for (const spec of PROPERTIES) {
    parties.push({ property: spec.key, customer: customerKeyOf(spec.owner, spec), role: "owner" })
    if (spec.payer) parties.push({ property: spec.key, customer: customerKeyOf(spec.payer, spec), role: "payer" })
    if (spec.tenant) parties.push({ property: spec.key, customer: spec.tenant, role: "tenant" })
    if (memberOf(OSTERBRO_EAST, spec)) parties.push({ property: spec.key, customer: "contact-mikkel", role: "service-contact" })
  }
  const partyKey = (party: Party): string => `${party.property}:${party.customer}:${party.role}`
  const partyIds = keyed(parties, partyKey, "propertyParty")
  rows.propertyParties = parties.map((party) => ({
    id: required(partyIds, partyKey(party), "party"),
    companyId: COMPANY_ID,
    projectId: projectIdOf(propertyOf(party.property).project),
    propertyId: propertyId(party.property),
    customerId: customerId(party.customer),
    role: party.role,
  }))

  // Members, by each group's and point's rule over the properties of its project.
  type Membership = { of: string; property: string }
  const memberKey = (membership: Membership): string => `${membership.of}:${membership.property}`
  const gathered = (gatherings: readonly (Gathering & { key: string })[]): Membership[] =>
    gatherings.flatMap((gathering) => PROPERTIES.filter((spec) => memberOf(gathering, spec)).map((spec) => ({ of: gathering.key, property: spec.key })))
  const groupMembers = gathered(GROUPS)
  const groupMemberIds = keyed(groupMembers, memberKey, "propertyGroupMember")
  rows.propertyGroupMembers = groupMembers.map((membership) => ({
    id: required(groupMemberIds, memberKey(membership), "group membership"),
    companyId: COMPANY_ID,
    projectId: projectIdOf(propertyOf(membership.property).project),
    propertyGroupId: required(groupIds, membership.of, "property group"),
    propertyId: propertyId(membership.property),
    role: "member",
  }))
  const pointMembers = gathered(POINTS)
  const pointMemberIds = keyed(pointMembers, memberKey, "sharedCollectionPointMember")
  rows.sharedCollectionPointMembers = pointMembers.map((membership) => ({
    id: required(pointMemberIds, memberKey(membership), "point membership"),
    companyId: COMPANY_ID,
    projectId: projectIdOf(propertyOf(membership.property).project),
    sharedCollectionPointId: required(pointIds, membership.of, "shared collection point"),
    propertyId: propertyId(membership.property),
    role: "service-member",
  }))

  // Subscriptions and placements. A subscription is one product at one
  // property under one agreement, for the agreement's period; a container in
  // service whose fraction a product collects is placed under it, inside that
  // period, and the subscription's quantity counts the containers so placed,
  // at least one.
  type SubscriptionKey = { agreement: string; product: string; property: string }
  type Subscribed = { key: SubscriptionKey; placed: number }
  const subscriptionKey = (key: SubscriptionKey): string => `${key.agreement}:${key.product}:${key.property}`
  const subscribed = new Map<string, Subscribed>()
  const subscribe = (key: SubscriptionKey): { spelled: string; entry: Subscribed } => {
    const spelled = subscriptionKey(key)
    let entry = subscribed.get(spelled)
    if (!entry) {
      entry = { key, placed: 0 }
      subscribed.set(spelled, entry)
    }
    return { spelled, entry }
  }
  for (const explicit of EXPLICIT_SUBSCRIPTIONS) subscribe(explicit)

  type Placement = { container: ContainerSpec; stands: StandsSpec; subscription: string; product: ProductSpec }
  const placements: Placement[] = []
  for (const spec of CONTAINERS) {
    if (!spec.stands) continue
    const productKey = PRODUCT_BY_FRACTION[spec.stands.fraction]
    if (!productKey) continue // no fixture product collects this fraction: unplaced by design
    agreementOf(spec.stands.agreement)
    propertyOf(spec.stands.property)
    const { spelled, entry } = subscribe({ agreement: spec.stands.agreement, product: productKey, property: spec.stands.property })
    entry.placed += 1
    placements.push({ container: spec, stands: spec.stands, subscription: spelled, product: productOf(productKey) })
  }

  type Period = { validFrom: string; validTo: string | null }
  const subscriptions = [...subscribed.values()]
  const subscriptionIds = keyed(subscriptions, ({ key }) => subscriptionKey(key), "subscription")
  const subscriptionPeriods = new Map<string, Period>()
  rows.subscriptions = subscriptions.map(({ key, placed }) => {
    const under = agreementOf(key.agreement)
    const at = propertyOf(key.property)
    if (at.project !== under.project) throw new Error(`registry seed: ${key.property} is not in ${key.agreement}'s project`)
    const spelled = subscriptionKey(key)
    subscriptionPeriods.set(spelled, { validFrom: under.validFrom, validTo: under.validTo })
    return {
      id: required(subscriptionIds, spelled, "subscription"),
      companyId: COMPANY_ID,
      projectId: projectIdOf(under.project),
      validFrom: under.validFrom,
      validTo: under.validTo,
      agreementId: required(agreementIds, key.agreement, "agreement"),
      productId: productId(under.project, key.product),
      propertyId: propertyId(key.property),
      sharedCollectionPointId: null,
      quantity: Math.max(1, placed),
    }
  })

  const placementIds = keyed(placements, ({ container: spec }) => spec.key, "containerServicePlacement")
  rows.containerServicePlacements = placements.map(({ container: spec, stands, subscription: spelled, product: under }) => {
    // Inside its subscription's period: the same start, or the Future start,
    // and the same end. Two `YYYY-MM-DD` strings compare as days.
    const period = requiredSpec(subscriptionPeriods, spelled, "subscription")
    const validFrom = stands.future ? FUTURE_PLACEMENT_FROM : period.validFrom
    if (validFrom < period.validFrom || (period.validTo !== null && validFrom >= period.validTo)) {
      throw new Error(`registry seed: ${spec.key} would be placed from ${validFrom}, outside its subscription ${spelled} (${period.validFrom} to ${period.validTo})`)
    }
    const overrides = stands.frequency !== null && stands.frequency !== under.serviceFrequency ? stands.frequency : null
    return {
      id: required(placementIds, spec.key, "placement"),
      companyId: COMPANY_ID,
      projectId: projectIdOf(spec.project),
      validFrom,
      validTo: period.validTo,
      containerId: required(containerIds, spec.key, "container"),
      subscriptionId: required(subscriptionIds, spelled, "subscription"),
      wasteFractionId: wasteFractionId(stands.fraction),
      serviceFrequencyId: overrides ? serviceFrequencyId(spec.project, overrides) : null,
    }
  })

  return {
    ids: {
      wasteFractions: wasteFractionIds,
      containerTypes: containerTypeIds,
      serviceFrequencies: serviceFrequencyIds,
      products: productIds,
      customers: customerIds,
      properties: propertyIds,
      propertyParties: partyIds,
      propertyGroups: groupIds,
      propertyGroupMembers: groupMemberIds,
      sharedCollectionPoints: pointIds,
      sharedCollectionPointMembers: pointMemberIds,
      agreements: agreementIds,
      subscriptions: subscriptionIds,
      containers: containerIds,
      containerServicePlacements: placementIds,
    },
    rows,
  }
}

const built = build()

/** Every Registry id the seed writes, keyed by the prototype's record id. */
export const REGISTRY_IDS: RegistryIds = built.ids

/** The rows themselves, for a test that wants to read what the seed proposes. */
export const REGISTRY_ROWS: Readonly<RegistryRows> = built.rows

/** A container the prototype's map places: which, where — the point a property here is stored at — and under which planning area its record files it. */
export type MapPlaced = { container: string; area: string; spot: Point }

/** Every container the map places, in the Registry's order; what Planning's seed draws the boundaries around. */
export const REGISTRY_MAP_PLACES: readonly MapPlaced[] = CONTAINERS.flatMap((spec) => {
  if (!spec.mapped) return []
  const spot = placedAt(spec.mapped.address, spec.mapped.seed)
  if (!spot) throw new Error(`registry seed: the map places ${spec.key} at ${spec.mapped.address}, which is on no gazetteer street`)
  return [{ container: spec.key, area: spec.mapped.area, spot }]
})

export const REGISTRY_COUNTS: RegistryCounts = Object.fromEntries(Object.entries(built.rows).map(([table, rows]) => [table, rows.length])) as RegistryCounts

/**
 * Writes the Registry into an open transaction, table by table in the order
 * the keys demand, and answers how many rows it changed. Upserts only: a row
 * the fixtures no longer name is left as it is, since nothing here is deleted
 * (an agreement ends, a container's placement ends).
 */
export async function applyRegistry(tx: Tx): Promise<number> {
  const rows = REGISTRY_ROWS
  let changed = 0
  // `key` is set once (catalogue.ts): the seed spells it on insert and never rewrites it.
  changed += await upsertOwned(tx, wasteFraction, rows.wasteFractions, [wasteFraction.name])
  changed += await upsertOwned(tx, containerType, rows.containerTypes, [containerType.name, containerType.volumeLitres])
  changed += await upsertOwned(tx, serviceFrequency, rows.serviceFrequencies, [
    serviceFrequency.name,
    serviceFrequency.description,
    serviceFrequency.collectionsPerWeek,
    serviceFrequency.weeksBetween,
    serviceFrequency.daysBetween,
  ])
  changed += await upsertOwned(tx, product, rows.products, [
    product.name,
    product.kind,
    product.status,
    product.unit,
    product.containerTypeId,
    product.wasteFractionId,
    product.serviceFrequencyId,
    product.invoiceName,
    product.invoiceCode,
    product.vatPercent,
  ])
  changed += await upsertOwned(tx, customer, rows.customers, [
    customer.kind,
    customer.name,
    customer.registrationNumber,
    customer.email,
    customer.phone,
    customer.billingAddress,
    customer.serviceMessagesAllowed,
    customer.status,
  ])
  changed += await upsertOwned(tx, property, rows.properties, [
    property.name,
    property.address,
    property.registryId,
    property.kind,
    property.location,
    property.notes,
    property.status,
  ])
  changed += await upsertOwned(tx, propertyParty, rows.propertyParties, [propertyParty.propertyId, propertyParty.customerId, propertyParty.role])
  changed += await upsertOwned(tx, propertyGroup, rows.propertyGroups, [propertyGroup.name, propertyGroup.purpose, propertyGroup.responsibleCustomerId, propertyGroup.status])
  changed += await upsertOwned(tx, propertyGroupMember, rows.propertyGroupMembers, [
    propertyGroupMember.propertyGroupId,
    propertyGroupMember.propertyId,
    propertyGroupMember.role,
  ])
  changed += await upsertOwned(tx, sharedCollectionPoint, rows.sharedCollectionPoints, [
    sharedCollectionPoint.name,
    sharedCollectionPoint.kind,
    sharedCollectionPoint.address,
    sharedCollectionPoint.location,
    sharedCollectionPoint.eligibilityDistanceM,
    sharedCollectionPoint.operatingModel,
    sharedCollectionPoint.accessMode,
    sharedCollectionPoint.accessConditions,
    sharedCollectionPoint.availability,
    sharedCollectionPoint.billingMode,
    sharedCollectionPoint.responsibleCustomerId,
    sharedCollectionPoint.status,
  ])
  changed += await upsertOwned(tx, sharedCollectionPointMember, rows.sharedCollectionPointMembers, [
    sharedCollectionPointMember.sharedCollectionPointId,
    sharedCollectionPointMember.propertyId,
    sharedCollectionPointMember.role,
  ])
  changed += await upsertOwned(tx, agreement, rows.agreements, [
    agreement.validFrom,
    agreement.validTo,
    agreement.number,
    agreement.customerId,
    agreement.payerCustomerId,
    agreement.status,
    agreement.billingCadence,
    agreement.currency,
    agreement.notes,
  ])
  changed += await upsertOwned(tx, subscription, rows.subscriptions, [
    subscription.validFrom,
    subscription.validTo,
    subscription.agreementId,
    subscription.productId,
    subscription.propertyId,
    subscription.sharedCollectionPointId,
    subscription.quantity,
  ])
  changed += await upsertOwned(tx, container, rows.containers, [
    container.label,
    container.containerTypeId,
    container.barcode,
    container.rfid,
    container.serialNumber,
    container.ownership,
    container.notes,
  ])
  changed += await upsertOwned(tx, containerServicePlacement, rows.containerServicePlacements, [
    containerServicePlacement.validFrom,
    containerServicePlacement.validTo,
    containerServicePlacement.containerId,
    containerServicePlacement.subscriptionId,
    containerServicePlacement.wasteFractionId,
    containerServicePlacement.serviceFrequencyId,
  ])
  return changed
}
