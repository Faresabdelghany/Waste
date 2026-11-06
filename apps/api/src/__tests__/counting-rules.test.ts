// Counting Rules (#547 of #544): `/counting-rules` under `configure.templates`
// — a rule made inactive, read, listed by status, changed and switched on,
// its fraction, container type, ticket type and team the company's and the
// type and the team active where newly named, a name one rule's, a rule that
// opened a ticket kept — and `POST /counting-rules/simulation`, which counts
// a rule's terms over past emptyings in the caller's projects: the window
// widened to whole periods, each property's ticket on the day its count
// reached the limit, the work orders, the failed stops and another fraction
// passed over.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { CountingRule, CountingSimulation } from "@waste/contracts/counting-rules"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { openTicket } from "@waste/db/commands/open-ticket"
import { newId } from "@waste/db/ids"
import { team, ticketType } from "@waste/db/schema/resolution"
import { withCompany } from "@waste/db/tenant"
import { SIMULATION_DAYS_MAX } from "@waste/domain/resolution/counting-rules"
import { and, eq } from "drizzle-orm"

import { createApp } from "../app"
import { ruleHasTickets } from "../routes/counting-rules"
import { NOT_A_TEAM } from "../routes/references"
import { retiredTeam, retiredTicketType } from "../routes/statuses"
import { NOT_A_TICKET_TYPE } from "../routes/ticket-type-rules"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { at, seedExecution, seedRoute, type ExecutionFixtures, type PickupSeed } from "./execution-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures } from "./scheme-fixtures"
import { dropTenant, grantRole, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the ticket history and the proofs the suite writes, which `wms_api` may not delete. */
const owner = ownerUnderTest()
const RulePage = Page(CountingRule)

describe("counting rules", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let a: Tenant
  let b: Tenant
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  let olivia: Call
  let other: Call
  /** On the viewer role, in Copenhagen alone, with `view` on the templates and the stops. */
  let viewer: Call
  let typeId: string
  let teamId: string
  let retiredTypeId: string
  let retiredTeamId: string

  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }
  const ok = async <T>(response: Response, schema: { parse: (value: unknown) => T }): Promise<T> => {
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }
  const newRule = async (name: string, values: Record<string, unknown> = {}): Promise<CountingRule> =>
    created(olivia, "/counting-rules", await olivia("/counting-rules", { method: "POST", body: { name, period: "month", limit: 3, ticketTypeId: typeId, teamId, ...values } }), CountingRule)
  const simulate = (call: Call, values: Record<string, unknown>) => call("/counting-rules/simulation", { method: "POST", body: { period: "month", limit: 3, from: "2026-01-15", to: "2026-05-10", ...values } })

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    const keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    fleet = await seedFleet(pool, a, await seedPlanning(pool, a))
    ex = await seedExecution(pool, a, fleet)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [
      { moduleKey: "configure.templates", actions: ["view"] },
      { moduleKey: "route-studio.pickups", actions: ["view"] },
    ])
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    typeId = testId()
    teamId = testId()
    retiredTypeId = testId()
    retiredTeamId = testId()
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(ticketType).values([
        { id: typeId, companyId: a.companyId, name: "Emptied too often", kind: "other" },
        { id: retiredTypeId, companyId: a.companyId, name: "Old frequency check", kind: "other", status: "inactive" },
      ])
      await tx.insert(team).values([
        { id: teamId, companyId: a.companyId, name: "Customer service" },
        { id: retiredTeamId, companyId: a.companyId, name: "Old desk", status: "inactive" },
      ])
    })

    // The emptyings the simulations count, each on a Monday route of its own.
    const done = (day: string) => ({ status: "completed" as const, outcomeAt: at(day, "09:00") })
    const stops = {
      parkvej: (day: string): PickupSeed => ({ containerId: ex.containers.bin1.id, propertyId: ex.properties.parkvej.id, ...done(day) }),
      havnegade: (day: string): PickupSeed => ({ containerId: ex.containers.bin2.id, propertyId: ex.properties.havnegade.id, ...done(day) }),
      norrebrogadeGlass: (day: string): PickupSeed => ({ containerId: ex.containers.bin3.id, propertyId: ex.properties.norrebrogade.id, wasteFractionId: ex.fractions.glass.id, ...done(day) }),
    }
    const run = (day: string, pickups: PickupSeed[], project: "copenhagen" | "harbor" = "copenhagen") =>
      seedRoute(pool, a, fleet, ex, { status: "completed", operatingDate: day, project, pickups, ...(project === "harbor" ? { plannedVehicleId: fleet.vehicles.harborTruck.id } : {}) })
    await run("2026-03-02", [stops.parkvej("2026-03-02"), stops.havnegade("2026-03-02"), stops.norrebrogadeGlass("2026-03-02")])
    await run("2026-03-09", [stops.parkvej("2026-03-09"), stops.havnegade("2026-03-09"), stops.norrebrogadeGlass("2026-03-09")])
    // Havnegade's third is missed: two emptyings in March.
    await run("2026-03-16", [stops.parkvej("2026-03-16"), { ...stops.havnegade("2026-03-16"), status: "failed", reason: "not-presented" }, stops.norrebrogadeGlass("2026-03-16")])
    // A repair at Parkvej: a work order, never an emptying.
    await run("2026-03-23", [{ ...stops.parkvej("2026-03-23"), origin: "office", service: "repair" }])
    await run("2026-04-06", [stops.parkvej("2026-04-06")])
    // Harbor's bin, three times in March: a project the viewer does not work in.
    for (const day of ["2026-03-02", "2026-03-09", "2026-03-16"]) await run(day, [{ containerId: ex.containers.harborBin.id, propertyId: ex.properties.harbor.id, ...done(day) }], "harbor")
  })

  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  describe("the rules", () => {
    test("a rule is made inactive, read, listed by status, changed and switched on; a name is one rule's", async () => {
      const rule = await newRule("Emptied often")
      assert.deepEqual(
        [rule.status, rule.period, rule.limit, rule.wasteFractionId, rule.containerTypeId, rule.ticketTypeId, rule.teamId, rule.notifiesTeam],
        ["inactive", "month", 3, null, null, typeId, teamId, false],
      )
      assert.deepEqual(await ok(await olivia(`/counting-rules/${rule.id}`), CountingRule), rule)
      assert.ok((await ok(await olivia("/counting-rules?status=inactive"), RulePage)).items.some((one) => one.id === rule.id))
      const on = await ok(await olivia(`/counting-rules/${rule.id}`, { method: "PATCH", body: { status: "active", period: "quarter", limit: 12, wasteFractionId: ex.fractions.residual.id, notifiesTeam: true } }), CountingRule)
      assert.deepEqual([on.status, on.period, on.limit, on.wasteFractionId, on.notifiesTeam], ["active", "quarter", 12, ex.fractions.residual.id, true])
      assert.ok(!(await ok(await olivia("/counting-rules?status=inactive"), RulePage)).items.some((one) => one.id === rule.id))
      const taken = await refused(await olivia("/counting-rules", { method: "POST", body: { name: "Emptied often", period: "year", limit: 1, ticketTypeId: typeId, teamId } }), 409)
      assert.equal(taken.detail, 'This company already has a counting rule called "Emptied often"')
      await refused(await olivia(`/counting-rules/${rule.id}`, { method: "PATCH", body: {} }), 400)
      await refused(await olivia(`/counting-rules/${rule.id}`, { method: "PATCH", body: { limit: 0 } }), 400)
      await refused(await olivia(`/counting-rules/${rule.id}`, { method: "PATCH", body: { limit: 1001 } }), 400)
    })

    test("its fraction, container type, ticket type and team are the company's, and a type or a team named afresh is active", async () => {
      const elsewhere = await refused(await olivia("/counting-rules", { method: "POST", body: { name: "Foreign", period: "month", limit: 2, ticketTypeId: testId(), teamId: testId(), wasteFractionId: testId() } }), 400)
      assert.deepEqual(elsewhere.errors?.map((error) => error.path), ["wasteFractionId"])
      const type = await refused(await olivia("/counting-rules", { method: "POST", body: { name: "Foreign", period: "month", limit: 2, ticketTypeId: testId(), teamId } }), 400)
      assert.deepEqual(type.errors, [{ path: "ticketTypeId", message: NOT_A_TICKET_TYPE }])
      const desk = await refused(await olivia("/counting-rules", { method: "POST", body: { name: "Foreign", period: "month", limit: 2, ticketTypeId: typeId, teamId: testId() } }), 400)
      assert.deepEqual(desk.errors, [{ path: "teamId", message: NOT_A_TEAM }])
      assert.equal((await refused(await olivia("/counting-rules", { method: "POST", body: { name: "Retired", period: "month", limit: 2, ticketTypeId: retiredTypeId, teamId } }), 409)).detail, retiredTicketType("Old frequency check"))
      assert.equal((await refused(await olivia("/counting-rules", { method: "POST", body: { name: "Retired", period: "month", limit: 2, ticketTypeId: typeId, teamId: retiredTeamId } }), 409)).detail, retiredTeam("Old desk"))
      // A team the rule names already stands, retired since: a patch restating it is not refused.
      const kept = await newRule("Kept desk")
      await withCompany(pool.db, a.companyId, (tx: Tx) => tx.update(team).set({ status: "inactive" }).where(and(eq(team.companyId, a.companyId), eq(team.id, teamId))))
      try {
        assert.equal((await ok(await olivia(`/counting-rules/${kept.id}`, { method: "PATCH", body: { teamId, limit: 4 } }), CountingRule)).limit, 4)
      } finally {
        await withCompany(pool.db, a.companyId, (tx: Tx) => tx.update(team).set({ status: "active" }).where(and(eq(team.companyId, a.companyId), eq(team.id, teamId))))
      }
    })

    test("a rule that opened no ticket is removed; one that did is kept, switched off instead", async () => {
      const wrong = await newRule("Set up wrongly")
      assert.equal((await olivia(`/counting-rules/${wrong.id}`, { method: "DELETE" })).status, 204)
      await refused(await olivia(`/counting-rules/${wrong.id}`), 404)
      const used = await newRule("Has opened one")
      await withCompany(pool.db, a.companyId, (tx: Tx) =>
        openTicket(tx, {
          companyId: a.companyId,
          draft: {
            projectId: a.projects.copenhagen.id,
            kind: "other",
            ticketTypeId: typeId,
            priority: "none",
            source: "counting-rule",
            subject: used.name,
            description: "Three emptyings in March.",
            occurredAt: at("2026-03-16", "09:00"),
            dueAt: null,
            assigneeUserAccountId: null,
            teamId,
            links: { routeId: null, pickupId: null, containerId: null, propertyId: ex.properties.parkvej.id, sharedCollectionPointId: null, customerId: null, agreementId: null, driverId: null, parentTicketId: null },
            alertId: null,
            countedBy: { countingRuleId: used.id, periodFrom: "2026-03-01", count: 3 },
          },
          createdBy: null,
          sourceEventId: newId(),
          newId,
          now: () => new Date(),
          automation: { send: async () => null, by: null },
        }),
      )
      assert.equal((await refused(await olivia(`/counting-rules/${used.id}`, { method: "DELETE" }), 409)).detail, ruleHasTickets("Has opened one"))
    })

    test("another company's rule is not one here, and a role without the templates' grant reads and writes none", async () => {
      const rule = await newRule("Ours alone")
      await refused(await other(`/counting-rules/${rule.id}`), 404)
      assert.ok(!(await ok(await other("/counting-rules"), RulePage)).items.some((one) => one.id === rule.id))
      await refused(await viewer("/counting-rules", { method: "POST", body: { name: "Not mine", period: "month", limit: 2, ticketTypeId: typeId, teamId } }), 403)
      await refused(await viewer(`/counting-rules/${rule.id}`, { method: "DELETE" }), 403)
    })
  })

  describe("the simulation", () => {
    test("counts every fraction over whole months: each property's ticket on the day its count reached the limit, with the period's count", async () => {
      const simulated = await ok(await simulate(olivia, {}), CountingSimulation)
      assert.deepEqual([simulated.from, simulated.to, simulated.tickets, simulated.properties], ["2026-01-01", "2026-06-01", 3, 3])
      assert.deepEqual(
        simulated.shown.map((one) => [one.propertyId, one.periodFrom, one.reachedOn, one.count]).sort(),
        [
          [ex.properties.parkvej.id, "2026-03-01", "2026-03-16", 3],
          [ex.properties.norrebrogade.id, "2026-03-01", "2026-03-16", 3],
          [ex.properties.harbor.id, "2026-03-01", "2026-03-16", 3],
        ].sort(),
      )
      assert.equal(simulated.shown.find((one) => one.propertyId === ex.properties.parkvej.id)?.propertyName, "Parkvej 18")
      assert.equal(simulated.shown.find((one) => one.propertyId === ex.properties.harbor.id)?.projectId, a.projects.harbor.id)
    })

    test("one fraction, one container type, a quarter or a year count what they name, and a work order or a missed stop never", async () => {
      const residual = await ok(await simulate(olivia, { wasteFractionId: ex.fractions.residual.id }), CountingSimulation)
      assert.deepEqual(residual.shown.map((one) => one.propertyId).sort(), [ex.properties.parkvej.id, ex.properties.harbor.id].sort())
      assert.equal((await ok(await simulate(olivia, { containerTypeId: ex.containerTypes.bin.id }), CountingSimulation)).tickets, 3)
      assert.equal((await ok(await simulate(olivia, { period: "quarter", limit: 4 }), CountingSimulation)).tickets, 0, "Parkvej's repair is no fourth emptying in the first quarter")
      const year = await ok(await simulate(olivia, { period: "year", limit: 4 }), CountingSimulation)
      assert.deepEqual([year.from, year.to], ["2026-01-01", "2027-01-01"])
      // The year's whole count: the fixtures' own completed route empties Parkvej again in October.
      assert.deepEqual(
        year.shown.map((one) => [one.propertyId, one.reachedOn, one.count]),
        [[ex.properties.parkvej.id, "2026-04-06", 5]],
      )
      assert.equal((await ok(await simulate(olivia, { limit: 2 }), CountingSimulation)).properties, 4, "Havnegade's two in March reach a limit of two")
    })

    test("counts the caller's projects alone, and refuses a window run backwards, over three years, or a fraction not the company's", async () => {
      const copenhagen = await ok(await simulate(viewer, {}), CountingSimulation)
      assert.ok(!copenhagen.shown.some((one) => one.propertyId === ex.properties.harbor.id))
      assert.equal(copenhagen.tickets, 2)
      const backwards = await refused(await simulate(olivia, { from: "2026-05-01", to: "2026-05-01" }), 400)
      assert.deepEqual(backwards.errors?.map((error) => error.path), ["to"])
      const long = await refused(await simulate(olivia, { from: "2023-01-01", to: "2026-05-01" }), 400)
      assert.ok(long.errors?.some((error) => error.path === "to" && error.message === `A simulation looks back at most ${SIMULATION_DAYS_MAX} days`))
      const foreign = await refused(await simulate(olivia, { wasteFractionId: testId() }), 400)
      assert.deepEqual(foreign.errors?.map((error) => error.path), ["wasteFractionId"])
      await refused(await simulate(other, { wasteFractionId: ex.fractions.residual.id }), 400)
    })
  })
})
