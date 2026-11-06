// The counting rules at work (#547 of #544), on the shared local database
// with a tenant of this file's own: each completed emptying is counted
// against the active rules of its fraction and container type, a rule's
// ticket opens on the emptying that reaches its limit — of its type, waiting
// with its team, naming the property alone, recording the rule, the period
// and the count — and the team is e-mailed where the rule says so; a
// property gets one ticket per rule and period, a redelivery opens nothing,
// and a stop that is not a completed emptying counts nothing.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { Database } from "@waste/db/client"
import { createDb } from "@waste/db/client"
import { ticketColumns, ticketOf } from "@waste/db/commands/resolution-rows"
import type { Send } from "@waste/db/jobs"
import { wasteFraction } from "@waste/db/schema/catalogue"
import { message } from "@waste/db/schema/messaging"
import { countingRule, team, teamMember, ticket, ticketType } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { and, asc, eq, isNotNull } from "drizzle-orm"

import { countEmptying } from "../jobs/count-emptyings"
import type { JobContext } from "../jobs/definition"
import { at, dropConsumerTenant, outboxJob, pickupPayload, seedConsumerTenant, seedRoute, testId, type ConsumerTenant, type StopSeed } from "./consumer-fixtures"
import { databaseUnderTest, ownerUnderTest } from "./database"

const api = databaseUnderTest()
const owner = ownerUnderTest()

