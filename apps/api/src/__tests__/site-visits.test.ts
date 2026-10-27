// Recycling-centre visits through the API (#393, M4 of #293): the register of
// plates and cards, a project's Visit Rule, the attendant's check-in with the
// identification order and the charge it reads — the household's free visit,
// the ladder's steps, free fractions, a business's per-visit product and its
// annual access — a void, the likely trades, and the Site attendant's reach.
// Skipped with the reason when `DATABASE_URL` or `DATABASE_ADMIN_URL` is
// unset, failed under `REQUIRE_DATABASE`.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { AccessCredential, FrequentVisitors, ONE_HOLDER, SiteVisit, SiteVisitCheckInAnswer } from "@waste/contracts/site-visits"
import { VisitRule } from "@waste/contracts/visit-rules"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { NOT_A_CENTRE, NOT_TAKEN_HERE } from "@waste/db/commands/site-visits"
import { subscription } from "@waste/db/schema/agreements"
import { product, wasteFraction } from "@waste/db/schema/catalogue"
import { outboxEvent } from "@waste/db/schema/execution"
import { priceListRow } from "@waste/db/schema/finance"
import { withCompany } from "@waste/db/tenant"
import { SYSTEM_ROLES } from "@waste/domain/access/system-roles"
import { and, asc, eq, sql } from "drizzle-orm"

import { createApp } from "../app"
import { ALREADY_BLOCKED, NOT_THE_CUSTOMERS_AGREEMENT } from "../routes/access-credentials"
import { visitRulesChargeAt } from "../routes/products"
import { ALREADY_VOIDED } from "../routes/site-visits"
import { ACCESS_SOLD_BY_THE_MONTH, SOLD_PER_VISIT } from "../routes/visit-rules"
import { seedBilling, type BillingFixtures } from "./billing-fixtures"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, type ExecutionFixtures } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const owner = ownerUnderTest()

const NOW = new Date("2026-10-12T12:00:00.000Z")
const at = (day: string, time = "10:00") => `${day}T${time}:00.000Z`

