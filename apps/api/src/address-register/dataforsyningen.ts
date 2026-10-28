// The live address register (#291 C13, #77): Klimadatastyrelsen's address
// services on Dataforsyningen's gateway, which took over DAWA's address API
// when DAWA closed on 2026-10-01, read from DAR. Asked with the Dataforsyningen
// token as the `token` query parameter over HTTPS (#77's comment: the
// parameter is mandatory), server-side only and never logged.
//
// Two requests, in DAWA's spelling, which the successor keeps:
// `GET /adresser/autocomplete?q=&per_side=` for a search — each item's
// `tekst` and its `adresse.id` — and `GET /adresser/{id}` for one address,
// nested: the unit's `etage` and `dør`, and under `adgangsadresse` the street
// (`vejstykke.navn`), `husnr`, `postnummer.nr`/`navn`, `kommune.kode`, the
// access point (`adgangspunkt.koordinater`, longitude then latitude in WGS 84)
// and the plot's BFE number (`jordstykke.bfenummer`), the last two read where
// present. A 404 is an id the register does not hold. The response shapes
// were spelled from DAWA's documentation without a live call — no token
// existed when this was written (#375) — so the first call with the owner's
// token confirms them; anything else the gateway answers is
// `RegisterUnavailable`, never a guess.
import { ADDRESS_ATTRIBUTION, ADDRESS_SEARCH_MAX, type Address, type AddressMatch } from "@waste/contracts/addresses"
import { addressDesignation, type AddressParts } from "@waste/domain/registry/address"
import * as z from "zod"

import { RegisterUnavailable, type AddressRegister } from "./register"

/** The gateway, unless ADDRESS_REGISTER_URL names another (the architecture's one config seam for every provider URL). */
export const DATAFORSYNINGEN_URL = "https://api.dataforsyningen.dk"
/** How long one call may take before the office is told the register is not answering. */
export const REGISTER_TIMEOUT_MS = 5000

const Autocomplete = z.array(z.object({ tekst: z.string().min(1), adresse: z.object({ id: z.string() }) }))

const OptionalText = z
  .string()
  .nullish()
  .transform((value) => (value == null || value.trim() === "" ? null : value.trim()))

const Nested = z.object({
  id: z.string(),
  etage: OptionalText,
  dør: OptionalText,
  adgangsadresse: z.object({
    vejstykke: z.object({ navn: z.string().min(1) }),
    husnr: z.string().min(1),
    postnummer: z.object({ nr: z.string().regex(/^[0-9]{4}$/), navn: z.string().min(1) }),
    kommune: z.object({ kode: z.string().regex(/^[0-9]{4}$/) }),
    adgangspunkt: z.object({ koordinater: z.tuple([z.number(), z.number()]).nullish() }).nullish(),
    jordstykke: z.object({ bfenummer: z.union([z.number(), z.string()]).nullish() }).nullish(),
  }),
})

export type DataforsyningenOptions = {
  token: string
  baseUrl?: string
  /** The fetch it calls; a test injects its own. */
  fetch?: typeof fetch
}

export class DataforsyningenRegister implements AddressRegister {
  readonly name = "dataforsyningen"
  readonly #token: string
  readonly #baseUrl: string
  readonly #fetch: typeof fetch

  constructor({ token, baseUrl = DATAFORSYNINGEN_URL, fetch: given = fetch }: DataforsyningenOptions) {
    this.#token = token
    this.#baseUrl = baseUrl.replace(/\/+$/, "")
    this.#fetch = given
  }

  async search(text: string): Promise<AddressMatch[]> {
    const answer = await this.#get("/adresser/autocomplete", { q: text, per_side: String(ADDRESS_SEARCH_MAX) })
    if (answer === null) throw new RegisterUnavailable("the search answered 404")
    const items = read(Autocomplete, answer, "a search")
    return items.slice(0, ADDRESS_SEARCH_MAX).map((item) => ({ id: item.adresse.id.toLowerCase(), designation: item.tekst }))
  }

  async find(id: string): Promise<Address | null> {
    const answer = await this.#get(`/adresser/${encodeURIComponent(id)}`, {})
    if (answer === null) return null
    const found = read(Nested, answer, "an address")
    const at = found.adgangsadresse
    const parts: AddressParts = {
      streetName: at.vejstykke.navn,
      houseNumber: at.husnr,
      floor: found.etage,
      door: found.dør,
      postcode: at.postnummer.nr,
      postTown: at.postnummer.navn,
      municipalityCode: at.kommune.kode,
    }
    const point = at.adgangspunkt?.koordinater ?? null
    const bfe = at.jordstykke?.bfenummer
    return {
      id: found.id.toLowerCase(),
      designation: addressDesignation(parts),
      parts,
      registryId: bfe == null ? null : String(bfe),
      location: point === null ? null : { type: "Point", coordinates: point },
      attribution: ADDRESS_ATTRIBUTION,
    }
  }

  /** One GET with the token; the parsed JSON, null on a 404, `RegisterUnavailable` on anything else that is not a 200. */
  async #get(path: string, query: Record<string, string>): Promise<unknown> {
    const url = new URL(`${this.#baseUrl}${path}`)
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
    url.searchParams.set("token", this.#token)
    let response: Response
    try {
      response = await this.#fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS) })
    } catch (error) {
      // The URL carries the token, so the reason names the path alone.
      throw new RegisterUnavailable(`${path}: ${error instanceof Error ? error.name : "the call failed"}`)
    }
    if (response.status === 404) return null
    if (!response.ok) throw new RegisterUnavailable(`${path} answered ${response.status}`)
    try {
      return (await response.json()) as unknown
    } catch {
      throw new RegisterUnavailable(`${path} answered something other than JSON`)
    }
  }
}

function read<Schema extends z.ZodType>(schema: Schema, answer: unknown, what: string): z.infer<Schema> {
  const parsed = schema.safeParse(answer)
  if (!parsed.success) throw new RegisterUnavailable(`${what} came back in a shape this API does not read: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}