describe("the counting rules' consumer", { skip: api.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let tenant: ConsumerTenant
  const lines: string[] = []
  const send: Send = async () => testId()
  const context = () => ({ api: pool, send, now: () => at("13:30"), log: (line: string) => void lines.push(line) }) as unknown as JobContext
  const teamId = testId()
  const typeId = testId()
  const rules = { often: testId(), anyBin: testId(), glass: testId(), off: testId() }

  before(async () => {
    pool = createDb(api.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    tenant = await seedConsumerTenant(pool)
    const { companyId } = tenant
    const glassId = testId()
    await withCompany(pool.db, companyId, async (tx) => {
      await tx.insert(wasteFraction).values({ id: glassId, companyId, key: "glass", name: "Glass" })
      await tx.insert(team).values({ id: teamId, companyId, name: "Customer service" })
      await tx.insert(teamMember).values({ companyId, teamId, userAccountId: tenant.officeUserId })
      await tx.insert(ticketType).values({ id: typeId, companyId, name: "Emptied too often", kind: "other" })
      const rule = { companyId, ticketTypeId: typeId, teamId, status: "active" }
      await tx.insert(countingRule).values([
        // Three emptyings a month, the team told.
        { ...rule, id: rules.often, name: "Emptied often", period: "month", limit: 3, notifiesTeam: true },
        // A first emptying of a bin of the tenant's type in a year.
        { ...rule, id: rules.anyBin, name: "Bin emptied this year", period: "year", limit: 1, containerTypeId: tenant.containerTypeId },
        // Glass alone: the tenant's stops are residual, so never.
        { ...rule, id: rules.glass, name: "Glass emptied", period: "month", limit: 1, wasteFractionId: glassId },
        // Switched off: never.
        { ...rule, id: rules.off, name: "Not yet on", period: "month", limit: 1, status: "inactive" },
      ])
    })
  })
  after(async () => {
    if (tenant !== undefined) await dropConsumerTenant(pool, ownerPool, tenant.companyId)
    await pool?.close()
    await ownerPool?.close()
  })

  /** A route of one stop decided as given, and its event as the relay hands it. */
  const emptied = async (stop: StopSeed = { container: "bin1", status: "completed" }, kind: "pickup-completed" | "pickup-corrected" = "pickup-completed") => {
    const route = await seedRoute(pool, tenant, { pickups: [stop] })
    const pickupId = route.pickupIds[0]
    return outboxJob(tenant, { kind, aggregateKind: "pickup", aggregateId: pickupId, payload: pickupPayload(tenant, route.id, pickupId, stop) })
  }
  const ticketsOf = (ruleId: string) =>
    withCompany(pool.db, tenant.companyId, async (tx) =>
      (
        await tx
          .select(ticketColumns)
          .from(ticket)
          .where(and(eq(ticket.companyId, tenant.companyId), eq(ticket.countingRuleId, ruleId)))
          .orderBy(asc(ticket.number))
      ).map(ticketOf),
    )

  test("a bin's first emptying of the year reaches the type's rule; the month's rule counts one, and the glass and the switched-off rule nothing", async () => {
    const first = await countEmptying(await emptied(), context())
    const [opened] = await ticketsOf(rules.anyBin)
    assert.deepEqual(first.opened, [{ countingRuleId: rules.anyBin, ticketId: opened.id }])
    assert.deepEqual(opened.countedBy, { countingRuleId: rules.anyBin, periodFrom: "2026-01-01", count: 1 })
    assert.equal(opened.description, '1 completed emptying in 240 L bin containers at this property in 2026 reached the counting rule "Bin emptied this year", whose limit is 1 a year.')
    assert.deepEqual((await ticketsOf(rules.often)).length + (await ticketsOf(rules.glass)).length + (await ticketsOf(rules.off)).length, 0)
  })

  test("the month's third emptying at a property opens the rule's ticket: its type, its team, the property alone, the count, and the team told", async () => {
    assert.deepEqual((await countEmptying(await emptied(), context())).opened, [], "the second: the year's ticket is open already, the month counts two")
    const third = await countEmptying(await emptied(), context())
    const [opened] = await ticketsOf(rules.often)
    assert.deepEqual(third.opened, [{ countingRuleId: rules.often, ticketId: opened.id }])
    assert.deepEqual(
      [opened.kind, opened.ticketTypeId, opened.teamId, opened.source, opened.status, opened.priority, opened.createdBy, opened.assigneeUserAccountId, opened.dueAt],
      ["other", typeId, teamId, "counting-rule", "open", "none", null, null, null],
    )
    assert.deepEqual(opened.links, { routeId: null, pickupId: null, containerId: null, propertyId: tenant.properties.parkvej.id, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null })
    assert.deepEqual(opened.countedBy, { countingRuleId: rules.often, periodFrom: "2026-10-01", count: 3 })
    assert.equal(opened.subject, "Emptied often")
    assert.equal(opened.description, '3 completed emptyings at this property in October 2026 reached the counting rule "Emptied often", whose limit is 3 a month.')
    assert.equal(opened.occurredAt, at("07:12").toISOString())
    const notices = await withCompany(pool.db, tenant.companyId, (tx) =>
      tx
        .select({ userAccountId: message.userAccountId, purpose: message.purpose, subject: message.subject })
        .from(message)
        .where(and(eq(message.sourceEventId, opened.id), isNotNull(message.userAccountId))),
    )
    assert.deepEqual(notices, [{ userAccountId: tenant.officeUserId, purpose: "staff", subject: `Ticket ${opened.label} for Customer service · Emptied often` }])
    assert.equal((await ticketsOf(rules.anyBin)).length, 1, "the year's rule told no one and opened no second ticket")
  })

  test("a fourth emptying, a redelivery and a correction to completed open nothing more: one ticket per rule, property and period", async () => {
    const fourth = await emptied()
    assert.deepEqual((await countEmptying(fourth, context())).opened, [])
    assert.deepEqual((await countEmptying(fourth, context())).opened, [])
    assert.deepEqual((await countEmptying(await emptied({ container: "bin1", status: "completed" }, "pickup-corrected"), context())).opened, [])
    assert.equal((await ticketsOf(rules.often)).length, 1)
  })

  test("a failed stop counts nothing, and an address-only emptying counts for the month's rule but never for a container type's", async () => {
    assert.deepEqual((await countEmptying(await emptied({ container: "bin2", status: "failed", reason: "not-presented" }), context())).opened, [])
    // Havnegade: an address-only stop, the office's, then two of BIN-2's; the type's rule counts BIN-2's first, the month's rule all three.
    assert.deepEqual((await countEmptying(await emptied({ container: null, status: "completed" }), context())).opened, [])
    const bin2 = await countEmptying(await emptied({ container: "bin2", status: "completed" }), context())
    assert.deepEqual(
      bin2.opened.map((one) => one.countingRuleId),
      [rules.anyBin],
    )
    const third = await countEmptying(await emptied({ container: "bin2", status: "completed" }), context())
    assert.deepEqual(
      third.opened.map((one) => one.countingRuleId),
      [rules.often],
    )
    const havnegade = (await ticketsOf(rules.often)).find((one) => one.links.propertyId === tenant.properties.havnegade.id)
    assert.equal(havnegade?.countedBy?.count, 3)
    assert.ok(lines.some((line) => line.startsWith("resolution.count-emptyings: pickup-completed")))
  })
})
