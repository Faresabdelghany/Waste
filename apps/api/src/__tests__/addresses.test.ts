// The address lookup and a property found in the register (#291 C13): the
// search and the one-address read under a grant to create or edit
// properties, and a property created or changed with an `addressId`, stored
// with the register's designation, parts, BFE number and point, the body's
// own registry identifier and point winning. A register that does not
// answer is a 502 with nothing written, and the typed address with a point
// placed by hand still goes through. The fake register throughout, scripted
// down where a test needs it.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Address, AddressSearch } from "@waste/contracts/addresses"
import { Property } from "@waste/contracts/customers"
import type { Point } from "@waste/contracts/geojson"
import { createDb, type Database } from "@waste/db/client"

import { FAKE_ADDRESSES, FakeAddressRegister } from "../address-register/fake"
import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const MODULE = "customers.properties"

const entry = (streetName: string, houseNumber: string, door?: string) =>
  FAKE_ADDRESSES.find((candidate) => candidate.parts.streetName === streetName && candidate.parts.houseNumber === houseNumber && (door === undefined || candidate.parts.door === door))!
const PARKVEJ_18 = entry("Parkvej", "18")
const PARKVEJ_20 = entry("Parkvej", "20")
const NORREBROGADE_TH = entry("Nørrebrogade", "20", "th")
const HAVNEGADE = entry("Havnegade", "1")
const STRANDVEJEN = entry("Strandvejen", "100")
const VESTERBROGADE = entry("Vesterbrogade", "1")
const AMAGERBROGADE = entry("Amagerbrogade", "150")
const OSTERBROGADE = entry("Østerbrogade", "50")
const UNKNOWN = "0a3f50a0-75ba-32b8-e044-0003ba2989ff"

/** A gate behind the house, placed by hand. */
const gate: Point = { type: "Point", coordinates: [12.577, 55.705] }