describe("recycling-centre visits (M4 of #293)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let ex: ExecutionFixtures
  let fx: BillingFixtures
  let olivia: Call
  let attendant: Call
  let copenhagen: string
  let site: string
  let rule: VisitRule
  /** Two steps sold per visit, a business's visit and its annual access. */
  const visit70 = testId()
  const visit620 = testId()
  const businessVisit = testId()
  const annualAccess = testId()
  /** A fraction the site takes and the rule leaves free. */
  const garden = testId()

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    copenhagen = a.projects.copenhagen.id
    ex = await seedExecution(pool, a, await seedFleet(pool, a, await seedPlanning(pool, a)))
    fx = await seedBilling(pool, a, ex)
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(wasteFraction).values({ id: garden, companyId: a.companyId, key: "garden", name: "Garden waste" })
      const sold = (id: string, name: string, unit: "visit" | "month") => ({ id, companyId: a.companyId, projectId: copenhagen, name, kind: "additional-service", status: "active", unit, vatPercent: 25 })
      await tx.insert(product).values([sold(visit70, "Visit 70", "visit"), sold(visit620, "Visit 620", "visit"), sold(businessVisit, "Business visit", "visit"), sold(annualAccess, "Annual access", "month")])
      const row = (productId: string, unitPriceMinor: number) => ({ id: testId(), companyId: a.companyId, projectId: copenhagen, priceListId: fx.priceLists.default.id, productId, unitPriceMinor, validFrom: "2026-01-01" })
      await tx.insert(priceListRow).values([row(visit70, 7_000), row(visit620, 62_000), row(businessVisit, 15_000)])
    })
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    const charter = SYSTEM_ROLES.find((role) => role.key === "site-attendant")
    assert.ok(charter)
    await grantRole(pool, a.companyId, a.roles.viewer.id, charter.grants)
    attendant = callingAs(app, keys, a.users.viewer, a.companyId)

    const point = await olivia("/drop-off-points", {
      method: "POST",
      body: {
        projectId: copenhagen,
        code: "GS-NORD",
        name: "Nordhavn Recycling Centre",
        kind: "recycling-centre",
        address: "Kraftværksvej 31, 2300 København S",
        location: { type: "Point", coordinates: [12.6105, 55.6521] },
        status: "active",
        wasteFractionIds: [ex.fractions.residual.id, garden],
      },
    })
    assert.equal(point.status, 201, JSON.stringify(await point.clone().json()))
    site = ((await point.json()) as { id: string }).id
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const expect = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return response
  }
  const refused = async (response: Response, status: number) => readProblem(await expect(response, status))
  const register = async (body: Record<string, unknown>): Promise<AccessCredential> =>
    AccessCredential.parse(await (await expect(await olivia("/access-credentials", { method: "POST", body: { projectId: copenhagen, validFrom: "2026-01-01", ...body } }), 201)).json())
  const checkIn = async (body: Record<string, unknown>, call: Call = olivia): Promise<SiteVisitCheckInAnswer> =>
    SiteVisitCheckInAnswer.parse(await (await expect(await call("/site-visits", { method: "POST", body: { siteId: site, ...body } }), 201)).json())

  test("a Visit Rule holds its products to their places: steps and a business's visit sold per visit, annual access by the month, one rule in force at a time", async () => {
    const body = { projectId: copenhagen, validFrom: "2026-01-01", freeVisits: 1, ladder: [visit70, visit620], freeFractionIds: [garden], businessVisitProductId: businessVisit, annualAccessProductId: annualAccess, tradeThreshold: 3, tradeWindowDays: 30 }
    assert.deepEqual((await refused(await olivia("/visit-rules", { method: "POST", body: { ...body, ladder: [fx.products.bulky.id] } }), 400)).errors, [{ path: "ladder.0", message: SOLD_PER_VISIT }])
    assert.deepEqual((await refused(await olivia("/visit-rules", { method: "POST", body: { ...body, annualAccessProductId: visit70 } }), 400)).errors, [{ path: "annualAccessProductId", message: ACCESS_SOLD_BY_THE_MONTH }])
    rule = VisitRule.parse(await (await expect(await olivia("/visit-rules", { method: "POST", body }), 201)).json())
    assert.deepEqual(rule.ladder, [visit70, visit620])
    assert.deepEqual(rule.freeFractionIds, [garden])
    assert.equal((await refused(await olivia("/visit-rules", { method: "POST", body: { ...body, validFrom: "2026-06-01" } }), 409)).detail?.startsWith("A visit rule is already in force"), true)

    const patched = VisitRule.parse(await (await expect(await olivia(`/visit-rules/${rule.id}`, { method: "PATCH", body: { ladder: [visit70, visit620, visit620] } }), 200)).json())
    assert.deepEqual(patched.ladder, [visit70, visit620, visit620], "replaced whole")
    assert.deepEqual(patched.freeFractionIds, [garden], "the free fractions kept")
    rule = VisitRule.parse(await (await expect(await olivia(`/visit-rules/${rule.id}`, { method: "PATCH", body: { ladder: [visit70, visit620] } }), 200)).json())
    assert.equal((await refused(await olivia(`/products/${visit70}`, { method: "PATCH", body: { unit: "job" } }), 409)).detail, visitRulesChargeAt(1), "a step keeps its unit")
  })

  test("the register: a business's credential under its own agreement, a household's under its Property, normalised, one in force at a time, blocked and unblocked", async () => {
    assert.deepEqual((await refused(await olivia("/access-credentials", { method: "POST", body: { projectId: copenhagen, validFrom: "2026-01-01", kind: "plate", value: "XX1", customerId: fx.customers.housing.id } }), 400)).errors?.map((issue) => issue.message), [ONE_HOLDER])
    assert.deepEqual((await refused(await olivia("/access-credentials", { method: "POST", body: { projectId: copenhagen, validFrom: "2026-01-01", kind: "plate", value: "XX1", customerId: fx.customers.housing.id, agreementId: fx.agreements.anna.id } }), 400)).errors, [{ path: "agreementId", message: NOT_THE_CUSTOMERS_AGREEMENT }])
    const plate = await register({ kind: "plate", value: "ab 12 345", propertyId: ex.properties.parkvej.id, label: "Family car" })
    assert.equal(plate.value, "AB12345")
    assert.equal((await refused(await olivia("/access-credentials", { method: "POST", body: { projectId: copenhagen, validFrom: "2026-03-01", kind: "plate", value: "AB12345", propertyId: ex.properties.havnegade.id } }), 409)).detail?.startsWith("A credential of this kind and number is already in force"), true)
    const listed = (await (await expect(await olivia(`/access-credentials?value=${encodeURIComponent("ab12 345")}`), 200)).json()) as { items: AccessCredential[] }
    assert.deepEqual(
      listed.items.map((item) => item.id),
      [plate.id],
    )
    const blocked = AccessCredential.parse(await (await expect(await olivia(`/access-credentials/${plate.id}/block`, { method: "POST", body: { reason: "Reported stolen" } }), 200)).json())
    assert.equal(blocked.blockedReason, "Reported stolen")
    assert.equal((await refused(await olivia(`/access-credentials/${plate.id}/block`, { method: "POST", body: { reason: "Again" } }), 409)).detail, ALREADY_BLOCKED)
    const unblocked = AccessCredential.parse(await (await expect(await olivia(`/access-credentials/${plate.id}/unblock`, { method: "POST" }), 200)).json())
    assert.equal(unblocked.blockedAt, null)
  })

  test("the check-in identifies in order and answers what a household's visit costs: the free visit, then the ladder's steps, the last repeating; free fractions neither counted nor charged", async () => {
    await register({ kind: "card", value: "H-100", propertyId: ex.properties.parkvej.id })
    const unknown = await checkIn({ identifier: { kind: "plate", value: "ZZ99999" }, occurredAt: at("2026-03-01") })
    assert.deepEqual([unknown.visit.outcome, unknown.visit.refusalReason, unknown.charge], ["refused", "unknown-identifier", null])

    const first = await checkIn({ identifier: { kind: "card", value: "h-100" }, wasteFractionIds: [ex.fractions.residual.id], occurredAt: at("2026-03-02") })
    assert.equal(first.visit.outcome, "admitted")
    assert.equal(first.visit.agreementId, fx.agreements.housingDkk.id, "the Property's fee-paying agreement")
    assert.deepEqual([first.charge?.basis, first.charge?.n, first.charge?.productId], ["free-quota", 1, null])

    const garden1 = await checkIn({ identifier: { kind: "property", propertyId: ex.properties.parkvej.id }, wasteFractionIds: [garden], occurredAt: at("2026-03-03") })
    assert.deepEqual([garden1.charge?.basis, garden1.charge?.counted], ["free-fractions", false])

    const second = await checkIn({ identifier: { kind: "plate", value: "AB12345" }, occurredAt: at("2026-03-04") })
    assert.deepEqual([second.charge?.basis, second.charge?.n, second.charge?.productId], ["ladder", 2, visit70])
    assert.deepEqual(second.charge?.price, { unitPriceMinor: 7_000, netMinor: 7_000, vatPercent: 25, vatMinor: 1_750, currency: "DKK" }, "visit 2 this year: 70 kr")
    const third = await checkIn({ identifier: { kind: "plate", value: "AB12345" }, occurredAt: at("2026-03-05") })
    const fourth = await checkIn({ identifier: { kind: "plate", value: "AB12345" }, occurredAt: at("2026-03-06") })
    assert.deepEqual([third.charge?.productId, fourth.charge?.productId, fourth.charge?.n], [visit620, visit620, 4])

    const notPaying = await checkIn({ identifier: { kind: "property", propertyId: ex.properties.havnegade.id }, occurredAt: at("2026-03-07") })
    assert.deepEqual([notPaying.visit.outcome, notPaying.visit.refusalReason, notPaying.visit.propertyId], ["refused", "not-fee-paying", ex.properties.havnegade.id])

    const [event] = await withCompany(pool.db, a.companyId, (tx: Tx) =>
      tx
        .select({ kind: outboxEvent.kind, aggregateKind: outboxEvent.aggregateKind, payload: outboxEvent.payload })
        .from(outboxEvent)
        .where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, second.visit.id)))
        .orderBy(asc(outboxEvent.id)),
    )
    assert.deepEqual(event, { kind: "site-visit-recorded", aggregateKind: "site-visit", payload: second.visit })
  })

  test("a business's visit is charged at the per-visit product, or included under its agreement's annual access; a blocked credential is turned away and recorded", async () => {
    await register({ kind: "plate", value: "VAN 2", customerId: fx.customers.anna.id, agreementId: fx.agreements.anna.id })
    const perVisit = await checkIn({ identifier: { kind: "plate", value: "VAN2" }, wasteFractionIds: [garden], occurredAt: at("2026-04-01") })
    assert.deepEqual([perVisit.visit.customerId, perVisit.charge?.basis, perVisit.charge?.productId, perVisit.charge?.price?.netMinor], [fx.customers.anna.id, "per-visit", businessVisit, 15_000])
    await withCompany(pool.db, a.companyId, (tx: Tx) =>
      tx.insert(subscription).values({ id: testId(), companyId: a.companyId, projectId: copenhagen, agreementId: fx.agreements.anna.id, productId: annualAccess, propertyId: ex.properties.norrebrogade.id, quantity: 1, validFrom: "2026-04-02" }),
    )
    const included = await checkIn({ identifier: { kind: "plate", value: "VAN2" }, occurredAt: at("2026-04-02") })
    assert.deepEqual([included.charge?.basis, included.charge?.productId], ["annual-access", null])

    const card = await register({ kind: "card", value: "B-9", customerId: fx.customers.anna.id, agreementId: fx.agreements.anna.id })
    await expect(await olivia(`/access-credentials/${card.id}/block`, { method: "POST", body: { reason: "Lost" } }), 200)
    const turnedAway = await checkIn({ identifier: { kind: "card", value: "B-9" }, occurredAt: at("2026-04-03") })
    assert.deepEqual([turnedAway.visit.outcome, turnedAway.visit.refusalReason, turnedAway.visit.credentialId, turnedAway.charge], ["refused", "credential-blocked", card.id, null])
  })

  test("the check-in's refusals: a site that is no recycling centre of the caller's, a fraction the site does not take, an instant ahead of the clock", async () => {
    assert.deepEqual((await refused(await olivia("/site-visits", { method: "POST", body: { siteId: testId(), identifier: { kind: "plate", value: "AB1" } } }), 400)).errors, [{ path: "siteId", message: NOT_A_CENTRE }])
    assert.deepEqual((await refused(await olivia("/site-visits", { method: "POST", body: { siteId: site, identifier: { kind: "plate", value: "AB1" }, wasteFractionIds: [garden, ex.fractions.glass.id] } }), 400)).errors, [{ path: "wasteFractionIds.1", message: NOT_TAKEN_HERE }])
    assert.equal((await refused(await olivia("/site-visits", { method: "POST", body: { siteId: site, identifier: { kind: "plate", value: "AB1" }, occurredAt: "2026-10-13T12:00:00.000Z" } }), 400)).errors?.[0]?.path, "occurredAt")
  })

  test("a visit is voided once, with the person and the reason, and kept in the ledger; the void is news for Finance", async () => {
    const visit = await checkIn({ identifier: { kind: "plate", value: "AB12345" }, occurredAt: at("2026-05-01") })
    const voided = SiteVisit.parse(await (await expect(await olivia(`/site-visits/${visit.visit.id}/void`, { method: "POST", body: { reason: "Checked in twice" } }), 200)).json())
    assert.deepEqual([voided.voidReason, voided.voidedBy, voided.voidedAt], ["Checked in twice", a.users.olivia.id, NOW.toISOString()])
    assert.equal((await refused(await olivia(`/site-visits/${visit.visit.id}/void`, { method: "POST", body: { reason: "Again" } }), 409)).detail, ALREADY_VOIDED)
    const kinds = await withCompany(pool.db, a.companyId, (tx: Tx) => tx.select({ kind: outboxEvent.kind }).from(outboxEvent).where(and(eq(outboxEvent.companyId, a.companyId), eq(outboxEvent.aggregateId, visit.visit.id))).orderBy(asc(outboxEvent.id)))
    assert.deepEqual(
      kinds.map((row) => row.kind),
      ["site-visit-recorded", "site-visit-voided"],
    )
    const ledger = (await (await expect(await olivia(`/site-visits?propertyId=${ex.properties.parkvej.id}&from=2026-05-01&to=2026-05-01`), 200)).json()) as { items: SiteVisit[] }
    assert.deepEqual(
      ledger.items.map((item) => [item.id, item.voidedAt !== null]),
      [[visit.visit.id, true]],
    )
  })

  test("the likely trades: a Property with the rule's threshold of counted visits in its window", async () => {
    const trades = FrequentVisitors.parse(await (await expect(await olivia(`/site-visits/frequent?projectId=${copenhagen}&on=2026-03-30`), 200)).json())
    assert.deepEqual(trades.items, [{ propertyId: ex.properties.parkvej.id, visits: 4 }], "four counted, the garden visit left out")
    assert.deepEqual([trades.ruleId, trades.threshold, trades.windowDays], [rule.id, 3, 30])
    assert.deepEqual(FrequentVisitors.parse(await (await expect(await olivia(`/site-visits/frequent?projectId=${copenhagen}&on=2026-04-30`), 200)).json()).items, [])
  })

  test("the Site attendant checks in and reads the ledger and the register, and voids nothing, keeps no register and sets no rule", async () => {
    const visit = await checkIn({ identifier: { kind: "plate", value: "AB12345" }, occurredAt: at("2026-06-01") }, attendant)
    assert.equal(visit.visit.recordedBy, a.users.viewer.id)
    await expect(await attendant(`/site-visits/${visit.visit.id}`), 200)
    await expect(await attendant(`/access-credentials?projectId=${copenhagen}`), 200)
    await expect(await attendant(`/site-visits/${visit.visit.id}/void`, { method: "POST", body: { reason: "x" } }), 403)
    await expect(await attendant("/access-credentials", { method: "POST", body: { projectId: copenhagen, validFrom: "2026-01-01", kind: "plate", value: "Q1", propertyId: ex.properties.parkvej.id } }), 403)
    await expect(await attendant(`/visit-rules?projectId=${copenhagen}`), 403)
  })

  test("each row written is audited under its module", async () => {
    const rows = await withCompany(pool.db, a.companyId, (tx: Tx) =>
      tx.execute<{ table_name: string }>(sql`select distinct table_name from wms.audit_event where company_id = ${a.companyId} and table_name in ('access_credential', 'site_visit', 'site_visit_fraction', 'visit_rule', 'visit_rule_step', 'visit_rule_free_fraction') order by table_name`),
    )
    assert.deepEqual(
      [...rows].map((row) => row.table_name),
      ["access_credential", "site_visit", "site_visit_fraction", "visit_rule", "visit_rule_free_fraction", "visit_rule_step"],
    )
  })
})
