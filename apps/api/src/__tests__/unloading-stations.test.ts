import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { WasteFraction } from "@waste/contracts/catalogue"
import type { Point } from "@waste/contracts/geojson"
import { Id } from "@waste/contracts/ids"
import { Page } from "@waste/contracts/pagination"
import { BOTH_HOURS_OR_NEITHER, EACH_FRACTION_ONCE, PROVIDER_WITH_PROVIDER_OWNERSHIP, UnloadingStation } from "@waste/contracts/places"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { nextMillisecond } from "./clock"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const UnloadingStationPage = Page(UnloadingStation)

const MODULE = "resources.depots"

/** ARC Amager, where every Copenhagen project unloads. */
const amager: Point = { type: "Point", coordinates: [12.6206, 55.6647] }
/** Vestforbrænding, for a station that moves. */
const glostrup: Point = { type: "Point", coordinates: [12.4067, 55.7003] }

/** What an account that works in no project is told when it tries to register a station. */
const REACHES_NO_STATION = "This account works in no project and reaches no unloading station"

/** The order a set reads back in: by the id an entry names, which it names once. */
const inReadOrder = (ids: readonly string[]): string[] => [...ids].sort()

describe("the unloading station endpoints", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  /** The company under test. */
  let a: Tenant
  /** The other company, written to once below and never again. */
  let b: Tenant
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role, granted view, create and edit, with Project Access to Copenhagen Central only: a station serves every project, so it reads them all. */
  let viewer: Call
  /** The Service Provider Manager, granted view and create but not edit: a role that works in no project of the company, and so reaches no station whatever it is granted. */
  let lars: Call
  let other: Call
  /** A role with `configure.access` and nothing else: the 403s. */
  let ungranted: Call

  /** This company's fractions, what a station may accept. */
  let residual: WasteFraction
  let glass: WasteFraction
  let food: WasteFraction
  /** The other company's. */
  let theirFraction: WasteFraction
  let theirStation: UnloadingStation

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: MODULE, actions: ["view", "create", "edit"] }])
    await grantRole(pool, a.companyId, a.roles.providerManager.id, [{ moduleKey: MODULE, actions: ["view", "create"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    residual = await create(olivia, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    glass = await create(olivia, "/waste-fractions", { key: "glass", name: "Glass" }, WasteFraction)
    food = await create(olivia, "/waste-fractions", { key: "food", name: "Food waste" }, WasteFraction)
    theirFraction = await create(other, "/waste-fractions", { key: "residual", name: "Residual waste" }, WasteFraction)
    theirStation = await create(other, "/unloading-stations", body("ARC-THEIRS", { wasteFractionIds: [theirFraction.id] }), UnloadingStation)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  type Schema<T> = { parse: (value: unknown) => T }

  /** A station body a caller may send: the fields with no default, and nothing else. */
  const body = (code: string, values: Record<string, unknown> = {}) => ({
    code,
    name: `Station ${code}`,
    address: `${code}, Kraftværksvej 31, 2300 København S`,
    location: amager,
    ownership: "external",
    ...values,
  })

  const create = async <T>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> => {
    const response = await call(path, { method: "POST", body: values })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const station = (code: string, values: Record<string, unknown> = {}) => create(olivia, "/unloading-stations", body(code, values), UnloadingStation)
  const one = async (call: Call, id: string): Promise<UnloadingStation> => {
    const response = await call(`/unloading-stations/${id}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return UnloadingStation.parse(await response.json())
  }
  const patch = async (call: Call, id: string, values: unknown): Promise<UnloadingStation> => {
    const response = await call(`/unloading-stations/${id}`, { method: "PATCH", body: values })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return UnloadingStation.parse(await response.json())
  }
  const put = async (call: Call, id: string, wasteFractionIds: unknown): Promise<UnloadingStation> => {
    const response = await call(`/unloading-stations/${id}/fractions`, { method: "PUT", body: { wasteFractionIds } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return UnloadingStation.parse(await response.json())
  }
  const page = async (call: Call, query = "") => {
    const response = await call(`/unloading-stations${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return UnloadingStationPage.parse(await response.json())
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const paths = (problem: { errors?: { path: string }[] }) => problem.errors?.map((error) => error.path)

  describe("POST /unloading-stations", () => {
    test("mints the id, names no project, defaults the weighbridge to false and the status to active, and accepts nothing until it is told to", async () => {
      const created = await station("ARC-AMAGER", { name: "ARC Amager" })
      assert.equal(Id.parse(created.id), created.id, "a version 7 id the server minted")
      assert.equal("projectId" in created, false, "a station is the company's")
      assert.deepEqual([created.code, created.name, created.ownership], ["ARC-AMAGER", "ARC Amager", "external"])
      assert.equal(created.weighbridge, false)
      assert.equal(created.status, "active", "a station is registered because routes already empty there")
      assert.deepEqual(created.location, amager, "a route empties at a point")
      assert.deepEqual([created.serviceProviderId, created.opensAt, created.closesAt, created.notes], [null, null, null, null])
      assert.deepEqual(created.wasteFractionIds, [], "no fractions when the body names none")
      assert.deepEqual(await one(olivia, created.id), created)
    })

    test("takes the fractions it starts out accepting by id, the hours as HH:MM, and the weighbridge, and the read agrees", async () => {
      const created = await station("ARC-WEIGH", { wasteFractionIds: [glass.id, residual.id], opensAt: "06:00", closesAt: "22:00", weighbridge: true, notes: "Weighs on the way in and out" })
      assert.deepEqual(created.wasteFractionIds, inReadOrder([residual.id, glass.id]), "by id, whatever order the body spelled them in")
      assert.deepEqual([created.opensAt, created.closesAt], ["06:00", "22:00"], "without Postgres's seconds")
      assert.equal(created.weighbridge, true)
      assert.deepEqual(await one(olivia, created.id), created, "the answer is what the next read says")
    })

    test("takes a provider's station naming its provider, and refuses the ownership and the provider disagreeing, or a provider of another company", async () => {
      const created = await station("ARC-NORDREN", { ownership: "service-provider", serviceProviderId: a.serviceProviders.nordren.id })
      assert.equal(created.serviceProviderId, a.serviceProviders.nordren.id)
      const unnamed = await refused(await olivia("/unloading-stations", { method: "POST", body: body("ARC-SHAPE", { ownership: "service-provider" }) }), 400)
      assert.deepEqual(unnamed.errors, [{ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP }])
      const named = await refused(await olivia("/unloading-stations", { method: "POST", body: body("ARC-SHAPE", { serviceProviderId: a.serviceProviders.nordren.id }) }), 400)
      assert.deepEqual(named.errors, [{ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP }], "an external plant names no provider of ours")
      const foreign = await refused(
        await olivia("/unloading-stations", { method: "POST", body: body("ARC-SHAPE", { ownership: "service-provider", serviceProviderId: b.serviceProviders.nordren.id }) }),
        400,
      )
      assert.deepEqual(foreign.errors, [{ path: "serviceProviderId", message: "Not a service provider of this company" }])
      const half = await refused(await olivia("/unloading-stations", { method: "POST", body: body("ARC-SHAPE", { closesAt: "22:00" }) }), 400)
      assert.deepEqual(half.errors, [{ path: "closesAt", message: BOTH_HOURS_OR_NEITHER }])
    })

    test("refuses a fraction that is not this company's at the indexed path, the same fraction twice, and writes nothing", async () => {
      const foreign = await refused(await olivia("/unloading-stations", { method: "POST", body: body("ARC-REACH", { wasteFractionIds: [glass.id, theirFraction.id] }) }), 400)
      assert.deepEqual(foreign.errors, [{ path: "wasteFractionIds.1", message: "Not a waste fraction of this company" }])
      const unminted = await refused(await olivia("/unloading-stations", { method: "POST", body: body("ARC-REACH", { wasteFractionIds: [testId()] }) }), 400)
      assert.deepEqual(unminted.errors, [{ path: "wasteFractionIds.0", message: "Not a waste fraction of this company" }])
      const twice = await refused(await olivia("/unloading-stations", { method: "POST", body: body("ARC-REACH", { wasteFractionIds: [glass.id, glass.id] }) }), 400)
      assert.deepEqual(twice.errors, [{ path: "wasteFractionIds", message: EACH_FRACTION_ONCE }])
      assert.equal((await page(olivia, "?limit=200")).items.some((row) => row.code === "ARC-REACH"), false, "the station went with its set: one transaction")
    })

    test("insists on an ownership and a place, refuses a point off the globe, a project, and a member the server owns", async () => {
      assert.deepEqual(paths(await refused(await olivia("/unloading-stations", { method: "POST", body: body("ARC-OFF", { ownership: undefined }) }), 400)), ["ownership"])
      assert.deepEqual(paths(await refused(await olivia("/unloading-stations", { method: "POST", body: body("ARC-OFF", { location: undefined }) }), 400)), ["location"])
      assert.deepEqual(
        paths(await refused(await olivia("/unloading-stations", { method: "POST", body: body("ARC-OFF", { location: { type: "Point", coordinates: [12.6206, 91] } }) }), 400)),
        ["location.coordinates.1"],
      )
      const withProject = await refused(await olivia("/unloading-stations", { method: "POST", body: body("ARC-OFF", { projectId: a.projects.copenhagen.id }) }), 400)
      assert.ok(withProject.errors?.some((error) => /projectId/.test(error.message)), "a station is the company's: the body names no project")
      const owned = await refused(await olivia("/unloading-stations", { method: "POST", body: body("ARC-OFF", { id: testId() }) }), 400)
      assert.ok(owned.errors?.some((error) => /id/.test(error.message)), JSON.stringify(owned.errors))
    })

    test("refuses a code and a name the company already uses, each with its own sentence, and lets another company use them", async () => {
      await station("ARC-VEST", { name: "Vestforbrænding" })
      const code = await refused(await olivia("/unloading-stations", { method: "POST", body: body("ARC-VEST", { name: "Something else" }) }), 409)
      assert.equal(code.detail, 'This company already has an unloading station coded "ARC-VEST"')
      const name = await refused(await olivia("/unloading-stations", { method: "POST", body: body("ARC-VEST-2", { name: "Vestforbrænding" }) }), 409)
      assert.equal(name.detail, 'This company already has an unloading station called "Vestforbrænding"')
      assert.doesNotMatch(`${code.detail}${name.detail}`, /_key/)
      const theirs = await create(other, "/unloading-stations", body("ARC-VEST", { name: "Vestforbrænding" }), UnloadingStation)
      assert.equal(theirs.code, "ARC-VEST", "a code is one station's inside a company, and free in the next")
    })

    test("refuses an account that works in no project of the company, whatever its grant, with the rule as a 403", async () => {
      const problem = await refused(await lars("/unloading-stations", { method: "POST", body: body("ARC-LARS") }), 403)
      assert.equal(problem.detail, REACHES_NO_STATION)
      assert.equal((await page(olivia, "?limit=200")).items.some((row) => row.code === "ARC-LARS"), false)
      assert.match((await refused(await ungranted("/unloading-stations", { method: "POST", body: body("ARC-NOBODY") }), 403)).detail ?? "", /create on resources\.depots/)
    })
  })

  describe("GET /unloading-stations", () => {
    test("answers the company's stations in id order, each with its fractions, and holds nothing of another company's", async () => {
      const mine = await station("ARC-10", { wasteFractionIds: [food.id] })
      const { items } = await page(olivia, "?limit=200")
      const ids = items.map((row) => row.id)
      assert.ok(ids.includes(mine.id))
      assert.deepEqual(ids, [...ids].sort(), "ascending by id")
      assert.deepEqual(items.find((row) => row.id === mine.id), mine, "a row in the list carries its set, like the row on its own")
      assert.ok(!ids.includes(theirStation.id))
      assert.ok((await page(other, "?limit=200")).items.some((row) => row.id === theirStation.id))
    })

    test("walks the pages with the cursor, each item carrying its own set and none of the next record's", async () => {
      const all = (await page(olivia, "?limit=200")).items
      assert.ok(all.length >= 2)
      assert.ok(all.some((row) => row.wasteFractionIds.length > 0), "and at least one of them has a set to carry")
      const first = await page(olivia, "?limit=1")
      assert.deepEqual(first.items, all.slice(0, 1), "one item, with its own set: the surplus row that proved there is a next page is not one of them")
      assert.ok(first.nextCursor !== null)
      const rest = await page(olivia, `?limit=200&cursor=${first.nextCursor}`)
      assert.deepEqual(rest.items, all.slice(1))
      assert.equal(rest.nextCursor, null)
    })

    test("filters by status and by the fraction a station accepts", async () => {
      const takesGlass = await station("ARC-11", { wasteFractionIds: [glass.id, residual.id], status: "seasonal" })
      const takesResidual = await station("ARC-12", { wasteFractionIds: [residual.id] })
      const byStatus = await page(olivia, "?limit=200&status=seasonal")
      assert.ok(byStatus.items.some((row) => row.id === takesGlass.id))
      for (const row of byStatus.items) assert.equal(row.status, "seasonal")
      assert.deepEqual(paths(await refused(await olivia("/unloading-stations?status=open"), 400)), ["status"])

      const glassOnly = (await page(olivia, `?limit=200&wasteFractionId=${glass.id}`)).items.map((row) => row.id)
      assert.ok(glassOnly.includes(takesGlass.id))
      assert.ok(!glassOnly.includes(takesResidual.id), "a station that does not accept the fraction is not listed")
      const residualToo = (await page(olivia, `?limit=200&wasteFractionId=${residual.id}`)).items.map((row) => row.id)
      assert.ok(residualToo.includes(takesGlass.id) && residualToo.includes(takesResidual.id))
      assert.deepEqual((await page(olivia, `?limit=200&wasteFractionId=${testId()}`)).items, [], "a fraction nobody accepts lists nothing")
      assert.deepEqual(paths(await refused(await olivia("/unloading-stations?wasteFractionId=not-an-id"), 400)), ["wasteFractionId"])
    })

    test("is the company's: an account that works in one project reads every station, and one that works in none reads an empty page", async () => {
      const all = (await page(olivia, "?limit=200")).items.map((row) => row.id)
      assert.deepEqual((await page(viewer, "?limit=200")).items.map((row) => row.id), all, "Vera works in Copenhagen Central only and reads every station, since a station serves every project")
      assert.deepEqual(await page(lars, "?limit=200"), { items: [], nextCursor: null }, "Lars works in no project and reads none of this, though his role may view")
    })

    test("refuses a role without resources.depots view, and a caller with no token", async () => {
      assert.match((await refused(await ungranted("/unloading-stations"), 403)).detail ?? "", /view on resources\.depots/)
      assert.equal((await app.request("/unloading-stations")).status, 401)
    })
  })

  describe("GET /unloading-stations/:id", () => {
    test("answers 404 for another company's, for an id nobody minted, and to an account that works in no project; 400 for a path that is not an id", async () => {
      const foreign = await refused(await olivia(`/unloading-stations/${theirStation.id}`), 404)
      assert.match(foreign.detail ?? "", /unloading station/i)
      assert.deepEqual(await one(other, theirStation.id), theirStation, "still there for its own company")
      const mine = await station("ARC-20")
      await refused(await lars(`/unloading-stations/${mine.id}`), 404)
      assert.deepEqual(await one(viewer, mine.id), mine, "and there for an account that works in a project of the company")
      await refused(await olivia(`/unloading-stations/${testId()}`), 404)
      assert.deepEqual(paths(await refused(await olivia("/unloading-stations/not-a-uuid"), 400)), ["id"])
    })
  })

  describe("PATCH /unloading-stations/:id", () => {
    test("changes what the body names, moves the place, leaves the code and the fractions, and moves the stamp", async () => {
      const created = await station("ARC-30", { wasteFractionIds: [residual.id], opensAt: "06:00", closesAt: "22:00" })
      await nextMillisecond()
      const changed = await patch(olivia, created.id, { name: "Amager Bakke", location: glostrup, weighbridge: true, status: "closed", notes: "Closed for the summer" })
      assert.deepEqual([changed.code, changed.name, changed.weighbridge, changed.status, changed.notes], ["ARC-30", "Amager Bakke", true, "closed", "Closed for the summer"])
      assert.deepEqual(changed.location, glostrup, "the place moved")
      assert.deepEqual(changed.wasteFractionIds, [residual.id], "a patch is not how a set changes")
      assert.deepEqual([changed.opensAt, changed.closesAt], ["06:00", "22:00"], "what the patch did not name it did not touch")
      assert.ok(changed.updatedAt > created.updatedAt)
      assert.deepEqual(await one(olivia, created.id), changed)
      const cleared = await patch(olivia, created.id, { opensAt: null, closesAt: null, notes: null })
      assert.deepEqual([cleared.opensAt, cleared.closesAt, cleared.notes], [null, null, null])
    })

    test("holds the patch against the stored row: half a pair is refused in the contracts' words, and the whole pair is taken", async () => {
      const created = await station("ARC-31", { opensAt: "06:00", closesAt: "22:00" })
      const halfOff = await refused(await olivia(`/unloading-stations/${created.id}`, { method: "PATCH", body: { closesAt: null } }), 400)
      assert.deepEqual(halfOff.errors, [{ path: "closesAt", message: BOTH_HOURS_OR_NEITHER }])
      const owned = await refused(await olivia(`/unloading-stations/${created.id}`, { method: "PATCH", body: { ownership: "service-provider" } }), 400)
      assert.deepEqual(owned.errors, [{ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP }])
      const named = await refused(await olivia(`/unloading-stations/${created.id}`, { method: "PATCH", body: { serviceProviderId: a.serviceProviders.nordren.id } }), 400)
      assert.deepEqual(named.errors, [{ path: "serviceProviderId", message: PROVIDER_WITH_PROVIDER_OWNERSHIP }], "an external plant naming a provider of ours stays external")
      const handedOver = await patch(olivia, created.id, { ownership: "service-provider", serviceProviderId: a.serviceProviders.nordren.id })
      assert.deepEqual([handedOver.ownership, handedOver.serviceProviderId], ["service-provider", a.serviceProviders.nordren.id], "both halves together are taken")
      const foreign = await refused(await olivia(`/unloading-stations/${created.id}`, { method: "PATCH", body: { serviceProviderId: b.serviceProviders.nordren.id } }), 400)
      assert.deepEqual(foreign.errors, [{ path: "serviceProviderId", message: "Not a service provider of this company" }])
      assert.equal((await patch(olivia, created.id, { ownership: "company", serviceProviderId: null })).ownership, "company")
    })

    test("refuses clearing the place, the code, the fractions, an empty patch, and a rename onto a name the company uses", async () => {
      const created = await station("ARC-32")
      assert.deepEqual(paths(await refused(await olivia(`/unloading-stations/${created.id}`, { method: "PATCH", body: { location: null } }), 400)), ["location"])
      const code = await refused(await olivia(`/unloading-stations/${created.id}`, { method: "PATCH", body: { code: "ARC-33" } }), 400)
      assert.ok(code.errors?.some((error) => /code/.test(error.message)), JSON.stringify(code.errors))
      const withSet = await refused(await olivia(`/unloading-stations/${created.id}`, { method: "PATCH", body: { wasteFractionIds: [glass.id] } }), 400)
      assert.ok(withSet.errors?.some((error) => /wasteFractionIds/.test(error.message)), "the set is not a field of the patch")
      assert.deepEqual(paths(await refused(await olivia(`/unloading-stations/${created.id}`, { method: "PATCH", body: {} }), 400)), [""])
      await station("ARC-34", { name: "Taken already" })
      const taken = await refused(await olivia(`/unloading-stations/${created.id}`, { method: "PATCH", body: { name: "Taken already" } }), 409)
      assert.equal(taken.detail, 'This company already has an unloading station called "Taken already"')
      assert.deepEqual(await one(olivia, created.id), created, "a refused patch changes nothing")
    })

    test("refuses another company's station and one the account does not reach as 404, and a role that may view but not edit as 403", async () => {
      await refused(await olivia(`/unloading-stations/${theirStation.id}`, { method: "PATCH", body: { name: "Mine now" } }), 404)
      assert.equal((await one(other, theirStation.id)).name, "Station ARC-THEIRS")
      const created = await station("ARC-35")
      await refused(await olivia(`/unloading-stations/${testId()}`, { method: "PATCH", body: { name: "Nobody's" } }), 404)
      assert.match((await refused(await lars(`/unloading-stations/${created.id}`, { method: "PATCH", body: { name: "x" } }), 403)).detail ?? "", /edit on resources\.depots/)
    })
  })

  describe("PUT /unloading-stations/:id/fractions", () => {
    test("replaces the whole set, answers it by id, and moves the station's stamp", async () => {
      const created = await station("ARC-40", { wasteFractionIds: [residual.id] })
      await nextMillisecond()
      const replaced = await put(olivia, created.id, [food.id, glass.id])
      assert.deepEqual(replaced.wasteFractionIds, inReadOrder([glass.id, food.id]), "what the body left out is gone; by id")
      assert.ok(replaced.updatedAt > created.updatedAt, "the set is part of the station on the wire")
      assert.deepEqual(await one(olivia, created.id), replaced)
      await nextMillisecond()
      const emptied = await put(olivia, created.id, [])
      assert.deepEqual(emptied.wasteFractionIds, [], "a station that takes nothing yet")
      assert.ok(emptied.updatedAt > replaced.updatedAt, "emptying the set is a change to the station too")
      assert.deepEqual(await one(olivia, created.id), emptied)
    })

    test("refuses a fraction of another company at the indexed path, and leaves the station as it was, stamp included", async () => {
      const created = await station("ARC-41", { wasteFractionIds: [residual.id] })
      const problem = await refused(
        await olivia(`/unloading-stations/${created.id}/fractions`, { method: "PUT", body: { wasteFractionIds: [glass.id, theirFraction.id] } }),
        400,
      )
      assert.deepEqual(problem.errors, [{ path: "wasteFractionIds.1", message: "Not a waste fraction of this company" }])
      assert.deepEqual(await one(olivia, created.id), created, "a body with one bad entry leaves the record exactly as it was")
    })

    test("refuses the same fraction twice, a missing list and a member the body does not own, at the schema", async () => {
      const created = await station("ARC-42")
      const twice = await refused(await olivia(`/unloading-stations/${created.id}/fractions`, { method: "PUT", body: { wasteFractionIds: [glass.id, glass.id] } }), 400)
      assert.deepEqual(twice.errors, [{ path: "wasteFractionIds", message: EACH_FRACTION_ONCE }])
      assert.deepEqual(paths(await refused(await olivia(`/unloading-stations/${created.id}/fractions`, { method: "PUT", body: {} }), 400)), ["wasteFractionIds"])
      const owned = await refused(await olivia(`/unloading-stations/${created.id}/fractions`, { method: "PUT", body: { wasteFractionIds: [], name: "x" } }), 400)
      assert.ok(owned.errors?.some((error) => /name/.test(error.message)), JSON.stringify(owned.errors))
      assert.deepEqual((await one(olivia, created.id)).wasteFractionIds, [])
    })

    test("answers 404 for another company's station, for an id nobody minted and to an account that works in no project; 403 to a role that may view but not edit", async () => {
      await refused(await olivia(`/unloading-stations/${theirStation.id}/fractions`, { method: "PUT", body: { wasteFractionIds: [] } }), 404)
      assert.deepEqual((await one(other, theirStation.id)).wasteFractionIds, [theirFraction.id], "and it still has its set")
      await refused(await olivia(`/unloading-stations/${testId()}/fractions`, { method: "PUT", body: { wasteFractionIds: [] } }), 404)
      const created = await station("ARC-43", { wasteFractionIds: [residual.id] })
      assert.match((await refused(await lars(`/unloading-stations/${created.id}/fractions`, { method: "PUT", body: { wasteFractionIds: [] } }), 403)).detail ?? "", /edit on resources\.depots/)
      const replaced = await put(viewer, created.id, [glass.id])
      assert.deepEqual(replaced.wasteFractionIds, [glass.id], "an account that works in one project replaces the set of a station that serves every project")
    })
  })
})
