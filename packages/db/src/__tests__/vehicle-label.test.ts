import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { sql } from "drizzle-orm"

import { createDb, type Database } from "../client"
import { vehicleLabel, vehicleLabelOf } from "../commands/fleet-fit"
import { databaseUnderTest } from "./database"

const database = databaseUnderTest()

/** A vehicle with a callsign, one without, and one whose callsign is empty text — a value, not an absence. */
const VEHICLES = [
  { registration: "CN 42 018", callsign: "WH-24" },
  { registration: "CN 42 019", callsign: null },
  { registration: "CN 42 020", callsign: "" },
]

describe("a vehicle's label in SQL is vehicleLabel's", { skip: database.skip }, () => {
  let pool: Database
  before(() => {
    pool = createDb(database.appUrl, { max: 1 })
  })
  after(() => pool.close())

  test("the callsign, else the registration, for every vehicle", async () => {
    const rows = await pool.db.execute<{ n: number; label: string }>(sql`
      select t.n, ${vehicleLabelOf({ registration: sql`t.registration`, callsign: sql`t.callsign` })} as label
        from (values ${sql.join(
          VEHICLES.map((vehicle, n) => sql`(${n}::int, ${vehicle.registration}::text, ${vehicle.callsign}::text)`),
          sql`, `,
        )}) as t(n, registration, callsign)
       order by t.n
    `)
    assert.deepEqual(
      rows.map((row) => row.label),
      VEHICLES.map(vehicleLabel),
    )
  })
})
