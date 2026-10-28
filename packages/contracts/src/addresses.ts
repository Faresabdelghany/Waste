// The address lookup on the wire (#291 C13, #290 O29): the office's search of
// the national address register, DAR, which the API asks on its own key
// (#77) — Dataforsyningen's service where the Pilot names it, the fake
// register in CI, the tests and e2e, as the routing provider's fake stands in
// for the provider (#131). `GET /addresses?q=` answers the addresses whose
// designation the text begins, `GET /addresses/:id` one address whole: its
// parts, the property it lies on (a BFE number) and its point, which a
// Property created or changed with its `addressId` stores (customers.ts).
//
// An address id is the register's, a UUID of any version, never a record of
// this system's. A register that does not answer is a 503 the office is told
// to try again, or to type the address and place the point by hand: the typed
// address and point stay a Property's whole without the register.
// `attribution` is what a surface that shows the register's data owes it
// (CC BY 4.0, Klimadatastyrelsen named).
import { FOUR_DIGITS_PATTERN } from "@waste/domain/registry/address"
import * as z from "zod"

import { FlatPoint } from "./geojson"
import { Label, Paragraph } from "./text"

/** The register's id of one address: a UUID by its shape alone, lowercase — DAR's ids carry no RFC 9562 variant, so `z.uuid()` would refuse them. */
export const AddressId = z.guid().toLowerCase()
export type AddressId = z.infer<typeof AddressId>

/** The most characters a search asks with, and the fewest. */
export const ADDRESS_QUERY_MIN = 2
export const ADDRESS_QUERY_MAX = 200
/** The most addresses one search answers with. */
export const ADDRESS_SEARCH_MAX = 10

/** What the register's data is credited as, wherever a surface shows it. */
export const ADDRESS_ATTRIBUTION = "Indeholder data fra Klimadatastyrelsen, CC BY 4.0"

const FourDigits = (what: string) => z.string().regex(new RegExp(FOUR_DIGITS_PATTERN), { error: `${what} is four digits` })

/** One address's parts as the register holds them (@waste/domain/registry/address). */
export const AddressParts = z.object({
  streetName: Label,
  houseNumber: Label,
  floor: Label.nullable(),
  door: Label.nullable(),
  postcode: FourDigits("A postcode"),
  postTown: Label,
  municipalityCode: FourDigits("A municipality code"),
})
export type AddressParts = z.infer<typeof AddressParts>

export const AddressSearchQuery = z.strictObject({
  /** The text a person has typed so far: the beginning of a street, a number, a postcode. */
  q: z.string().trim().min(ADDRESS_QUERY_MIN, { error: `Type at least ${ADDRESS_QUERY_MIN} characters of the address` }).max(ADDRESS_QUERY_MAX),
})
export type AddressSearchQuery = z.infer<typeof AddressSearchQuery>

/** One address a search found: enough to offer it, which `GET /addresses/:id` then reads whole. */
export const AddressMatch = z.object({
  id: AddressId,
  /** `Parkvej 18, 2100 København Ø`. */
  designation: Paragraph,
})
export type AddressMatch = z.infer<typeof AddressMatch>

export const AddressSearch = z.object({
  items: z.array(AddressMatch).max(ADDRESS_SEARCH_MAX),
  attribution: z.string(),
})
export type AddressSearch = z.infer<typeof AddressSearch>

/** One address whole: what a Property found in the register stores. */
export const Address = z.object({
  id: AddressId,
  designation: Paragraph,
  parts: AddressParts,
  /** The property it lies on, a BFE number; null where the register names none. */
  registryId: Label.nullable(),
  /** Its access point, where a vehicle reaches it; null where the register has not placed it. */
  location: FlatPoint.nullable(),
  attribution: z.string(),
})
export type Address = z.infer<typeof Address>
