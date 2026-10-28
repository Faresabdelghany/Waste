// A structured address (#291 C13, #290 O29): the parts the national address
// register (DAR, read through Datafordeleren and Dataforsyningen) holds for one
// address — the street and the house number, a floor and a door where the
// address is a unit inside a building, the postcode and its town, and the
// municipality's code — and the one designation a person reads them as. A
// Property found in the register stores these parts beside the register's id
// for the address, so the text it shows is the register's, spelled here once:
// the web's picker, the API's fake register and the property's own text agree.
//
// The designation is the Danish one: `Parkvej 18, 2100 København Ø`, and for a
// unit `Nørrebrogade 20, 2. th, 2200 København N` — the floor with its period
// when it is a number, the door after it. A postcode and a municipality's code
// are four digits each.

/** The parts of one address as the register holds them. */
export type AddressParts = {
  streetName: string
  houseNumber: string
  /** The floor of a unit: `st`, `kl`, `1`, `2`; null for the house number's own address. */
  floor: string | null
  /** The door of a unit: `th`, `tv`, `mf`, `3`; null where the address has none. */
  door: string | null
  postcode: string
  postTown: string
  /** The municipality's four-digit code: `0101` is Copenhagen. */
  municipalityCode: string
}

/** A postcode's shape and a municipality code's, as a regular expression's source: four digits. */
export const FOUR_DIGITS_PATTERN = "^[0-9]{4}$"

/** The floor as it is printed: a number takes a period (`2.`), a word stays as it is (`st`, `kl`). */
const floorPrinted = (floor: string): string => (/^[0-9]+$/.test(floor) ? `${floor}.` : floor)

/** The address as a person reads it: the street and number, the unit where there is one, then the postcode and town. */
export function addressDesignation(parts: AddressParts): string {
  const street = `${parts.streetName} ${parts.houseNumber}`
  const unit = [parts.floor === null ? null : floorPrinted(parts.floor), parts.door].filter((piece): piece is string => piece !== null && piece !== "").join(" ")
  return [street, ...(unit === "" ? [] : [unit]), `${parts.postcode} ${parts.postTown}`].join(", ")
}