describe("the address lookup and a property found in the register", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let register: FakeAddressRegister
  let olivia: Call
  /** View and edit, no create: the picker serves the edit form too. */
  let editor: Call
  /** View alone: no form to pick for. */
  let reader: Call

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "edit"] }])
    await grantRole(pool, a.companyId, a.roles.providerManager.id, [{ moduleKey: MODULE, actions: ["view"] }])
    register = new FakeAddressRegister()
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, addressRegister: register, log: () => {} })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    editor = callingAs(app, keys, a.users.viewer, a.companyId)
    reader = callingAs(app, keys, a.users.lars, a.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    await pool?.close()
  })

  /** The register answers again after a test that scripted it down. */
  const answering = async <T>(run: () => Promise<T>): Promise<T> => {
    register.down = true
    try {
      return await run()
    } finally {
      register.down = false
    }
  }

  const found = (name: string, addressId: string, extra: Record<string, unknown> = {}) => ({ projectId: a.projects.copenhagen.id, name, addressId, kind: "residential", ...extra })
  const createFound = async (body: unknown): Promise<Property> => created(olivia, "/properties", await olivia("/properties", { method: "POST", body }), Property)
  const patch = async (call: Call, id: string, body: unknown) => call(`/properties/${id}`, { method: "PATCH", body })

  describe("GET /addresses and GET /addresses/:id", () => {
    test("search the register by the text typed so far, with the attribution the register is owed", async () => {
      const response = await editor("/addresses?q=park%2018")
      assert.equal(response.status, 200)
      const answer = AddressSearch.parse(await response.json())
      assert.deepEqual(answer.items, [{ id: PARKVEJ_18.id, designation: "Parkvej 18, 2100 København Ø" }])
      assert.match(answer.attribution, /Klimadatastyrelsen/)
      assert.deepEqual(AddressSearch.parse(await (await olivia("/addresses?q=Ingenvej")).json()).items, [])
    })

    test("read one address whole: its parts, its BFE number and its point", async () => {
      const response = await olivia(`/addresses/${NORREBROGADE_TH.id}`)
      assert.equal(response.status, 200)
      const address = Address.parse(await response.json())
      assert.equal(address.designation, "Nørrebrogade 20, 2. th, 2200 København N")
      assert.deepEqual(address.parts, NORREBROGADE_TH.parts)
      assert.equal(address.registryId, NORREBROGADE_TH.registryId)
      assert.deepEqual(address.location, { type: "Point", coordinates: NORREBROGADE_TH.at })
    })

    test("refuse a short text, a path that is not a UUID, and an id the register does not hold", async () => {
      assert.deepEqual((await readProblem(await olivia("/addresses?q=p"))).errors?.map((error) => error.path), ["q"])
      assert.equal((await olivia("/addresses/parkvej-18")).status, 400)
      const missing = await olivia(`/addresses/${UNKNOWN}`)
      assert.equal(missing.status, 404)
      assert.match((await readProblem(missing)).detail ?? "", /No address .* in the address register/)
    })

    test("are refused to a role that may neither create nor edit properties", async () => {
      assert.equal((await reader("/addresses?q=park")).status, 403)
      assert.equal((await reader(`/addresses/${PARKVEJ_18.id}`)).status, 403)
    })

    test("answer 502 while the register does not answer, saying what the office can do without it", async () => {
      await answering(async () => {
        for (const path of ["/addresses?q=park", `/addresses/${PARKVEJ_18.id}`]) {
          const response = await olivia(path)
          assert.equal(response.status, 502)
          assert.match((await readProblem(response)).detail ?? "", /type the address and place the point by hand/)
        }
      })
    })
  })

  describe("a deployment that names no register (ADDRESS_PROVIDER unset)", () => {
    test("answers the lookup and a write naming an addressId 503, address lookup not set up; a typed address still goes through", async () => {
      const app = createApp({ probe: pool, pool, verifier: keys.verifier, log: () => {} })
      const office = callingAs(app, keys, a.users.olivia, a.companyId)
      for (const [path, init] of [
        ["/addresses?q=park", {}],
        [`/addresses/${PARKVEJ_18.id}`, {}],
        ["/properties", { method: "POST", body: found("Parkvej 18 · no register", PARKVEJ_18.id) }],
      ] as const) {
        const response = await office(path, init)
        assert.equal(response.status, 503, path)
        assert.match((await readProblem(response)).detail ?? "", /Address lookup is not set up on this deployment/)
      }
      const typed = await created(office, "/properties", await office("/properties", { method: "POST", body: { projectId: a.projects.copenhagen.id, name: "Parkvej 18 · no register, typed", address: "Parkvej 18, 2100 København Ø", kind: "residential", location: gate } }), Property)
      assert.deepEqual([typed.addressId, typed.location], [null, gate])
    })
  })

  describe("a property created with an addressId", () => {
    test("is the register's address, its parts, its BFE number and its point: geocoded as it is created", async () => {
      const property = await createFound(found("Parkvej 18 · found", PARKVEJ_18.id.toUpperCase()))
      assert.equal(property.address, "Parkvej 18, 2100 København Ø")
      assert.equal(property.addressId, PARKVEJ_18.id)
      assert.deepEqual(property.addressParts, PARKVEJ_18.parts)
      assert.equal(property.registryId, PARKVEJ_18.registryId)
      assert.deepEqual(property.location, { type: "Point", coordinates: PARKVEJ_18.at })
      assert.deepEqual(Property.parse(await (await olivia(`/properties/${property.id}`)).json()), property, "the answer is the next read")
    })

    test("keeps the body's own point and registry identifier over the register's", async () => {
      const property = await createFound(found("Parkvej 20 · gate", PARKVEJ_20.id, { location: gate, registryId: null }))
      assert.deepEqual(property.location, gate)
      assert.equal(property.registryId, null)
      assert.equal(property.addressId, PARKVEJ_20.id)
    })

    test("stores a unit's floor and door, and an address the register has not placed with no point", async () => {
      const unit = await createFound(found("Nørrebrogade 20 · 2. th", NORREBROGADE_TH.id))
      assert.deepEqual([unit.addressParts?.floor, unit.addressParts?.door], ["2", "th"])
      const unplaced = await createFound(found("Havnegade 1 · found", HAVNEGADE.id))
      assert.deepEqual([unplaced.location, unplaced.registryId, unplaced.address], [null, null, "Havnegade 1, 1058 København K"])
    })

    test("is refused, at addressId, for an id the register does not hold or beside a typed address, and is a 409 on a BFE number another property holds", async () => {
      const taken = await olivia("/properties", { method: "POST", body: found("Parkvej 18 · again", PARKVEJ_18.id) })
      assert.equal(taken.status, 409)
      assert.match((await readProblem(taken)).detail ?? "", /registry identifier 100045674/)
      const unknown = await readProblem(await olivia("/properties", { method: "POST", body: found("Nowhere", UNKNOWN) }))
      assert.deepEqual(unknown.errors, [{ path: "addressId", message: `No address ${UNKNOWN} in the address register` }])
      const both = await readProblem(await olivia("/properties", { method: "POST", body: found("Both", PARKVEJ_18.id, { address: "Parkvej 18" }) }))
      assert.deepEqual(both.errors?.map((error) => error.path), ["addressId"])
    })

    test("is a 502 with nothing written while the register does not answer; the typed address and a hand-placed point still go through", async () => {
      await answering(async () => {
        const response = await olivia("/properties", { method: "POST", body: found("Parkvej 18 · while down", PARKVEJ_18.id) })
        assert.equal(response.status, 502)
        const typed = await createFound({ projectId: a.projects.copenhagen.id, name: "Parkvej 18 · typed", address: "Parkvej 18, 2100 København Ø", kind: "residential", location: gate })
        assert.deepEqual([typed.addressId, typed.addressParts, typed.location], [null, null, gate])
      })
      const page = await (await olivia(`/properties?projectId=${a.projects.copenhagen.id}&limit=200`)).json()
      assert.equal((page as { items: Property[] }).items.some((row) => row.name === "Parkvej 18 · while down"), false)
    })

    test("asks for a signed-in caller allowed to create before the register is asked", async () => {
      assert.equal((await reader("/properties", { method: "POST", body: found("Reader's", PARKVEJ_18.id) })).status, 403)
      const anonymous = await createApp({ probe: pool, pool, verifier: keys.verifier, addressRegister: register }).request("/properties", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(found("Nobody's", PARKVEJ_18.id)),
      })
      assert.equal(anonymous.status, 401)
    })
  })

  describe("a property changed with an addressId", () => {
    test("moves to the register's address and point; a typed address, or a null id, lets the register's id and parts go", async () => {
      const property = await createFound(found("Moving", STRANDVEJEN.id))
      const moved = Property.parse(await (await patch(editor, property.id, { addressId: VESTERBROGADE.id })).json())
      assert.equal(moved.address, "Vesterbrogade 1, 1620 København V")
      assert.deepEqual(moved.location, { type: "Point", coordinates: VESTERBROGADE.at })
      assert.equal(moved.registryId, VESTERBROGADE.registryId)

      const unlinked = Property.parse(await (await patch(editor, property.id, { addressId: null })).json())
      assert.deepEqual([unlinked.addressId, unlinked.addressParts, unlinked.address, unlinked.location], [null, null, moved.address, moved.location], "the text and the point stay")

      assert.equal((await patch(editor, property.id, { addressId: AMAGERBROGADE.id, location: gate })).status, 200)
      const typed = Property.parse(await (await patch(editor, property.id, { address: "Amagerbrogade 150 (back gate), 2300 København S" })).json())
      assert.deepEqual([typed.addressId, typed.addressParts, typed.location], [null, null, gate])
    })

    test("is a 404 for a property the caller does not reach before the register's refusal, and a 400 at addressId for an id it does not hold", async () => {
      const property = await createFound(found("Refusing", OSTERBROGADE.id))
      assert.deepEqual((await readProblem(await patch(editor, property.id, { addressId: UNKNOWN }))).errors?.map((error) => error.path), ["addressId"])
      assert.equal((await patch(editor, "01a0d2a4-a280-7001-8000-00000000dead", { addressId: HAVNEGADE.id })).status, 404)
    })
  })
})
