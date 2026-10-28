// The fake address register (#291 C13): what CI, the tests and the e2e lane
// ask, since no register key exists on the public repository — the routing
// provider's fake is the model (#131). A fixed handful of Copenhagen
// addresses, two of them the seed's own properties' (Parkvej 18 and Sundbyvej
// 91) and two units of one house, each with an id shaped as DAR's, the
// parts, a BFE number and an access point; one has neither BFE nor point, as
// a register's address may lack both. A search is word by word: every word of
// the text begins some word of the designation, case and punctuation aside,
// so `park 18` finds Parkvej 18. `down` scripts a register that does not
// answer, for the routes' 503.
import type { Address, AddressMatch } from "@waste/contracts/addresses"
import { ADDRESS_ATTRIBUTION, ADDRESS_SEARCH_MAX } from "@waste/contracts/addresses"
import { addressDesignation, type AddressParts } from "@waste/domain/registry/address"

import { RegisterUnavailable, type AddressRegister } from "./register"

type Entry = { id: string; parts: AddressParts; registryId: string | null; at: [number, number] | null }

const street = (streetName: string, houseNumber: string, postcode: string, postTown: string, municipalityCode = "0101"): AddressParts => ({
  streetName,
  houseNumber,
  floor: null,
  door: null,
  postcode,
  postTown,
  municipalityCode,
})

/** The ids are DAR-shaped — a UUID whose variant RFC 9562 does not name — numbered by their last two digits. */
const darId = (n: number) => `0a3f50a0-75ba-32b8-e044-0003ba2980${String(n).padStart(2, "0")}`

/** The fake register's addresses, in designation order. */
export const FAKE_ADDRESSES: readonly Entry[] = [
  { id: darId(1), parts: street("Amagerbrogade", "150", "2300", "København S"), registryId: "100045671", at: [12.6031, 55.6612] },
  { id: darId(2), parts: street("Havnegade", "1", "1058", "København K"), registryId: null, at: null },
  { id: darId(3), parts: { ...street("Nørrebrogade", "20", "2200", "København N"), floor: "2", door: "th" }, registryId: "100045672", at: [12.5611, 55.6873] },
  { id: darId(4), parts: { ...street("Nørrebrogade", "20", "2200", "København N"), floor: "2", door: "tv" }, registryId: "100045673", at: [12.5611, 55.6873] },
  { id: darId(5), parts: street("Parkvej", "18", "2100", "København Ø"), registryId: "100045674", at: [12.5763, 55.7046] },
  { id: darId(6), parts: street("Parkvej", "20", "2100", "København Ø"), registryId: "100045675", at: [12.5766, 55.7048] },
  { id: darId(7), parts: street("Strandvejen", "100", "2900", "Hellerup", "0157"), registryId: "100045676", at: [12.5781, 55.7316] },
  { id: darId(8), parts: street("Sundbyvej", "91", "2300", "København S"), registryId: "100045677", at: [12.6107, 55.6482] },
  { id: darId(9), parts: street("Vesterbrogade", "1", "1620", "København V"), registryId: "100045678", at: [12.5649, 55.6754] },
  { id: darId(10), parts: street("Østerbrogade", "50", "2100", "København Ø"), registryId: "100045679", at: [12.5772, 55.6981] },
]

/** A text as the search compares it: lowercase words, commas and periods aside. */
const wordsOf = (text: string): string[] =>
  text
    .toLocaleLowerCase("da")
    .replace(/[.,]/g, " ")
    .split(/\s+/)
    .filter((word) => word !== "")

const addressOf = (entry: Entry): Address => ({
  id: entry.id,
  designation: addressDesignation(entry.parts),
  parts: entry.parts,
  registryId: entry.registryId,
  location: entry.at === null ? null : { type: "Point", coordinates: entry.at },
  attribution: ADDRESS_ATTRIBUTION,
})

export class FakeAddressRegister implements AddressRegister {
  readonly name = "fake"
  /** Whether it answers; a test turns it off to see the 503. */
  down: boolean

  constructor(options: { down?: boolean } = {}) {
    this.down = options.down ?? false
  }

  async search(text: string): Promise<AddressMatch[]> {
    this.answering()
    const asked = wordsOf(text)
    return FAKE_ADDRESSES.map(addressOf)
      .filter((address) => {
        const words = wordsOf(address.designation)
        return asked.every((word) => words.some((held) => held.startsWith(word)))
      })
      .slice(0, ADDRESS_SEARCH_MAX)
      .map(({ id, designation }) => ({ id, designation }))
  }

  async find(id: string): Promise<Address | null> {
    this.answering()
    const entry = FAKE_ADDRESSES.find((candidate) => candidate.id === id.toLowerCase())
    return entry === undefined ? null : addressOf(entry)
  }

  private answering(): void {
    if (this.down) throw new RegisterUnavailable("the fake register is scripted down")
  }
}
