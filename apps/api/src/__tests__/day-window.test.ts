// The window a `from`/`to` pair of days makes over an instant column, read
// through the tickets' list (Issue #109): both days whole on the UTC
// calendar, each end optional.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Page } from "@waste/contracts/pagination"
import { Ticket } from "@waste/contracts/tickets"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { dropTenant, seedTenant, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the ticket history the creates append, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const TicketPage = Page(Ticket)

/** The request's clock, after every instant below, so none of them runs ahead of it. */
const NOW = new Date("2028-03-01T12:00:00.000Z")

describe("a from/to window of days over GET /tickets", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let a: Tenant
  let olivia: Call
  /** One ticket at each edge, by the instant it happened. */
  const at: Record<string, string> = {}

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    const keys = await signingKeys()
    a = await seedTenant(pool)
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    for (const occurredAt of [
      "2026-12-30T23:59:59.999Z",
      "2026-12-31T00:00:00.000Z",
      "2026-12-31T23:59:59.999Z",
      "2027-01-01T00:00:00.000Z",
      "2028-02-29T23:59:59.999Z",
      "2028-03-01T00:00:00.000Z",
    ]) {
      const body = { projectId: a.projects.copenhagen.id, subject: `Happened ${occurredAt}`, description: "A bin was not emptied.", kind: "missed-collection", occurredAt }
      at[occurredAt] = (await created(olivia, "/tickets", await olivia("/tickets", { method: "POST", body }), Ticket)).id
    }
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  /** The instants of the tickets the window lists, in the order made. */
  const listed = async (query: string): Promise<string[]> => {
    const response = await olivia(`/tickets?limit=200${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    const ids = TicketPage.parse(await response.json()).items.map((row) => row.id)
    return Object.keys(at).filter((instant) => ids.includes(at[instant]))
  }

  test("takes the whole of both days: from the first instant of `from` to the last millisecond of `to`, the midnight after it out, across a year's end", async () => {
    assert.deepEqual(await listed("&from=2026-12-31&to=2026-12-31"), ["2026-12-31T00:00:00.000Z", "2026-12-31T23:59:59.999Z"])
    assert.deepEqual(await listed("&from=2026-12-31&to=2027-01-01"), ["2026-12-31T00:00:00.000Z", "2026-12-31T23:59:59.999Z", "2027-01-01T00:00:00.000Z"])
  })

  test("a leap day is a day", async () => {
    assert.deepEqual(await listed("&from=2028-02-29&to=2028-02-29"), ["2028-02-29T23:59:59.999Z"])
  })

  test("takes one end alone: a lower bound with no upper, an upper with no lower, and neither is every ticket", async () => {
    assert.deepEqual(await listed("&from=2027-01-01"), ["2027-01-01T00:00:00.000Z", "2028-02-29T23:59:59.999Z", "2028-03-01T00:00:00.000Z"])
    assert.deepEqual(await listed("&to=2026-12-31"), ["2026-12-30T23:59:59.999Z", "2026-12-31T00:00:00.000Z", "2026-12-31T23:59:59.999Z"])
    assert.deepEqual(await listed(""), Object.keys(at))
  })
})
