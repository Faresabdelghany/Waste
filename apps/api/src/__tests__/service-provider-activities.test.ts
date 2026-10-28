// Service Provider Activities through the API (#474): Lars, NordRen's
// manager, proposes that a Collection Group of a scheme NordRen serves run on
// Wednesday instead of Tuesday from a day; the office approves it and the
// approval writes the scheme's next version from that day, the group on its
// new day; a refusal of the scheme's own leaves the proposal pending. The
// office raises a compliance follow-up, either side keeps a note, and each
// side reaches its own: the office its projects', a provider its own
// provider's, never another's. Each test makes its own draft scheme in
// Centrum, which NordRen's award holds for 2026.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { AuditEvent } from "@waste/contracts/audit"
import { Page } from "@waste/contracts/pagination"
import { RouteScheme } from "@waste/contracts/route-schemes"
import { ServiceProviderActivity } from "@waste/contracts/service-provider-activities"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { role, roleGrant, serviceProviderAccess, userAccount } from "@waste/db/schema/access"
import { vehicle } from "@waste/db/schema/fleet"
import { withCompany } from "@waste/db/tenant"
import { and, eq } from "drizzle-orm"
import { normaliseGrants } from "@waste/domain/access/grants"
import { OFFICE_CLOSES_FOLLOW_UPS, OFFICE_DECIDES, OFFICE_RAISES_FOLLOW_UPS, SAME_CREW, SAME_DAYS } from "@waste/domain/service-providers/activities"

