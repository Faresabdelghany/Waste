// The address → zone read (O29 of #290, row 1.13): a property's zones, and a
// point's before there is a property. A zone is a planning area whose
// boundary in force on the day contains the place; two may overlap, a version
// that has ended holds nothing, and the day defaults to today on the
// project's clock, which is the property's project's.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Property } from "@waste/contracts/customers"
import type { Polygon } from "@waste/contracts/geojson"
import { PlanningArea, PlanningAreasAt } from "@waste/contracts/planning-areas"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()

const JANUARY = "2026-01-01"
const JULY = "2026-07-01"
const OCTOBER = "2026-10-01"

/** The API's clock in these tests: mid-May in Copenhagen. */
const MAY = new Date("2026-05-15T10:00:00Z")
/** Half past midnight on 1 July in Copenhagen, still 30 June in UTC: the project's day is July's. */
const JULY_IN_COPENHAGEN = new Date("2026-06-30T22:30:00Z")

const square = (west: number, south: number, east: number, north: number): Polygon => ({
  type: "Polygon",
  coordinates: [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ],
})
/** Central Copenhagen. */
const CITY = square(12.5, 55.65, 12.65, 55.75)
/** A district inside it. */
const DISTRICT = square(12.55, 55.68, 12.6, 55.72)
/** Aarhus: holds none of the places below. */
const ELSEWHERE = square(10.1, 56.1, 10.3, 56.2)

/** Inside the district, and so inside the city. */
const IN_THE_DISTRICT = { type: "Point" as const, coordinates: [12.58, 55.7] as [number, number] }
/** Inside the city, outside the district. */
const IN_THE_CITY = { type: "Point" as const, coordinates: [12.52, 55.66] as [number, number] }

