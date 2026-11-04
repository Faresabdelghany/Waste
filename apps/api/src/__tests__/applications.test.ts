// Applications and their Decisions (M7 of #293): recorded as they arrive and
// numbered by the company, corrected while undecided, moved by the domain's
// four commands, decided — a Decision appended, the latest riding on the
// Application, `application-decided` in the outbox — reopened on an appeal
// and decided again, and listed by what they are about and by the grants in
// force on a day. What an Application names hangs together: the customer a
// party of the property, the subscription the customer's at the place named.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Application, DecisionHistory } from "@waste/contracts/applications"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { product } from "@waste/db/schema/catalogue"
import { customer, property, propertyParty, sharedCollectionPoint } from "@waste/db/schema/customers"
import { outboxEvent } from "@waste/db/schema/execution"
import { withCompany } from "@waste/db/tenant"
import { APPEAL_TEXT_NEEDED, REFUSAL_HAS_NO_PERIOD } from "@waste/domain/registry/applications"
import { and, eq } from "drizzle-orm"

import { createApp } from "../app"
import { ANOTHER_PLACE, NOT_A_PARTY, NOT_THE_CUSTOMERS, RECEIVED_AHEAD } from "../routes/applications"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { TOWN_HALL } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner reads the outbox and sweeps the Decisions, a ledger `wms_api` may not delete. */
const owner = ownerUnderTest()

const NOW = new Date("2026-11-05T10:00:00Z")
const APPEAL = "You may appeal within four weeks by writing to the municipality."

