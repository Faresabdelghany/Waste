import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { Address, ADDRESS_ATTRIBUTION, AddressMatch } from "@waste/contracts/addresses"

import { DataforsyningenRegister } from "../dataforsyningen"
import { FAKE_ADDRESSES, FakeAddressRegister } from "../fake"
import { RegisterUnavailable } from "../register"
import { addressRegisterFrom } from "../select"

const PARKVEJ_18 = FAKE_ADDRESSES.find((entry) => entry.parts.streetName === "Parkvej" && entry.parts.houseNumber === "18")!

describe("the fake address register", () => {
  const register = new FakeAddressRegister()

  test("finds by every word beginning some word of the designation, case and punctuation aside", async () => {
    assert.deepEqual(await register.search("park 18"), [{ id: PARKVEJ_18.id, designation: "Parkvej 18, 2100 København Ø" }])
    assert.deepEqual((await register.search("PARKVEJ")).map((match) => match.designation), ["Parkvej 18, 2100 København Ø", "Parkvej 20, 2100 København Ø"])
    assert.deepEqual((await register.search("nørrebrogade 20, 2.")).map((match) => match.designation), ["Nørrebrogade 20, 2. th, 2200 København N", "Nørrebrogade 20, 2. tv, 2200 København N"])
    assert.deepEqual(await register.search("Ingenvej"), [])
    for (const match of await register.search("københavn")) AddressMatch.parse(match)
  })

  test("reads one address whole by its id, any case, and none by an id it does not hold", async () => {
    const found = await register.find(PARKVEJ_18.id.toUpperCase())
    assert.deepEqual(Address.parse(found), found)
    assert.deepEqual(found?.location, { type: "Point", coordinates: [12.5763, 55.7046] })
    assert.equal(found?.registryId, "100045674")
    assert.equal(found?.attribution, ADDRESS_ATTRIBUTION)
    const havnegade = FAKE_ADDRESSES.find((entry) => entry.parts.streetName === "Havnegade")!
    assert.deepEqual(await register.find(havnegade.id).then((address) => [address?.registryId, address?.location]), [null, null], "an address may have neither BFE nor point")
    assert.equal(await register.find("00000000-0000-0000-0000-000000000000"), null)
  })

  test("holds DAR-shaped ids, each its own", () => {
    assert.equal(new Set(FAKE_ADDRESSES.map((entry) => entry.id)).size, FAKE_ADDRESSES.length)
    for (const entry of FAKE_ADDRESSES) Address.shape.id.parse(entry.id)
  })

  test("scripted down, answers neither question", async () => {
    const down = new FakeAddressRegister({ down: true })
    await assert.rejects(down.search("park"), RegisterUnavailable)
    await assert.rejects(down.find(PARKVEJ_18.id), RegisterUnavailable)
  })
})

describe("the register switch", () => {
  test("is no register unless ADDRESS_PROVIDER names one: the fake only when named, the live register with its token", () => {
    assert.equal(addressRegisterFrom({}), null, "never the fake by default: its made-up addresses would land on real properties")
    assert.equal(addressRegisterFrom({ ADDRESS_PROVIDER: "fake" })?.name, "fake")
    assert.equal(addressRegisterFrom({ ADDRESS_PROVIDER: "dataforsyningen", DATAFORSYNINGEN_TOKEN: "test-only" })?.name, "dataforsyningen")
    assert.throws(() => addressRegisterFrom({ ADDRESS_PROVIDER: "dataforsyningen" }), /DATAFORSYNINGEN_TOKEN/)
    assert.throws(() => addressRegisterFrom({ ADDRESS_PROVIDER: "dataforsyningen", DATAFORSYNINGEN_TOKEN: "  " }), /DATAFORSYNINGEN_TOKEN/)
    assert.throws(() => addressRegisterFrom({ ADDRESS_PROVIDER: "dawa" }), /"fake" and "dataforsyningen"/)
  })
})

