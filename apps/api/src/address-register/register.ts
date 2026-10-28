// The address register the API asks (#291 C13, #290 O29): the national
// address register, DAR, behind one seam, as the routing provider is behind
// @waste/routing's (#131). Two answers are asked of it: the addresses whose
// designation a typed text begins (`search`), and one address whole by the
// register's id (`find`), with its parts, the BFE number of the property it
// lies on, and its access point. A register that does not answer — down,
// slow, its key refused, an answer this API cannot read — throws
// `RegisterUnavailable`, which a route answers as a 503 naming what the
// office can do without it; an id the register does not know is `null`, not
// a failure. Only the API calls it, with the key server-side (#173's rule for
// the routing key), and never inside a transaction (#124 §4).
import type { Address, AddressMatch } from "@waste/contracts/addresses"

export type AddressRegister = {
  /** Whose register it is: `fake` or `dataforsyningen`. */
  readonly name: string
  /** The addresses whose designation the text begins, ADDRESS_SEARCH_MAX at most, in the register's order. */
  search(text: string): Promise<AddressMatch[]>
  /** One address whole; null when the register holds no address by that id. */
  find(id: string): Promise<Address | null>
}

/** The register did not answer, or not in a shape this API reads; `reason` is for the log, never the client. */
export class RegisterUnavailable extends Error {
  constructor(readonly reason: string) {
    super(`The address register did not answer: ${reason}`)
    this.name = "RegisterUnavailable"
  }
}

/** What a person is told when the register does not answer: what they can do without it. */
export const REGISTER_UNAVAILABLE = "The address register is not answering right now. Try again in a moment, or type the address and place the point by hand."
