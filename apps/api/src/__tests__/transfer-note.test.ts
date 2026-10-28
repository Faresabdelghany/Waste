// An unload's waste transfer note (O18 of #290) through the API: the PDF the
// office reads or downloads from an unload's details, made of the unload's
// rows, the fraction's waste code and hazardous flag included; its ETag; the
// fences every unload read carries; and the two unloads that have none, a
// refused load and a corrected one. What the page says is read back from the
// file, its content stream inflated and its WinAnsi hex decoded.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"
import { inflateSync } from "node:zlib"

import { WasteFraction } from "@waste/contracts/catalogue"
import { Unload } from "@waste/contracts/unloads"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, seedExecution, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the unloads this suite appends, which `wms_api` may not delete. */
const owner = ownerUnderTest()

const AFTERNOON = new Date("2026-10-05T13:00:00Z")

/** The page's text, in drawing order. */
function textOf(bytes: Uint8Array): string[] {
  const file = Buffer.from(bytes)
  const texts: string[] = []
  for (const match of file.toString("latin1").matchAll(/\/Filter \/FlateDecode\n\/Length (\d+)\n>>\nstream\n/g)) {
    const from = (match.index ?? 0) + match[0].length
    const content = inflateSync(Uint8Array.from(file.subarray(from, from + Number(match[1])))).toString("latin1")
    texts.push(...[...content.matchAll(/<([0-9A-Fa-f]*)> Tj/g)].map(([, hex]) => Buffer.from(hex, "hex").toString("latin1")))
  }
  return texts
}

describe("an unload's transfer note", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let olivia: Call
  let other: Call

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => AFTERNOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const record = async (values: Record<string, unknown> = {}): Promise<Unload> => {
    const body = { unloadingStationId: fleet.stations.amager.id, wasteFractionId: ex.fractions.residual.id, netKg: 8540, grossKg: 18_540, tareKg: 10_000, weighbridgeTicket: "WB-2026-3901", occurredAt: at(ex.day, "12:40").toISOString(), ...values }
    return await created(olivia, `/routes/${ex.routes.completed.id}/unloads`, await olivia(`/routes/${ex.routes.completed.id}/unloads`, { method: "POST", body }), Unload, "/unloads")
  }

  test("is the unload's PDF: the company, the vehicle and driver, the station, the waste with its code and weights, and the day and time on the project's clock", async () => {
    const coded = WasteFraction.parse(await (await olivia(`/waste-fractions/${ex.fractions.residual.id}`, { method: "PATCH", body: { wasteCode: "200301" } })).json())
    assert.equal(coded.hazardous, false)
    const unload = await record()
    const response = await olivia(`/unloads/${unload.id}/transfer-note`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get("content-type"), "application/pdf")
    assert.equal(response.headers.get("content-disposition"), `inline; filename="transfer-note-${unload.id}.pdf"`)
    const bytes = new Uint8Array(await response.arrayBuffer())
    assert.match(Buffer.from(bytes).toString("latin1"), /^%PDF-1\.7/)
    const page = textOf(bytes)
    for (const said of ["Følgeseddel for affald", unload.id, `${a.name} A/S`, "CN 42 018", "Mads Jensen", ex.routes.completed.label, "ARC Amager Bakke", "ARC-AMAGER", "20 03 01", "Nej", "8.540 kg", "18.540 kg", "10.000 kg", "WB-2026-3901", "12:40 (Europe/Copenhagen)", "Copenhagen Central"]) {
      assert.ok(page.includes(said), `the note says ${said}: ${JSON.stringify(page)}`)
    }
    assert.ok(!page.includes("FARLIGT AFFALD"))

    const etag = response.headers.get("etag")
    assert.match(etag ?? "", /^"[0-9a-f]{64}"$/)
    const again = await olivia(`/unloads/${unload.id}/transfer-note`, { headers: { "If-None-Match": etag ?? "" } })
    assert.equal(again.status, 304, "nothing it is made of has moved")
  })

  test("says a hazardous fraction is hazardous under its starred code, with the banner, and moves its ETag when the fraction does", async () => {
    const unload = await record({ occurredAt: at(ex.day, "12:50").toISOString() })
    const before = (await olivia(`/unloads/${unload.id}/transfer-note`)).headers.get("etag")
    const starred = WasteFraction.parse(await (await olivia(`/waste-fractions/${ex.fractions.residual.id}`, { method: "PATCH", body: { wasteCode: "200133*" } })).json())
    assert.equal(starred.hazardous, true)
    const response = await olivia(`/unloads/${unload.id}/transfer-note`, { headers: { "If-None-Match": before ?? "" } })
    assert.equal(response.status, 200, "the fraction moved, so the note did")
    const page = textOf(new Uint8Array(await response.arrayBuffer()))
    for (const said of ["FARLIGT AFFALD", "20 01 33*", "Ja"]) assert.ok(page.includes(said), `the note says ${said}`)
    await olivia(`/waste-fractions/${ex.fractions.residual.id}`, { method: "PATCH", body: { wasteCode: "200301", hazardous: false } })
  })

  test("is refused for a load the station turned away and for an unload a review corrected, each saying why", async () => {
    const turnedAway = await record({ occurredAt: at(ex.day, "13:00").toISOString(), refusal: { reason: "contamination" } })
    const refused = await olivia(`/unloads/${turnedAway.id}/transfer-note`)
    assert.equal(refused.status, 409)
    assert.equal((await readProblem(refused)).detail, `Unload ${turnedAway.id} was refused by the station: a load turned away was not transferred and has no transfer note`)

    const wrong = await record({ occurredAt: at(ex.day, "13:10").toISOString() })
    const correction = await olivia(`/unloads/${wrong.id}/correct`, { method: "POST", body: { netKg: 8000, note: "Ticket misread" } })
    assert.equal(correction.status, 201, JSON.stringify(await correction.clone().json()))
    const correctionId = ((await correction.json()) as { correctionUnloadId: string }).correctionUnloadId
    const corrected = await olivia(`/unloads/${wrong.id}/transfer-note`)
    assert.equal(corrected.status, 409)
    assert.equal((await readProblem(corrected)).detail, `This unload was corrected by unload ${correctionId}; its transfer note is that one's`)
    const its = await olivia(`/unloads/${correctionId}/transfer-note`)
    assert.equal(its.status, 200)
    assert.ok(textOf(new Uint8Array(await its.arrayBuffer())).includes("8.000 kg"), "the correction's note carries the corrected weight")
  })

  test("is another company's unload that does not exist here", async () => {
    const unload = await record({ occurredAt: at(ex.day, "13:20").toISOString() })
    assert.equal((await other(`/unloads/${unload.id}/transfer-note`)).status, 404)
  })
})