describe("the address → zone read", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let olivia: Call
  /** Olivia on the clock that has just turned July in Copenhagen. */
  let oliviaInJuly: Call
  /** Granted `view` on `customers.properties` and nothing on `configure.areas`. */
  let viewer: Call
  let other: Call

  let cityZone: PlanningArea
  let districtZone: PlanningArea
  let routeArea: PlanningArea
  let inTheDistrict: Property
  let inTheCity: Property
  let notPlaced: Property
  let theirProperty: Property

  type Schema<T> = { parse: (value: unknown) => T }
  const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body: values }), schema)
  const area = (call: Call, projectId: string, code: string, purpose: string, boundary: Polygon, validTo: string | null = null) =>
    create(call, "/planning-areas", { projectId, code, name: `Area ${code}`, purpose, boundary: { boundary, validFrom: JANUARY, ...(validTo === null ? {} : { validTo }) } }, PlanningArea)
  const property = (call: Call, projectId: string, name: string, location?: typeof IN_THE_CITY) =>
    create(call, "/properties", { projectId, name, address: `${name}, 1000 København`, kind: "residential", ...(location === undefined ? {} : { location }) }, Property)
  const read = async (call: Call, path: string): Promise<PlanningAreasAt> => {
    const response = await call(path)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return PlanningAreasAt.parse(await response.json())
  }
  const codes = (answer: PlanningAreasAt) => answer.items.map((item) => item.code)
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return readProblem(response)
  }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "customers.properties", actions: ["view"] }])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => MAY })
    const july = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => JULY_IN_COPENHAGEN })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    oliviaInJuly = callingAs(july, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)

    const copenhagen = a.projects.copenhagen.id
    cityZone = await area(olivia, copenhagen, "Z-CITY", "notification", CITY)
    districtZone = await area(olivia, copenhagen, "Z-DISTRICT", "notification", DISTRICT, JULY)
    routeArea = await area(olivia, copenhagen, "R-CITY", "route-planning", CITY)
    await area(olivia, copenhagen, "Z-AARHUS", "notification", ELSEWHERE)
    // Another project's zone over the same streets, and another company's: neither is Copenhagen Central's.
    await area(olivia, a.projects.harbor.id, "Z-HARBOR", "notification", CITY)
    await area(other, b.projects.copenhagen.id, "Z-THEIRS", "notification", CITY)

    inTheDistrict = await property(olivia, copenhagen, "Parkvej 18", IN_THE_DISTRICT)
    inTheCity = await property(olivia, copenhagen, "Strandvejen 4", IN_THE_CITY)
    notPlaced = await property(olivia, copenhagen, "Havnegade 9")
    theirProperty = await property(other, b.projects.copenhagen.id, "Havnegade 2", IN_THE_DISTRICT)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  describe("GET /properties/:id/zones", () => {
    test("answers the project's citizen zones holding the property today, in code order, two where two overlap", async () => {
      const answer = await read(olivia, `/properties/${inTheDistrict.id}/zones`)
      assert.deepEqual([answer.on, answer.purpose], ["2026-05-15", "notification"], "today on the project's clock, and the citizens' zones")
      assert.deepEqual(codes(answer), ["Z-CITY", "Z-DISTRICT"], "the city and the district, not Aarhus, not the route-planning area, not another project's or company's")
      assert.deepEqual(answer.items[1], districtZone, "the area as GET /planning-areas/{id} answers it")
      assert.deepEqual(codes(await read(olivia, `/properties/${inTheCity.id}/zones`)), ["Z-CITY"])
    })

    test("reads the boundary in force on the day asked: a version that has ended holds nothing", async () => {
      assert.deepEqual(codes(await read(olivia, `/properties/${inTheDistrict.id}/zones?on=${OCTOBER}`)), ["Z-CITY"])
      assert.deepEqual(codes(await read(olivia, `/properties/${inTheDistrict.id}/zones?on=2025-12-31`)), [], "before any boundary began")
    })

    test("today is the project's day, not UTC's", async () => {
      const answer = await read(oliviaInJuly, `/properties/${inTheDistrict.id}/zones`)
      assert.equal(answer.on, JULY)
      assert.deepEqual(codes(answer), ["Z-CITY"], "the district's boundary ends on 1 July, which has begun in Copenhagen")
    })

    test("another purpose asks the same of that purpose's areas", async () => {
      const answer = await read(olivia, `/properties/${inTheDistrict.id}/zones?purpose=route-planning`)
      assert.deepEqual([answer.purpose, codes(answer)], ["route-planning", ["R-CITY"]])
      assert.deepEqual(answer.items[0], routeArea)
    })

    test("a property with no point lies in no zone", async () => {
      assert.deepEqual((await read(olivia, `/properties/${notPlaced.id}/zones`)).items, [])
    })

    test("needs view on the properties, not on the areas", async () => {
      assert.deepEqual(codes(await read(viewer, `/properties/${inTheDistrict.id}/zones`)), ["Z-CITY", "Z-DISTRICT"])
    })

    test("refuses another company's property as absent, and a day or purpose it cannot read", async () => {
      await refused(await olivia(`/properties/${theirProperty.id}/zones`), 404)
      await refused(await olivia(`/properties/${inTheDistrict.id}/zones?on=2026-02-30`), 400)
      await refused(await olivia(`/properties/${inTheDistrict.id}/zones?purpose=billing`), 400)
    })
  })

  describe("GET /planning-areas/containing", () => {
    const at = (point: { coordinates: [number, number] }, rest = "") => `/planning-areas/containing?projectId=${a.projects.copenhagen.id}&lng=${point.coordinates[0]}&lat=${point.coordinates[1]}${rest}`

    test("answers the same for a point that is no property yet", async () => {
      const answer = await read(olivia, at(IN_THE_DISTRICT))
      assert.deepEqual([answer.on, codes(answer)], ["2026-05-15", ["Z-CITY", "Z-DISTRICT"]])
      assert.deepEqual(answer.items[0], cityZone)
      assert.deepEqual(codes(await read(olivia, at(IN_THE_DISTRICT, `&on=${OCTOBER}`))), ["Z-CITY"])
      assert.deepEqual(codes(await read(olivia, at({ coordinates: [11, 55] }))), [], "a point no zone holds")
    })

    test("is the project's alone", async () => {
      const harbor = `/planning-areas/containing?projectId=${a.projects.harbor.id}&lng=12.58&lat=55.7`
      assert.deepEqual(codes(await read(olivia, harbor)), ["Z-HARBOR"])
      await refused(await other(at(IN_THE_DISTRICT)), 400)
    })

    test("refuses a point it cannot read, and a caller without view on the areas", async () => {
      await refused(await olivia(`/planning-areas/containing?projectId=${a.projects.copenhagen.id}&lng=1e1&lat=55.7`), 400)
      await refused(await olivia(`/planning-areas/containing?projectId=${a.projects.copenhagen.id}&lng=200&lat=55.7`), 400)
      await refused(await olivia(`/planning-areas/containing?projectId=${a.projects.copenhagen.id}&lat=55.7`), 400)
      await refused(await olivia("/planning-areas/containing?lng=12.58&lat=55.7"), 400)
      await refused(await viewer(at(IN_THE_DISTRICT)), 403)
    })
  })
})