describe("Applications and their Decisions", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let a: Tenant
  let b: Tenant
  let olivia: Call
  let other: Call
  /** The viewer: Applications to read and nothing more. */
  let viewer: Call
  const ids = { anna: testId(), bo: testId(), theirs: testId(), rosenvej: testId(), elmevej: testId(), harborHouse: testId(), point: testId(), product: testId(), agreement: testId(), subscription: testId(), paidByBo: testId(), boPays: testId() }

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const ok = async (response: Response): Promise<Application> => {
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return Application.parse(await response.json())
  }
  const body = (values: Record<string, unknown> = {}) => ({
    projectId: a.projects.copenhagen.id,
    kind: "home-composting",
    channel: "email",
    receivedOn: "2026-11-02",
    customerId: ids.anna,
    propertyId: ids.rosenvej,
    statement: "We compost our food waste in the garden.",
    ...values,
  })
  const make = async (values: Record<string, unknown> = {}) => created(olivia, "/applications", await olivia("/applications", { method: "POST", body: body(values) }), Application)
  const send = (id: string, command: string, payload?: unknown) => olivia(`/applications/${id}/${command}`, { method: "POST", ...(payload === undefined ? {} : { body: payload }) })

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    const keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "customers.applications", actions: ["view"] }])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    const copenhagen = { companyId: a.companyId, projectId: a.projects.copenhagen.id }
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(customer).values([
        { id: ids.anna, companyId: a.companyId, kind: "person", name: "Anna Andersen", status: "active" },
        { id: ids.bo, companyId: a.companyId, kind: "person", name: "Bo Berg", status: "active" },
      ])
      await tx.insert(property).values([
        { id: ids.rosenvej, ...copenhagen, name: "Rosenvej 4", address: "Rosenvej 4, 2100 København Ø", kind: "residential", location: TOWN_HALL, status: "active" },
        { id: ids.elmevej, ...copenhagen, name: "Elmevej 9", address: "Elmevej 9, 2100 København Ø", kind: "residential", location: TOWN_HALL, status: "active" },
        { id: ids.harborHouse, companyId: a.companyId, projectId: a.projects.harbor.id, name: "Kaj 2", address: "Kaj 2, 8000 Aarhus", kind: "commercial", location: TOWN_HALL, status: "active" },
      ])
      await tx.insert(sharedCollectionPoint).values({ id: ids.point, ...copenhagen, name: "Rosenvej point", kind: "surface", address: "Rosenvej 2, 2100 København Ø", location: TOWN_HALL, operatingModel: "municipal", accessMode: "open", billingMode: "municipal", status: "open" })
      await tx.insert(product).values({ id: ids.product, ...copenhagen, name: "Food waste collection", kind: "additional-service", status: "active", unit: "job" })
      await tx.insert(agreement).values({ id: ids.agreement, ...copenhagen, validFrom: "2026-01-01", number: "AGR-M7", customerId: ids.anna, payerCustomerId: ids.anna, status: "active", billingCadence: "monthly", currency: "DKK" })
      await tx.insert(propertyParty).values([
        { id: testId(), ...copenhagen, propertyId: ids.rosenvej, customerId: ids.anna, role: "owner", validFrom: "2026-01-01" },
        { id: testId(), ...copenhagen, propertyId: ids.elmevej, customerId: ids.anna, role: "tenant", validFrom: "2026-01-01" },
      ])
      // Anna's at Elmevej, which Bo pays for.
      await tx.insert(agreement).values({ id: ids.paidByBo, ...copenhagen, validFrom: "2026-01-01", number: "AGR-M7B", customerId: ids.anna, payerCustomerId: ids.bo, status: "active", billingCadence: "monthly", currency: "DKK" })
      await tx.insert(subscription).values([
        { id: ids.subscription, ...copenhagen, validFrom: "2026-01-01", agreementId: ids.agreement, productId: ids.product, propertyId: ids.rosenvej },
        { id: ids.boPays, ...copenhagen, validFrom: "2026-01-01", agreementId: ids.paidByBo, productId: ids.product, propertyId: ids.elmevej },
      ])
    })
    await withCompany(pool.db, b.companyId, async (tx: Tx) => {
      await tx.insert(customer).values({ id: ids.theirs, companyId: b.companyId, kind: "person", name: "Not ours", status: "active" })
    })
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  describe("a create", () => {
    test("records the Application received, numbered by the company, its subject and statement as given", async () => {
      const first = await make({ subscriptionId: ids.subscription })
      assert.equal(first.status, "received")
      assert.equal(first.decision, null)
      assert.deepEqual([first.kind, first.channel, first.receivedOn, first.customerId, first.propertyId, first.sharedCollectionPointId, first.subscriptionId], ["home-composting", "email", "2026-11-02", ids.anna, ids.rosenvej, null, ids.subscription])
      const second = await make({ kind: "pause", propertyId: null, sharedCollectionPointId: ids.point })
      assert.equal(second.number, first.number + 1, "the company's next")
    })

    test("refuses one place too many, a place, subscription or customer not the project's, and a project not the caller's", async () => {
      assert.deepEqual((await refused(await olivia("/applications", { method: "POST", body: body({ sharedCollectionPointId: ids.point }) }), 400)).errors?.map((error) => error.path), ["sharedCollectionPointId"])
      assert.deepEqual((await refused(await olivia("/applications", { method: "POST", body: body({ propertyId: ids.harborHouse }) }), 400)).errors?.map((error) => error.path), ["propertyId"])
      assert.deepEqual((await refused(await olivia("/applications", { method: "POST", body: body({ projectId: a.projects.harbor.id, propertyId: null, subscriptionId: ids.subscription }) }), 400)).errors?.map((error) => error.path), ["subscriptionId"])
      assert.deepEqual((await refused(await olivia("/applications", { method: "POST", body: body({ customerId: ids.theirs }) }), 400)).errors?.map((error) => error.path), ["customerId"])
      await refused(await olivia("/applications", { method: "POST", body: body({ projectId: b.projects.copenhagen.id, propertyId: null }) }), 400)
    })

    test("holds what it names together: the customer a party of the property, the subscription theirs at the place named", async () => {
      const at = async (values: Record<string, unknown>) => (await refused(await olivia("/applications", { method: "POST", body: body(values) }), 400)).errors?.map((error) => [error.path, error.message])
      assert.deepEqual(await at({ customerId: ids.bo }), [["propertyId", NOT_A_PARTY]])
      assert.deepEqual(await at({ customerId: ids.bo, propertyId: null, subscriptionId: ids.subscription }), [["subscriptionId", NOT_THE_CUSTOMERS]])
      assert.deepEqual(await at({ propertyId: ids.elmevej, subscriptionId: ids.subscription }), [["subscriptionId", ANOTHER_PLACE]])
      assert.deepEqual(await at({ propertyId: null, sharedCollectionPointId: ids.point, subscriptionId: ids.subscription }), [["subscriptionId", ANOTHER_PLACE]])
      assert.equal((await make({ customerId: ids.bo, propertyId: null, subscriptionId: ids.boPays })).subscriptionId, ids.boPays, "the payer's own subscription")
      assert.equal((await make({ customerId: ids.bo, propertyId: null, sharedCollectionPointId: ids.point })).sharedCollectionPointId, ids.point, "a shared point has no parties")
    })

    test("is received no later than today on the project's clock", async () => {
      assert.deepEqual((await refused(await olivia("/applications", { method: "POST", body: body({ receivedOn: "2026-11-06" }) }), 400)).errors?.map((error) => [error.path, error.message]), [["receivedOn", RECEIVED_AHEAD]])
      assert.equal((await make({ receivedOn: "2026-11-05" })).receivedOn, "2026-11-05")
    })

    test("is the create grant's: a role that only views Applications reads them and records none", async () => {
      await refused(await viewer("/applications", { method: "POST", body: body() }), 403)
      assert.equal((await viewer("/applications")).status, 200)
    })
  })

  describe("the moves", () => {
    test("an undecided Application is corrected, one place at most across the fields; a decided one is not", async () => {
      const made = await make()
      const corrected = await ok(await olivia(`/applications/${made.id}`, { method: "PATCH", body: { kind: "longer-interval", statement: "Every other week is enough for us." } }))
      assert.deepEqual([corrected.kind, corrected.statement], ["longer-interval", "Every other week is enough for us."])
      assert.deepEqual((await refused(await olivia(`/applications/${made.id}`, { method: "PATCH", body: { sharedCollectionPointId: ids.point } }), 400)).errors?.map((error) => error.path), ["sharedCollectionPointId"])
      assert.deepEqual((await refused(await olivia(`/applications/${made.id}`, { method: "PATCH", body: { receivedOn: "2026-11-06" } }), 400)).errors?.map((error) => [error.path, error.message]), [["receivedOn", RECEIVED_AHEAD]])
      await ok(await send(made.id, "decide", { outcome: "granted", validFrom: "2026-11-09" }))
      const decided = await refused(await olivia(`/applications/${made.id}`, { method: "PATCH", body: { statement: "Too late." } }), 409)
      assert.equal(decided.detail, `Application ${made.number} is decided; a correction takes one received or in review`)
    })

    test("a correction keeps what the Application names together, told at the field it moves", async () => {
      const made = await make({ subscriptionId: ids.subscription })
      const patched = async (patch: Record<string, unknown>) => (await refused(await olivia(`/applications/${made.id}`, { method: "PATCH", body: patch }), 400)).errors?.map((error) => [error.path, error.message])
      assert.deepEqual(await patched({ propertyId: ids.elmevej }), [["propertyId", ANOTHER_PLACE]], "a place moved under the subscription it keeps")
      assert.deepEqual(await patched({ subscriptionId: ids.boPays }), [["subscriptionId", ANOTHER_PLACE]])
      const moved = await ok(await olivia(`/applications/${made.id}`, { method: "PATCH", body: { propertyId: ids.elmevej, subscriptionId: ids.boPays } }))
      assert.deepEqual([moved.propertyId, moved.subscriptionId], [ids.elmevej, ids.boPays], "Anna's, though Bo pays")
    })

    test("review takes a received one into review, once; withdraw ends one undecided, which moves no more", async () => {
      const made = await make()
      assert.equal((await ok(await send(made.id, "review"))).status, "in-review")
      assert.equal((await refused(await send(made.id, "review"), 409)).detail, `Application ${made.number} is in review; review takes one received`)
      assert.equal((await ok(await send(made.id, "withdraw"))).status, "withdrawn")
      assert.equal((await refused(await send(made.id, "reopen"), 409)).detail, `Application ${made.number} is withdrawn; reopen takes one decided`)
      assert.equal((await refused(await send(made.id, "decide", { outcome: "granted", validFrom: "2026-11-09" }), 409)).detail, `Application ${made.number} is withdrawn; decide takes one received or in review`)
    })

    test("a decision appends, rides on the Application, names the caller, and goes to the outbox as the Application now stands", async () => {
      const made = await make()
      const decided = await ok(await send(made.id, "decide", { outcome: "granted", validFrom: "2026-11-09", conditions: "The compost bin stays covered." }))
      assert.equal(decided.status, "decided")
      assert.deepEqual(
        [decided.decision?.outcome, decided.decision?.validFrom, decided.decision?.validTo, decided.decision?.conditions, decided.decision?.appealText, decided.decision?.decidedBy, decided.decision?.decidedAt],
        ["granted", "2026-11-09", null, "The compost bin stays covered.", null, a.users.olivia.id, NOW.toISOString()],
      )
      const [event] = await ownerPool.db.select().from(outboxEvent).where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, made.id)))
      assert.deepEqual([event.kind, event.aggregateKind, event.projectId, event.occurredAt.toISOString()], ["application-decided", "application", a.projects.copenhagen.id, NOW.toISOString()])
      assert.deepEqual(event.payload, decided)
      assert.equal((await refused(await send(made.id, "decide", { outcome: "refused", appealText: APPEAL }), 409)).detail, `Application ${made.number} is decided; decide takes one received or in review`)
    })

    test("a decision's period and appeal text are the domain's rules, at their fields", async () => {
      const made = await make()
      assert.deepEqual((await refused(await send(made.id, "decide", { outcome: "refused" }), 400)).errors?.map((error) => [error.path, error.message]), [["appealText", APPEAL_TEXT_NEEDED]])
      assert.deepEqual((await refused(await send(made.id, "decide", { outcome: "refused", validFrom: "2026-11-09", appealText: APPEAL }), 400)).errors?.map((error) => [error.path, error.message]), [["validFrom", REFUSAL_HAS_NO_PERIOD]])
      assert.equal((await olivia(`/applications/${made.id}`)).status, 200)
      assert.equal(Application.parse(await (await olivia(`/applications/${made.id}`)).json()).status, "received", "a refused body moves nothing")
    })

    test("an appeal reopens a decided Application, its decision riding on it until the next one appends", async () => {
      const made = await make({ kind: "fee-correction", propertyId: null })
      const first = await ok(await send(made.id, "decide", { outcome: "refused", conditions: "The fee was right.", appealText: APPEAL }))
      const reopened = await ok(await send(made.id, "reopen"))
      assert.equal(reopened.status, "in-review")
      assert.equal(reopened.decision?.id, first.decision?.id, "the first decision stands until the next")
      const second = await ok(await send(made.id, "decide", { outcome: "partly-granted", validFrom: "2026-12-01", validTo: "2027-01-01", conditions: "Half the fee is refunded.", appealText: APPEAL }))
      assert.notEqual(second.decision?.id, first.decision?.id)
      const history = DecisionHistory.parse(await (await olivia(`/applications/${made.id}/decisions`)).json())
      assert.deepEqual(history.items.map((decision) => decision.outcome), ["refused", "partly-granted"])
    })

    test("withdrawing an appeal returns the Application to its decision, never to withdrawn", async () => {
      const made = await make()
      const decided = await ok(await send(made.id, "decide", { outcome: "refused", appealText: APPEAL }))
      await ok(await send(made.id, "reopen"))
      const withdrawn = await ok(await send(made.id, "withdraw"))
      assert.deepEqual([withdrawn.status, withdrawn.decision?.id], ["decided", decided.decision?.id])
    })
  })

  describe("the list", () => {
    test("narrows by customer, kind and status, and to the grants in force on a day, expired and upcoming left out", async () => {
      const winter = await make({ kind: "exemption" })
      await ok(await send(winter.id, "decide", { outcome: "granted", validFrom: "2026-11-09", validTo: "2026-12-01", appealText: null }))
      const page = (query: string) => olivia(`/applications?${query}`).then(async (response) => Page(Application).parse(await response.json()).items.map((item) => item.id))
      assert.ok((await page(`customerId=${ids.anna}&kind=exemption`)).includes(winter.id))
      assert.ok(!(await page("kind=pause")).includes(winter.id))
      assert.ok((await page("status=decided")).includes(winter.id))
      assert.ok((await page("inForceOn=2026-11-20")).includes(winter.id), "in force")
      assert.ok(!(await page("inForceOn=2026-12-01")).includes(winter.id), "expired on its first day out")
      assert.ok(!(await page("inForceOn=2026-11-08")).includes(winter.id), "upcoming")
      await ok(await send(winter.id, "reopen"))
      assert.ok((await page("inForceOn=2026-11-20")).includes(winter.id), "a grant stands while its appeal is reviewed")
      await refused(await olivia("/applications?status=expired"), 400)
    })

    test("is the caller's projects': another company reads none of them and finds none by id", async () => {
      const made = await make()
      assert.deepEqual(Page(Application).parse(await (await other("/applications")).json()).items, [])
      await refused(await other(`/applications/${made.id}`), 404)
      await refused(await other(`/applications/${made.id}/review`, { method: "POST" }), 404)
    })
  })
})