import { notOwnFleet } from "../auth/provider"
import { createApp } from "../app"
import { NOT_A_POWERED_VEHICLE } from "../routes/references"
import { dispatchedFrom } from "../routes/scheme-lifecycle"
import { appliesFromTomorrow, KIND_CARRIES_NOT, NOT_A_GROUP_OF_THE_SCHEME, notOwnProvider, notServed } from "../routes/service-provider-activities"
import { callingAs, type Call } from "./calls"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { seedExecution, seedRoute, type ExecutionFixtures } from "./execution-fixtures"
import { seedFinance } from "./finance-fixtures"
import { readProblem } from "./read-problem"
import { seedFleet, seedPlanning, type FleetFixtures, type PlanningFixtures } from "./scheme-fixtures"
import { dropTenant, seedTenant, testId, type Account, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The fixtures write proofs, a ledger the API role cannot delete, so the tenant is dropped as the owner. */
const owner = ownerUnderTest()

const ActivityPage = Page(ServiceProviderActivity)
const AuditEventPage = Page(AuditEvent)

/** A Saturday noon in Copenhagen: tomorrow is Sunday 11 October. */
const NOW = new Date("2026-10-10T10:00:00Z")
const TOMORROW = "2026-10-11"
/** A Tuesday inside NordRen's award, the day the proposals apply from. */
const FROM = "2026-10-20"

describe("service provider activities (#474)", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let planning: PlanningFixtures
  let fleet: FleetFixtures
  let ex: ExecutionFixtures
  /** The administrator: every action, every project. */
  let olivia: Call
  /** NordRen's Service Provider Manager. */
  let lars: Call
  /** CityHaul's manager, on the same charter. */
  let mikkel: Call
  /** An office account that decides activities but writes no scheme: `service-providers.activities` alone, every project. */
  let desk: Call
  let deskAccount: Account
  let larsId: string

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    planning = await seedPlanning(pool, a)
    fleet = await seedFleet(pool, a, planning)
    ex = await seedExecution(pool, a, fleet)
    // NordRen's award, CA-Ø-2, over Centrum for 2026, assigned from 2026-03-01.
    await seedFinance(pool, a, planning)
    const domain = a.users.olivia.email.split("@")[1]
    const mikkelAccount: Account = { id: testId(), authUserId: randomUUID(), email: `mikkel.andersen@${domain}`, fullName: "Mikkel Andersen" }
    deskAccount = { id: testId(), authUserId: randomUUID(), email: `contract.desk@${domain}`, fullName: "Contract Desk" }
    await withCompany(pool.db, a.companyId, async (tx: Tx) => {
      await tx.insert(userAccount).values({ id: mikkelAccount.id, companyId: a.companyId, authUserId: mikkelAccount.authUserId, email: mikkelAccount.email, fullName: mikkelAccount.fullName, roleId: a.roles.providerManager.id, serviceProviderId: a.serviceProviders.cityhaul.id })
      await tx.insert(serviceProviderAccess).values({ companyId: a.companyId, userAccountId: mikkelAccount.id, serviceProviderId: a.serviceProviders.cityhaul.id })
      const deskRole = testId()
      await tx.insert(role).values({ id: deskRole, companyId: a.companyId, key: null, name: "Contract desk", scope: "Company", description: "Decides the providers' activities", system: false })
      const grants = normaliseGrants([{ moduleKey: "service-providers.activities", actions: ["view", "create", "edit"] }])
      await tx.insert(roleGrant).values(grants.flatMap((grant) => grant.actions.map((action) => ({ companyId: a.companyId, roleId: deskRole, moduleKey: grant.moduleKey, action }))))
      // WH-25 is NordRen's own truck: the one its manager may propose.
      await tx.update(vehicle).set({ ownership: "service-provider", serviceProviderId: a.serviceProviders.nordren.id }).where(and(eq(vehicle.companyId, a.companyId), eq(vehicle.id, fleet.vehicles.wh25.id)))
      await tx.insert(userAccount).values({ id: deskAccount.id, companyId: a.companyId, authUserId: deskAccount.authUserId, email: deskAccount.email, fullName: deskAccount.fullName, roleId: deskRole, allProjects: true })
    })
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOW })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    larsId = a.users.lars.id
    mikkel = callingAs(app, keys, mikkelAccount, a.companyId)
    desk = callingAs(app, keys, deskAccount, a.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const ok = async (response: Response, status = 200): Promise<unknown> => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await response.json()
  }
  const refused = async (response: Response, status: number) => {
    assert.equal(response.status, status, JSON.stringify(await response.clone().json()))
    return await readProblem(response)
  }

  /** A draft weekly scheme of Copenhagen Central in Centrum, serving Tuesdays from the start of the year, its one group on Tuesday. */
  const schemeNamed = async (name: string, values: Record<string, unknown> = {}): Promise<RouteScheme> =>
    RouteScheme.parse(
      await ok(
        await olivia("/route-schemes", {
          method: "POST",
          body: {
            projectId: a.projects.copenhagen.id,
            name,
            planningAreaId: planning.areas.centrum.id,
            serviceType: "container-collection",
            frequency: "weekly",
            serviceDays: ["tuesday"],
            validFrom: "2026-01-01",
            collectionGroups: [{ name: "Organic", days: ["tuesday"], stopSource: "rule", rule: { wasteFractionIds: [ex.fractions.residual.id], containerTypeIds: [], vehicleTypeId: null } }],
            ...values,
          },
        }),
        201,
      ),
    )
  const proposalBody = (scheme: RouteScheme, values: Record<string, unknown> = {}) => ({
    kind: "route-day-change",
    projectId: a.projects.copenhagen.id,
    serviceProviderId: a.serviceProviders.nordren.id,
    subject: "Organic route to Wednesday",
    body: "The harbour market blocks Tuesday's streets.",
    routeSchemeId: scheme.id,
    collectionGroupId: scheme.collectionGroups[0].id,
    serviceDays: ["wednesday"],
    effectiveFrom: FROM,
    ...values,
  })
  const open = async (call: Call, body: unknown): Promise<ServiceProviderActivity> => ServiceProviderActivity.parse(await ok(await call("/service-provider-activities", { method: "POST", body }), 201))
  const commanded = (call: Call, id: string, command: string, body: unknown = {}) => call(`/service-provider-activities/${id}/${command}`, { method: "POST", body })
  const read = async (call: Call, id: string) => ServiceProviderActivity.parse(await ok(await call(`/service-provider-activities/${id}`)))
  const scheme = async (id: string) => RouteScheme.parse(await ok(await olivia(`/route-schemes/${id}`)))

  describe("a route-day change", () => {
    test("Lars proposes it for a scheme NordRen serves, pending the office's approval, numbered", async () => {
      const organic = await schemeNamed("Organic Tuesdays")
      const proposal = await open(lars, proposalBody(organic))
      assert.equal(proposal.kind, "route-day-change")
      assert.equal(proposal.status, "pending-approval")
      assert.equal(proposal.openedBy, larsId)
      assert.deepEqual(proposal.serviceDays, ["wednesday"])
      assert.equal(proposal.successorSchemeId, null)
      assert.ok(proposal.number >= 1)
      const next = await open(lars, proposalBody(organic, { serviceDays: ["thursday"] }))
      assert.equal(next.number, proposal.number + 1, "the company's running count")
    })

    test("is held to its group, its days, its day and NordRen's award", async () => {
      const organic = await schemeNamed("Organic held")
      const other = await schemeNamed("Other scheme")
      const atField = async (body: unknown, path: string, message: string | RegExp) => {
        const problem = await refused(await lars("/service-provider-activities", { method: "POST", body }), 400)
        assert.equal(problem.errors?.[0]?.path, path, JSON.stringify(problem))
        if (typeof message === "string") assert.equal(problem.errors?.[0]?.message, message)
        else assert.match(problem.errors?.[0]?.message ?? "", message)
      }
      await atField(proposalBody(organic, { collectionGroupId: other.collectionGroups[0].id }), "collectionGroupId", NOT_A_GROUP_OF_THE_SCHEME)
      await atField(proposalBody(organic, { serviceDays: ["tuesday"] }), "serviceDays", SAME_DAYS)
      await atField(proposalBody(organic, { effectiveFrom: "2026-10-10" }), "effectiveFrom", appliesFromTomorrow(TOMORROW))
      await atField(proposalBody(organic, { serviceProviderId: a.serviceProviders.cityhaul.id }), "serviceProviderId", notOwnProvider("NordRen ApS"))
      // NordRen's award ends with 2026: a change from 2027 is about a scheme it would no longer serve.
      const unserved = await refused(await lars("/service-provider-activities", { method: "POST", body: proposalBody(organic, { effectiveFrom: "2027-01-05" }) }), 409)
      assert.equal(unserved.detail, notServed("NordRen ApS", "2027-01-05"))
      // The office proposes for NordRen under the same rule, and CityHaul serves nothing in Centrum.
      const cityhauls = await refused(await olivia("/service-provider-activities", { method: "POST", body: proposalBody(organic, { serviceProviderId: a.serviceProviders.cityhaul.id }) }), 400)
      assert.equal(cityhauls.errors?.[0]?.path, "serviceProviderId", "CityHaul holds no Service Area in the project")
    })

    test("only the office decides it: Lars is refused, and a desk that writes no scheme is refused at the scheme's grant", async () => {
      const organic = await schemeNamed("Organic undecided")
      const proposal = await open(lars, proposalBody(organic))
      assert.equal((await refused(await commanded(lars, proposal.id, "approve"), 403)).detail, OFFICE_DECIDES)
      assert.equal((await refused(await commanded(lars, proposal.id, "reject", { reason: "No" }), 403)).detail, OFFICE_DECIDES)
      assert.match((await refused(await commanded(desk, proposal.id, "approve"), 403)).detail ?? "", /create on route-studio\.schemes/)
      assert.equal((await read(olivia, proposal.id)).status, "pending-approval")
    })

    test("the office approves it: the scheme's next version from the day, the group on Wednesday, and the activity names it", async () => {
      const organic = await schemeNamed("Organic approved")
      const proposal = await open(lars, proposalBody(organic))
      const approved = ServiceProviderActivity.parse(await ok(await commanded(olivia, proposal.id, "approve", { reason: "Agreed with the market's organisers." })))
      assert.equal(approved.status, "approved")
      assert.equal(approved.closedBy, a.users.olivia.id)
      assert.equal(approved.closeReason, "Agreed with the market's organisers.")
      assert.ok(approved.successorSchemeId)

      const predecessor = await scheme(organic.id)
      assert.equal(predecessor.validTo, FROM, "the predecessor ends where the change applies")
      assert.deepEqual(predecessor.collectionGroups[0].days, ["tuesday"], "its history stays as it ran")
      const successor = await scheme(approved.successorSchemeId)
      assert.equal(successor.name, organic.name)
      assert.equal(successor.validFrom, FROM)
      assert.deepEqual(successor.serviceDays, ["wednesday"])
      assert.deepEqual(
        successor.collectionGroups.map((group) => [group.name, group.days]),
        [["Organic", ["wednesday"]]],
      )
      // Decided once: nothing moves it again.
      assert.equal((await refused(await commanded(olivia, proposal.id, "reject", { reason: "Changed mind" }), 409)).detail, `ACT-${proposal.number} is approved; reject takes one pending approval`)
    })

    test("a refusal of the scheme's own refuses the approval and leaves the proposal pending", async () => {
      const organic = await schemeNamed("Organic dispatched")
      const proposal = await open(lars, proposalBody(organic))
      // A route of the predecessor already dispatched on the day: the new version would plan that collection again.
      const ready = await seedRoute(pool, a, fleet, { ...ex, schemes: { ...ex.schemes, copenhagen: { id: organic.id } } }, { operatingDate: FROM, status: "ready", plannedDriverId: fleet.drivers.mads.id })
      const problem = await refused(await commanded(olivia, proposal.id, "approve"), 409)
      assert.equal(problem.detail, `ACT-${proposal.number} cannot be approved: ${dispatchedFrom([ready.label], FROM)}`)
      assert.equal((await read(olivia, proposal.id)).status, "pending-approval")
      // The fixture's route stands on a group of its own with no rule, which the resource's schema refuses: the period is read as the API wrote it.
      assert.equal(((await ok(await olivia(`/route-schemes/${organic.id}`))) as { validTo: string | null }).validTo, null, "nothing was written")
    })

    test("a rejection says why; Lars withdraws his own", async () => {
      const organic = await schemeNamed("Organic rejected")
      const first = await open(lars, proposalBody(organic))
      assert.equal((await refused(await commanded(olivia, first.id, "reject"), 400)).errors?.[0]?.path, "reason")
      const rejected = ServiceProviderActivity.parse(await ok(await commanded(olivia, first.id, "reject", { reason: "Wednesday clashes with the glass round." })))
      assert.equal(rejected.status, "rejected")
      assert.equal(rejected.closeReason, "Wednesday clashes with the glass round.")
      assert.equal(rejected.successorSchemeId, null)

      const second = await open(lars, proposalBody(organic))
      const withdrawn = ServiceProviderActivity.parse(await ok(await commanded(lars, second.id, "withdraw")))
      assert.equal(withdrawn.status, "withdrawn")
      assert.equal(withdrawn.closedBy, larsId)
      assert.equal((await scheme(organic.id)).validTo, null, "neither touched the scheme")
    })

    test("is corrected while pending, in its own members alone", async () => {
      const organic = await schemeNamed("Organic corrected")
      const proposal = await open(lars, proposalBody(organic))
      const moved = ServiceProviderActivity.parse(await ok(await lars(`/service-provider-activities/${proposal.id}`, { method: "PATCH", body: { serviceDays: ["thursday"], effectiveFrom: "2026-10-27" } })))
      assert.deepEqual(moved.serviceDays, ["thursday"])
      assert.equal(moved.effectiveFrom, "2026-10-27")
      const foreign = await refused(await lars(`/service-provider-activities/${proposal.id}`, { method: "PATCH", body: { dueOn: "2026-11-01" } }), 400)
      assert.deepEqual(foreign.errors, [{ path: "dueOn", message: KIND_CARRIES_NOT }])
      assert.equal((await refused(await lars(`/service-provider-activities/${proposal.id}`, { method: "PATCH", body: { serviceDays: ["tuesday"] } }), 400)).errors?.[0]?.message, SAME_DAYS)
      await ok(await commanded(lars, proposal.id, "withdraw"))
      await refused(await lars(`/service-provider-activities/${proposal.id}`, { method: "PATCH", body: { subject: "Too late" } }), 409)
    })
  })

  describe("a vehicle change (#474, part 2)", () => {
    const vehicleBody = (scheme: RouteScheme, values: Record<string, unknown> = {}) => ({
      kind: "vehicle-change",
      projectId: a.projects.copenhagen.id,
      serviceProviderId: a.serviceProviders.nordren.id,
      subject: "Organic round on NordRen's own truck",
      routeSchemeId: scheme.id,
      collectionGroupId: scheme.collectionGroups[0].id,
      vehicleId: fleet.vehicles.wh25.id,
      effectiveFrom: FROM,
      ...values,
    })

    test("Lars proposes his own truck; another's or a trailer is refused at the field, and the office may name any of the project's", async () => {
      const organic = await schemeNamed("Organic crew")
      const proposal = await open(lars, vehicleBody(organic))
      assert.equal(proposal.kind, "vehicle-change")
      assert.equal(proposal.status, "pending-approval")
      assert.equal(proposal.vehicleId, fleet.vehicles.wh25.id)
      assert.equal(proposal.driverId, null)
      const atVehicle = async (call: Call, body: unknown) => (await refused(await call("/service-provider-activities", { method: "POST", body }), 400)).errors?.[0]
      assert.deepEqual(await atVehicle(lars, vehicleBody(organic, { vehicleId: fleet.vehicles.wh24.id })), { path: "vehicleId", message: notOwnFleet("vehicle", "NordRen ApS") })
      assert.deepEqual(await atVehicle(lars, vehicleBody(organic, { vehicleId: fleet.vehicles.trailer.id })), { path: "vehicleId", message: NOT_A_POWERED_VEHICLE })
      assert.equal((await open(olivia, vehicleBody(organic, { vehicleId: fleet.vehicles.wh24.id }))).vehicleId, fleet.vehicles.wh24.id)
    })

    test("must move the crew", async () => {
      const crewed = await schemeNamed("Organic crewed", { collectionGroups: [{ name: "Organic", days: ["tuesday"], stopSource: "rule", rule: { wasteFractionIds: [ex.fractions.residual.id], containerTypeIds: [], vehicleTypeId: null }, vehicleId: fleet.vehicles.wh25.id }] })
      const problem = await refused(await lars("/service-provider-activities", { method: "POST", body: vehicleBody(crewed) }), 400)
      assert.deepEqual(problem.errors, [{ path: "vehicleId", message: SAME_CREW }])
    })

    test("the office approves it: the next version's group runs with the proposed truck from the day", async () => {
      const organic = await schemeNamed("Organic recrewed")
      const proposal = await open(lars, vehicleBody(organic))
      const approved = ServiceProviderActivity.parse(await ok(await commanded(olivia, proposal.id, "approve")))
      assert.equal(approved.status, "approved")
      assert.ok(approved.successorSchemeId)
      const successor = await scheme(approved.successorSchemeId)
      assert.equal(successor.validFrom, FROM)
      assert.deepEqual(successor.serviceDays, ["tuesday"], "a vehicle change moves no day")
      assert.deepEqual(successor.collectionGroups.map((group) => [group.name, group.days, group.vehicleId]), [["Organic", ["tuesday"], fleet.vehicles.wh25.id]])
      assert.equal((await scheme(organic.id)).collectionGroups[0].vehicleId, null, "the predecessor ran as it was")
    })

    test("is corrected in its own members: the truck, never the days", async () => {
      const organic = await schemeNamed("Organic corrected crew")
      const proposal = await open(olivia, vehicleBody(organic, { vehicleId: fleet.vehicles.wh24.id }))
      const moved = ServiceProviderActivity.parse(await ok(await olivia(`/service-provider-activities/${proposal.id}`, { method: "PATCH", body: { vehicleId: fleet.vehicles.wh25.id } })))
      assert.equal(moved.vehicleId, fleet.vehicles.wh25.id)
      assert.deepEqual((await refused(await olivia(`/service-provider-activities/${proposal.id}`, { method: "PATCH", body: { serviceDays: ["monday"] } }), 400)).errors, [{ path: "serviceDays", message: KIND_CARRIES_NOT }])
    })
  })

  describe("a compliance follow-up", () => {
    test("is the office's to raise and to close; NordRen reads it", async () => {
      const followUpBody = { kind: "compliance-follow-up", projectId: a.projects.copenhagen.id, serviceProviderId: a.serviceProviders.nordren.id, subject: "Liability insurance renewal", dueOn: "2026-11-12" }
      assert.equal((await refused(await lars("/service-provider-activities", { method: "POST", body: followUpBody }), 403)).detail, OFFICE_RAISES_FOLLOW_UPS)
      const followUp = await open(olivia, followUpBody)
      assert.equal(followUp.status, "open")
      assert.equal((await read(lars, followUp.id)).subject, "Liability insurance renewal")
      assert.equal((await refused(await commanded(lars, followUp.id, "complete"), 403)).detail, OFFICE_CLOSES_FOLLOW_UPS)
      await refused(await lars(`/service-provider-activities/${followUp.id}`, { method: "PATCH", body: { dueOn: "2026-12-01" } }), 403)
      assert.equal((await refused(await commanded(olivia, followUp.id, "approve"), 409)).detail, `ACT-${followUp.number} is a compliance follow-up; approve takes a proposal`)
      const completed = ServiceProviderActivity.parse(await ok(await commanded(olivia, followUp.id, "complete", { reason: "Certificate received." })))
      assert.equal(completed.status, "completed")
    })
  })

  describe("a coordination note", () => {
    test("either side opens it and either completes it", async () => {
      const note = await open(lars, { kind: "coordination-note", projectId: a.projects.copenhagen.id, serviceProviderId: a.serviceProviders.nordren.id, subject: "Harbour gate closed Friday" })
      assert.equal(note.status, "open")
      assert.equal(ServiceProviderActivity.parse(await ok(await commanded(olivia, note.id, "complete"))).status, "completed")
      assert.equal((await refused(await commanded(lars, note.id, "complete"), 409)).detail, `ACT-${note.number} is completed; complete takes one open`)
    })
  })

  describe("the reach", () => {
    test("each side reads its own: the office its projects', NordRen its own, CityHaul none of NordRen's", async () => {
      const note = await open(lars, { kind: "coordination-note", projectId: a.projects.copenhagen.id, serviceProviderId: a.serviceProviders.nordren.id, subject: "Reach" })
      const ids = async (call: Call, query = "") => ActivityPage.parse(await ok(await call(`/service-provider-activities?limit=200${query}`))).items.map((item) => item.id)
      assert.ok((await ids(olivia)).includes(note.id))
      assert.ok((await ids(lars)).includes(note.id))
      assert.ok((await ids(lars, `&projectId=${a.projects.copenhagen.id}&kind=coordination-note`)).includes(note.id), "a provider narrows by a project it works in none of")
      assert.deepEqual(await ids(mikkel), [])
      await refused(await mikkel(`/service-provider-activities/${note.id}`), 404)
      await refused(await commanded(mikkel, note.id, "complete"), 404)
      const others = (await ok(await lars(`/service-provider-activities?limit=200`))) as { items: ServiceProviderActivity[] }
      assert.ok(others.items.every((item) => item.serviceProviderId === a.serviceProviders.nordren.id))
    })

    test("its history is the audit log of its row, the reason the office gave on the header included", async () => {
      const note = await open(olivia, { kind: "coordination-note", projectId: a.projects.copenhagen.id, serviceProviderId: a.serviceProviders.nordren.id, subject: "History" })
      await ok(await olivia(`/service-provider-activities/${note.id}/complete`, { method: "POST", body: {}, headers: { "Waste-Change-Reason": "Talked%20it%20through" } }))
      const history = AuditEventPage.parse(await ok(await olivia(`/audit-events?table=service_provider_activity&rowId=${note.id}`)))
      assert.deepEqual(
        history.items.map((event) => event.action),
        ["update", "insert"],
        "newest first",
      )
      assert.equal(history.items[0].reason, "Talked it through")
    })
  })
})