describe("the live register's client", () => {
  const ID = "0a3f50a0-75ba-32b8-e044-0003ba298018"
  /** A scripted gateway: the answers by path, and the URLs it was asked. */
  const gateway = (answers: Record<string, { status: number; body?: unknown }>) => {
    const asked: URL[] = []
    const fetch = (async (input: URL | string | Request) => {
      const url = new URL(String(input))
      asked.push(url)
      const answer = answers[url.pathname] ?? { status: 404 }
      return new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status })
    }) as typeof globalThis.fetch
    return { asked, register: new DataforsyningenRegister({ token: "test-only-token", baseUrl: "https://gateway.example/", fetch }) }
  }

  const nested = {
    id: ID.toUpperCase(),
    etage: "2",
    dør: "th",
    adgangsadresse: {
      vejstykke: { navn: "Nørrebrogade" },
      husnr: "20",
      postnummer: { nr: "2200", navn: "København N" },
      kommune: { kode: "0101" },
      adgangspunkt: { koordinater: [12.5611, 55.6873] },
      jordstykke: { bfenummer: 100045672 },
    },
  }

  test("searches with the text, ten at most and the token, and reads each item's text and id", async () => {
    const { asked, register } = gateway({ "/adresser/autocomplete": { status: 200, body: [{ tekst: "Nørrebrogade 20, 2. th, 2200 København N", adresse: { id: ID } }] } })
    assert.deepEqual(await register.search("nørrebro 20"), [{ id: ID, designation: "Nørrebrogade 20, 2. th, 2200 København N" }])
    assert.equal(asked[0].origin, "https://gateway.example")
    assert.deepEqual(Object.fromEntries(asked[0].searchParams), { q: "nørrebro 20", per_side: "10", token: "test-only-token" })
  })

  test("reads one address nested: the unit, the street, the postcode, the municipality, the access point and the BFE number", async () => {
    const { register } = gateway({ [`/adresser/${ID}`]: { status: 200, body: nested } })
    assert.deepEqual(await register.find(ID), {
      id: ID,
      designation: "Nørrebrogade 20, 2. th, 2200 København N",
      parts: { streetName: "Nørrebrogade", houseNumber: "20", floor: "2", door: "th", postcode: "2200", postTown: "København N", municipalityCode: "0101" },
      registryId: "100045672",
      location: { type: "Point", coordinates: [12.5611, 55.6873] },
      attribution: ADDRESS_ATTRIBUTION,
    })
  })

  test("reads an address with no unit, no access point and no plot as nulls", async () => {
    const bare = { ...nested, etage: null, dør: "", adgangsadresse: { ...nested.adgangsadresse, adgangspunkt: null, jordstykke: null } }
    const { register } = gateway({ [`/adresser/${ID}`]: { status: 200, body: bare } })
    const found = await register.find(ID)
    assert.deepEqual([found?.parts.floor, found?.parts.door, found?.location, found?.registryId], [null, null, null, null])
  })

  test("reads a 404 as an id the register does not hold, and anything else unread as the register not answering", async () => {
    assert.equal(await gateway({}).register.find(ID), null)
    await assert.rejects(gateway({ [`/adresser/${ID}`]: { status: 401 } }).register.find(ID), RegisterUnavailable)
    await assert.rejects(gateway({ [`/adresser/${ID}`]: { status: 200, body: { id: ID } } }).register.find(ID), RegisterUnavailable)
    await assert.rejects(gateway({ "/adresser/autocomplete": { status: 503 } }).register.search("park"), RegisterUnavailable)
    const failing = new DataforsyningenRegister({ token: "test-only-token", fetch: (async () => Promise.reject(new TypeError("fetch failed"))) as typeof fetch })
    await assert.rejects(failing.search("park"), (error: unknown) => error instanceof RegisterUnavailable && !error.message.includes("test-only-token"))
  })
})
