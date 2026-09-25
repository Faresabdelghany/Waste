// The Resolution tables against Postgres (Issue #109, slice 1), on a fresh
// database of this file's own so that "migration 0009 applies to a clean
// database" is proved — the second `ALTER TABLE company` and the outbox's
// replaced checks included — and nothing depends on what the shared local
// database holds: the composite keys refuse another company's customer,
// agreement and account and another project's route, pickup, property,
// container, driver and parent ticket, and a pickup of another route of the
// same project; each shape check refuses its pair; the history's CASE agrees
// with the domain's `ticketEventShape` on every kind with each column set and
// unset; the API role can append to the history and update or delete nothing
// there while the owner can; the two partial uniques hold one ticket and one
// comment per outbox event with a null passing both; the counter's `update …
// returning` answers disjoint numbers under two concurrent transactions; and
// the fence shows the API role exactly its company's rows in each of the
// three. Every test but the counter's runs as the owner in a transaction that
// is rolled back, so nothing needs cleaning up; the counter's commits, and the
// database is dropped after.
import assert from "node:assert/strict"
import { performance } from "node:perf_hooks"
import { after, before, describe, test } from "node:test"

import type { Point } from "@waste/contracts/geojson"
import { TICKET_EVENT_SHAPES, ticketEventShape, type TicketEventRow } from "@waste/domain/resolution/event-shapes"
import { TICKET_EVENT_KINDS, TICKET_STATUSES, TICKET_VISIBILITIES, type TicketEventKind, type TicketStatus } from "@waste/domain/resolution/vocabulary"
import { and, eq, getTableName, sql } from "drizzle-orm"
import type { PgTable } from "drizzle-orm/pg-core"

import { createDb, type Database, type Tx } from "../client"
import { migrateDatabase } from "../migrate"
import { API_ROLE } from "../roles"
import { role, userAccount } from "../schema/access"
import { agreement } from "../schema/agreements"
import { containerType, wasteFraction } from "../schema/catalogue"
import { container } from "../schema/containers"
import { customer, property, sharedCollectionPoint } from "../schema/customers"
import { outboxEvent, pickup, route } from "../schema/execution"
import { driver, vehicle } from "../schema/fleet"
import { vehicleType } from "../schema/fleet-types"
import { company, project } from "../schema/organisation"
import { depot } from "../schema/places"
import { alert, ticket, ticketEvent } from "../schema/resolution"
import { collectionGroup, routeScheme } from "../schema/route-schemes"
import { withCompany } from "../tenant"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"
import { refusedWith, rolledBack, rolledBackIn } from "./specimen"

const database = databaseUnderTest()

/** One company's fixture ids, a nibble telling the companies apart; this file's own bucket, on its own database. */
const ids = (n: "a" | "b") => ({
  company: `018f7c33-${n}000-7000-8000-000000000001`,
  project: `018f7c33-${n}000-7000-8000-000000000002`,
  role: `018f7c33-${n}000-7000-8000-000000000003`,
  account: `018f7c33-${n}000-7000-8000-000000000004`,
  /** A second account of the same company, for the assignee. */
  secondAccount: `018f7c33-${n}000-7000-8000-000000000005`,
  wasteFraction: `018f7c33-${n}000-7000-8000-000000000006`,
  containerType: `018f7c33-${n}000-7000-8000-000000000007`,
  container: `018f7c33-${n}000-7000-8000-000000000008`,
  customer: `018f7c33-${n}000-7000-8000-000000000009`,
  property: `018f7c33-${n}000-7000-8000-00000000000a`,
  point: `018f7c33-${n}000-7000-8000-00000000000b`,
  agreement: `018f7c33-${n}000-7000-8000-00000000000c`,
  vehicleType: `018f7c33-${n}000-7000-8000-00000000000d`,
  depot: `018f7c33-${n}000-7000-8000-00000000000e`,
  vehicle: `018f7c33-${n}000-7000-8000-00000000000f`,
  driver: `018f7c33-${n}000-7000-8000-000000000010`,
  scheme: `018f7c33-${n}000-7000-8000-000000000011`,
  group: `018f7c33-${n}000-7000-8000-000000000012`,
  route: `018f7c33-${n}000-7000-8000-000000000013`,
  /** A second route of the same group, on another day, with a pickup of its own. */
  secondRoute: `018f7c33-${n}000-7000-8000-000000000014`,
  pickup: `018f7c33-${n}000-7000-8000-000000000015`,
  secondPickup: `018f7c33-${n}000-7000-8000-000000000016`,
  ticket: `018f7c33-${n}000-7000-8000-000000000017`,
  event: `018f7c33-${n}000-7000-8000-000000000018`,
  alert: `018f7c33-${n}000-7000-8000-000000000019`,
  /** An outbox event's id a consumer's ticket names: a soft uuid, nothing has to exist under it. */
  outbox: `018f7c33-${n}000-7000-8000-00000000001a`,
  /** Free for a test's own rows. */
  spare: `018f7c33-${n}000-7000-8000-0000000000e1`,
  other: `018f7c33-${n}000-7000-8000-0000000000e2`,
  third: `018f7c33-${n}000-7000-8000-0000000000e3`,
  fourth: `018f7c33-${n}000-7000-8000-0000000000e4`,
  /** A second project of the same company, with rows of its own that a record of the first may not name. */
  harbor: `018f7c33-${n}000-7000-8000-0000000000f1`,
  harborProperty: `018f7c33-${n}000-7000-8000-0000000000f2`,
  harborContainer: `018f7c33-${n}000-7000-8000-0000000000f3`,
  harborDriver: `018f7c33-${n}000-7000-8000-0000000000f4`,
  harborVehicle: `018f7c33-${n}000-7000-8000-0000000000f5`,
  harborScheme: `018f7c33-${n}000-7000-8000-0000000000f6`,
  harborGroup: `018f7c33-${n}000-7000-8000-0000000000f7`,
  harborRoute: `018f7c33-${n}000-7000-8000-0000000000f8`,
  harborPickup: `018f7c33-${n}000-7000-8000-0000000000f9`,
  harborTicket: `018f7c33-${n}000-7000-8000-0000000000fa`,
  harborAgreement: `018f7c33-${n}000-7000-8000-0000000000fb`,
})
const a = ids("a")
const b = ids("b")

const NORDHAVN: Point = { type: "Point", coordinates: [12.5951, 55.7089] }
const OPENED = "2026-01-01"
const DAY = "2026-10-05"
/** A morning shift and the instants around it. */
const at = (hour: number, minute = 0): Date => new Date(Date.UTC(2026, 9, 5, hour, minute))

const tables: Record<string, PgTable> = { ticket, ticketEvent, alert }

/** A company with what the other contexts lend it, and one row in each Resolution table — an open ticket about a failed stop with its created row, and a new alert about the route — inserted as the owner in dependency order. */
async function seed(tx: Tx, n: "a" | "b"): Promise<void> {
  const own = ids(n)
  const tenant = { companyId: own.company }
  const scoped = { ...tenant, projectId: own.project }
  await tx.insert(company).values({ id: own.company, ...tenant, name: `Company ${n}`, legalName: `Company ${n} A/S`, registrationNumber: `1000000${n}`, country: "DK", status: "active" })
  await tx.insert(project).values({ id: own.project, ...tenant, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
  await tx.insert(role).values({ id: own.role, ...tenant, name: "Dispatcher", scope: "Company", description: "Dispatches", system: false })
  await tx.insert(userAccount).values([
    { id: own.account, ...tenant, email: `sofie@${n}.example`, fullName: "Sofie Nielsen", roleId: own.role },
    { id: own.secondAccount, ...tenant, email: `mads@${n}.example`, fullName: "Mads Jensen", roleId: own.role },
  ])
  await tx.insert(wasteFraction).values({ id: own.wasteFraction, ...tenant, key: "residual", name: "Residual waste" })
  await tx.insert(containerType).values({ id: own.containerType, ...tenant, name: "240 L bin", volumeLitres: 240 })
  await tx.insert(container).values({ id: own.container, ...scoped, label: "BIN-82014", containerTypeId: own.containerType, ownership: "company" })
  await tx.insert(customer).values({ id: own.customer, ...tenant, kind: "organisation", name: "Parkvej Boligforening", registrationNumber: `3000000${n}`, email: `post@${n}.example`, status: "active" })
  await tx.insert(property).values({ id: own.property, ...scoped, name: "Parkvej 18", address: "Parkvej 18", kind: "residential", status: "active", location: NORDHAVN })
  await tx.insert(sharedCollectionPoint).values({ id: own.point, ...scoped, name: "Miljøstation Nord", kind: "surface", address: "Parkvej 20", location: NORDHAVN, operatingModel: "municipal", accessMode: "open", billingMode: "municipal", status: "open" })
  await tx.insert(agreement).values({ id: own.agreement, ...scoped, validFrom: OPENED, number: "AGR-2408", customerId: own.customer, payerCustomerId: own.customer, status: "active", billingCadence: "monthly", currency: "DKK" })
  await tx.insert(vehicleType).values({ id: own.vehicleType, ...tenant, key: "rear-loader", name: "Rear loader" })
  await tx.insert(depot).values({ id: own.depot, ...scoped, code: "DEP-NORD", name: "Nordhavn", address: "Sundkrogsgade 1", location: NORDHAVN, ownership: "company", status: "active" })
  await tx.insert(vehicle).values({ id: own.vehicle, ...scoped, registration: `CN 42 01${n === "a" ? 8 : 9}`, callsign: "WH-24", kind: "powered-vehicle", vehicleTypeId: own.vehicleType, ownership: "company", status: "active", requiredLicenceClass: "c", homeDepotId: own.depot })
  await tx.insert(driver).values({ id: own.driver, ...scoped, name: "Mads Jensen", employment: "employee", licenceClass: "ce", userAccountId: own.secondAccount, status: "active", homeDepotId: own.depot })
  await tx.insert(routeScheme).values({ id: own.scheme, ...scoped, validFrom: OPENED, name: "Residual weekly", serviceType: "container-collection", frequency: "weekly", serviceDays: ["monday"], plannedStartTime: "06:30", depotId: own.depot })
  await tx.insert(collectionGroup).values({ id: own.group, ...scoped, routeSchemeId: own.scheme, name: "Rear loaders", position: 1, days: ["monday"], stopSource: "rule", ruleVehicleTypeId: own.vehicleType, vehicleId: own.vehicle, driverId: own.driver })
  await tx.insert(route).values([
    { id: own.route, ...scoped, routeSchemeId: own.scheme, collectionGroupId: own.group, serviceDate: DAY, operatingDate: DAY, status: "completed", number: n === "a" ? 1042 : 1043, plannedVehicleId: own.vehicle, plannedDriverId: own.driver, depotId: own.depot, actualVehicleId: own.vehicle, actualDriverId: own.driver, dispatchedAt: at(5), startedAt: at(6), completedAt: at(14) },
    { id: own.secondRoute, ...scoped, routeSchemeId: own.scheme, collectionGroupId: own.group, serviceDate: "2026-10-12", operatingDate: "2026-10-12", number: n === "a" ? 1044 : 1045, plannedDriverId: own.driver, plannedVehicleId: own.vehicle },
  ])
  await tx.insert(pickup).values([
    { id: own.pickup, ...scoped, routeId: own.route, containerId: own.container, position: 1, propertyId: own.property, wasteFractionId: own.wasteFraction, status: "failed", reason: "inaccessible", outcomeAt: at(6, 25) },
    { id: own.secondPickup, ...scoped, routeId: own.secondRoute, containerId: own.container, position: 1, propertyId: own.property, wasteFractionId: own.wasteFraction },
  ])
  await tx.insert(ticket).values({
    id: own.ticket,
    ...scoped,
    number: n === "a" ? 8831 : 8832,
    kind: "missed-collection",
    priority: "high",
    source: "office",
    subject: "Missed collection: BIN-82014 at Parkvej 18",
    description: "The driver could not collect this stop. Reason: inaccessible.",
    occurredAt: at(6, 25),
    createdBy: own.account,
    routeId: own.route,
    pickupId: own.pickup,
    containerId: own.container,
    propertyId: own.property,
    customerId: own.customer,
    agreementId: own.agreement,
    driverId: own.driver,
  })
  await tx.insert(ticketEvent).values({ id: own.event, ...scoped, ticketId: own.ticket, kind: "created", status: "open", recordedBy: own.account })
  await tx.insert(alert).values({ id: own.alert, ...scoped, kind: "route-exception", severity: "high", source: "manual", title: "Route RC-1042 ended with a stop uncollected", details: "One failed pickup at Parkvej 18", detectedAt: at(14), routeId: own.route, raisedBy: own.account })
}

/** A second project of company a, with a property, a container, a driver, a vehicle, a route with a pickup, an agreement and a ticket of its own. */
async function seedHarbor(tx: Tx): Promise<void> {
  const scoped = { companyId: a.company, projectId: a.harbor }
  await tx.insert(project).values({ id: a.harbor, companyId: a.company, name: "Harbor", kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
  await tx.insert(property).values({ id: a.harborProperty, ...scoped, name: "Havnegade 2", address: "Havnegade 2", kind: "commercial", status: "active" })
  await tx.insert(container).values({ id: a.harborContainer, ...scoped, label: "BIN-90001", containerTypeId: a.containerType, ownership: "company" })
  await tx.insert(driver).values({ id: a.harborDriver, ...scoped, name: "Jonas Lind", employment: "employee", licenceClass: "ce", status: "active" })
  await tx.insert(vehicle).values({ id: a.harborVehicle, ...scoped, registration: "CN 99 001", kind: "powered-vehicle", vehicleTypeId: a.vehicleType, ownership: "company", status: "active", requiredLicenceClass: "c" })
  await tx.insert(routeScheme).values({ id: a.harborScheme, ...scoped, validFrom: OPENED, name: "Harbor weekly", serviceType: "container-collection", frequency: "weekly", serviceDays: ["tuesday"] })
  await tx.insert(collectionGroup).values({ id: a.harborGroup, ...scoped, routeSchemeId: a.harborScheme, name: "Harbor", position: 1, days: ["tuesday"], stopSource: "rule" })
  await tx.insert(route).values({ id: a.harborRoute, ...scoped, routeSchemeId: a.harborScheme, collectionGroupId: a.harborGroup, serviceDate: "2026-10-06", operatingDate: "2026-10-06", number: 1050 })
  await tx.insert(pickup).values({ id: a.harborPickup, ...scoped, routeId: a.harborRoute, containerId: a.harborContainer, position: 1, propertyId: a.harborProperty, wasteFractionId: a.wasteFraction })
  await tx.insert(agreement).values({ id: a.harborAgreement, ...scoped, validFrom: OPENED, number: "AGR-3000", customerId: a.customer, payerCustomerId: a.customer, status: "active", billingCadence: "monthly", currency: "DKK" })
  await tx.insert(ticket).values({ id: a.harborTicket, ...scoped, number: 9000, kind: "internal-task", source: "office", subject: "Check the harbor gate", description: "The gate code changed", occurredAt: at(9), createdBy: a.account })
}

/** A sound open ticket of company a's first project, an internal task about nothing, but for what a test overrides. */
const opened = (values: Partial<typeof ticket.$inferInsert>): typeof ticket.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  number: 8900,
  kind: "internal-task",
  source: "office",
  subject: "Call the customer back",
  description: "About the container request",
  occurredAt: at(9),
  createdBy: a.account,
  ...values,
})

/** A sound comment on company a's ticket, but for what a test overrides. */
const comment = (values: Partial<typeof ticketEvent.$inferInsert>): typeof ticketEvent.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  ticketId: a.ticket,
  kind: "comment",
  status: "open",
  body: "Called the customer",
  recordedBy: a.account,
  ...values,
})

/** A sound new alert about company a's vehicle, but for what a test overrides. */
const raised = (values: Partial<typeof alert.$inferInsert>): typeof alert.$inferInsert => ({
  id: a.spare,
  companyId: a.company,
  projectId: a.project,
  kind: "resource",
  severity: "medium",
  source: "manual",
  title: "WH-24 due for service",
  details: "The workshop wants it Friday",
  detectedAt: at(10),
  vehicleId: a.vehicle,
  raisedBy: a.account,
  ...values,
})

describe("the Resolution tables against a fresh database", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_resolution")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 3 })
  })
  after(async () => {
    await owner?.close()
    await fresh?.drop()
  })

  /** The two companies seeded as the owner in a transaction that is rolled back. */
  const seeded = <T>(fn: (tx: Tx) => Promise<T>): Promise<T> =>
    rolledBack(owner.db, async (tx) => {
      await seed(tx, "a")
      await seed(tx, "b")
      return fn(tx)
    })

  test("0009 created the three tables in wms, each fenced, two with the updated_at trigger and the ledger with none, gave company its second counter at 1000, and grew the outbox's checks", async () => {
    const names = Object.values(tables).map(getTableName).sort()
    assert.deepEqual(names, ["alert", "ticket", "ticket_event"])
    const rows = await owner.sql<{ table: string; enabled: boolean; forced: boolean; policies: string[]; triggers: string[] | null }[]>`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
        (select array_agg(p.policyname order by p.policyname) from pg_policies p where p.schemaname = 'wms' and p.tablename = c.relname) as policies,
        (select array_agg(t.tgname order by t.tgname) from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal) as triggers
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'wms' and c.relkind = 'r' and c.relname = any (${names}::text[])
      order by c.relname`
    assert.deepEqual(
      rows.map(({ table, enabled, forced, policies, triggers }) => ({ table, enabled, forced, policies, triggers })),
      names.map((table) => ({ table, enabled: true, forced: true, policies: [`${table}_tenant_fence`], triggers: table === "ticket_event" ? null : [`${table}_touch_updated_at`] })),
    )
    const counters = await owner.sql<{ column: string; default: string; nullable: string }[]>`select column_name as column, column_default as default, is_nullable as nullable from information_schema.columns where table_schema = 'wms' and table_name = 'company' and column_name like 'next_%' order by column_name`
    assert.deepEqual(
      [...counters],
      [
        { column: "next_route_number", default: "1000", nullable: "NO" },
        { column: "next_ticket_number", default: "1000", nullable: "NO" },
      ],
    )
    const [outbox] = await owner.sql<{ kinds: string; aggregates: string }[]>`
      select (select pg_get_constraintdef(oid) from pg_constraint where conname = 'outbox_event_kind_one_of') as kinds,
             (select pg_get_constraintdef(oid) from pg_constraint where conname = 'outbox_event_aggregate_kind_one_of') as aggregates`
    assert.match(outbox.kinds, /'ticket-opened'.*'ticket-completed'.*'ticket-rejected'/)
    assert.match(outbox.aggregates, /'ticket'/)
  })

  test("and left the API role able to insert into the history and to update or delete nothing there, while the owner keeps every right and the case and the alert stay updatable", async () => {
    const rows = await owner.sql<{ relation: string; rolename: string; privilege: string; granted: boolean }[]>`
      select t.relation, r.rolename, p.privilege, has_table_privilege(r.rolename::name, ('wms.' || t.relation)::regclass, p.privilege) as granted
      from (values ('ticket'), ('ticket_event'), ('alert')) as t(relation),
           (values (${API_ROLE}::text), (current_user::text)) as r(rolename),
           (values ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE')) as p(privilege)
      order by t.relation, r.rolename, p.privilege`
    assert.equal(rows.length, 24)
    const denied = rows.filter((row) => !row.granted).map((row) => `${row.rolename} ${row.privilege} ${row.relation}`)
    assert.deepEqual(denied.sort(), [`${API_ROLE} DELETE ticket_event`, `${API_ROLE} UPDATE ticket_event`])
  })

  /** Row counts per table as the transaction currently sees them. */
  const counts = async (tx: Tx): Promise<Record<string, number>> => {
    const seen: Record<string, number> = {}
    for (const [name, table] of Object.entries(tables)) {
      const [{ count }] = await tx.execute<{ count: number }>(sql`select count(*)::int as count from ${table}`)
      seen[name] = count
    }
    return seen
  }

  /** Both companies seeded as the owner inside `withCompany`, then the transaction becomes the API role. */
  const asCompany = <T>(companyId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    rolledBackIn(
      (body) => withCompany(owner.db, companyId, body),
      async (tx) => {
        await seed(tx, "a")
        await seed(tx, "b")
        // Role settings apply at login, not at SET ROLE: the API role's search path is set by hand.
        await tx.execute(sql`set local role ${sql.raw(API_ROLE)}`)
        await tx.execute(sql`set local search_path = wms, extensions`)
        return fn(tx)
      },
    )

  test("under withCompany as the API role, each of the three tables shows the company's rows and nothing of another company's", async () => {
    const seenByA = await asCompany(a.company, async (tx) => ({
      counts: await counts(tx),
      tickets: (await tx.select({ id: ticket.id, number: ticket.number }).from(ticket)).map((row) => [row.id, row.number]),
      events: (await tx.select({ ticketId: ticketEvent.ticketId }).from(ticketEvent)).map((row) => row.ticketId),
    }))
    assert.deepEqual(seenByA, { counts: { ticket: 1, ticketEvent: 1, alert: 1 }, tickets: [[a.ticket, 8831]], events: [a.ticket] })
    const seenByB = await asCompany(b.company, async (tx) => ({
      counts: await counts(tx),
      tickets: (await tx.select({ id: ticket.id, number: ticket.number }).from(ticket)).map((row) => [row.id, row.number]),
    }))
    assert.deepEqual(seenByB, { counts: { ticket: 1, ticketEvent: 1, alert: 1 }, tickets: [[b.ticket, 8832]] })
  })

  test("as the API role, a history row can be appended and neither updated nor deleted (42501); the owner may do both; the case and the alert are updated", () =>
    asCompany(a.company, async (tx) => {
      await tx.insert(ticketEvent).values(comment({}))
      await assert.rejects(tx.transaction((savepoint) => savepoint.update(ticketEvent).set({ body: "rewritten" }).where(eq(ticketEvent.id, a.spare))), refusedWith("42501", /permission denied for table ticket_event/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.delete(ticketEvent).where(eq(ticketEvent.id, a.spare))), refusedWith("42501", /permission denied for table ticket_event/))
      // The case and the alert are current state: the API role updates them, and the trigger moves updated_at.
      const [moved] = await tx.update(ticket).set({ status: "in-progress", assigneeUserAccountId: a.secondAccount }).where(eq(ticket.id, a.ticket)).returning({ status: ticket.status })
      assert.equal(moved.status, "in-progress")
      const [acknowledged] = await tx.update(alert).set({ status: "acknowledged", acknowledgedAt: at(15), acknowledgedBy: a.account }).where(eq(alert.id, a.alert)).returning({ status: alert.status })
      assert.equal(acknowledged.status, "acknowledged")
      // The owner keeps both rights, for tests and for erasure.
      await tx.execute(sql`reset role`)
      assert.equal((await tx.update(ticketEvent).set({ body: "rewritten" }).where(eq(ticketEvent.id, a.spare)).returning()).length, 1)
      assert.equal((await tx.delete(ticketEvent).where(eq(ticketEvent.id, a.spare)).returning()).length, 1)
    }))

  test("a ticket cannot name another company's customer, agreement or account (23503): every key carries the tenant", () =>
    seeded(async (tx) => {
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ customerId: b.customer }))), refusedWith("23503", /ticket_customer_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ agreementId: b.agreement }))), refusedWith("23503", /ticket_agreement_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ assigneeUserAccountId: b.account }))), refusedWith("23503", /ticket_assignee_user_account_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ createdBy: b.account }))), refusedWith("23503", /ticket_created_by_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticketEvent).values(comment({ recordedBy: b.account }))), refusedWith("23503", /ticket_event_recorded_by_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(alert).values(raised({ raisedBy: b.account }))), refusedWith("23503", /alert_raised_by_fk/))
      // The same rows land when every id they name is their own company's.
      await tx.insert(ticket).values(opened({ customerId: a.customer, agreementId: a.agreement, assigneeUserAccountId: a.secondAccount }))
    }))

  test("nor another project's route, pickup, property, container, driver or parent ticket of its own company (23503): every project-scoped key carries the project", () =>
    seeded(async (tx) => {
      await seedHarbor(tx)
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ routeId: a.harborRoute }))), refusedWith("23503", /ticket_route_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ routeId: a.route, pickupId: a.harborPickup }))), refusedWith("23503", /ticket_route_id_pickup_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ propertyId: a.harborProperty }))), refusedWith("23503", /ticket_property_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ containerId: a.harborContainer }))), refusedWith("23503", /ticket_container_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ driverId: a.harborDriver }))), refusedWith("23503", /ticket_driver_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ parentTicketId: a.harborTicket }))), refusedWith("23503", /ticket_parent_ticket_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ agreementId: a.harborAgreement }))), refusedWith("23503", /ticket_agreement_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ recollectionRouteId: a.harborRoute, status: "completed", resolution: "recollected", closedAt: at(16) }))), refusedWith("23503", /ticket_recollection_route_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticketEvent).values(comment({ ticketId: a.harborTicket }))), refusedWith("23503", /ticket_event_ticket_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(alert).values(raised({ vehicleId: a.harborVehicle }))), refusedWith("23503", /alert_vehicle_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(alert).values(raised({ routeId: a.harborRoute }))), refusedWith("23503", /alert_route_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(alert).values(raised({ driverId: a.harborDriver }))), refusedWith("23503", /alert_driver_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(alert).values(raised({ containerId: a.harborContainer }))), refusedWith("23503", /alert_container_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(alert).values(raised({ ticketId: a.harborTicket }))), refusedWith("23503", /alert_ticket_id_fk/))
      // The same rows land when every id they name is their own project's: a sub-case of the seeded ticket, about the same stop.
      await tx.insert(ticket).values(opened({ routeId: a.route, pickupId: a.pickup, propertyId: a.property, containerId: a.container, driverId: a.driver, parentTicketId: a.ticket, sharedCollectionPointId: a.point }))
      await tx.insert(alert).values(raised({ id: a.other, routeId: a.route, driverId: a.driver, containerId: a.container, ticketId: a.ticket }))
    }))

  test("a ticket names a pickup of the route it names and no other route's (23503): the key carries the route, and a pickup without a route is refused before the key can be asked (23514)", () =>
    seeded(async (tx) => {
      // The second pickup is the planned route's; the ticket names the completed one.
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ routeId: a.route, pickupId: a.secondPickup }))), refusedWith("23503", /ticket_route_id_pickup_id_fk/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ pickupId: a.pickup }))), refusedWith("23514", /ticket_pickup_shape/), "Postgres leaves a composite key with a null member unchecked, so the shape check says a pickup names its route")
      await tx.insert(ticket).values(opened({ routeId: a.secondRoute, pickupId: a.secondPickup }))
    }))

  test("a ticket is a person's or an event's, never both and never neither (23514 ticket_origin_shape); one ticket per outbox event (23505 ticket_source_event_id_idx), a null passing", () =>
    seeded(async (tx) => {
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ createdBy: a.account, sourceEventId: a.outbox }))), refusedWith("23514", /ticket_origin_shape/), "a person and an event")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ createdBy: null }))), refusedWith("23514", /ticket_origin_shape/), "neither")
      // The consumer's ticket: no person, the event's id, from the driver's device.
      await tx.insert(ticket).values(opened({ createdBy: null, sourceEventId: a.outbox, source: "driver-app", kind: "missed-collection", routeId: a.route, pickupId: a.pickup }))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ id: a.other, number: 8901, createdBy: null, sourceEventId: a.outbox, source: "driver-app" }))), refusedWith("23505", /ticket_source_event_id_idx/), "the same event delivered twice is one ticket")
      // The same event in another company is another company's ticket, and a null is not a duplicate of a null.
      await tx.insert(ticket).values(opened({ id: a.other, number: 8901, companyId: b.company, projectId: b.project, createdBy: null, sourceEventId: a.outbox, source: "driver-app" }))
      await tx.insert(ticket).values([opened({ id: a.third, number: 8902 }), opened({ id: a.fourth, number: 8903 })])
    }))

  test("the closing columns follow the status: a completed ticket has a resolution, a closed one its instant, a re-collection route goes with recollected, and a ticket is not its own parent (23514)", () =>
    seeded(async (tx) => {
      const refuse = (values: Partial<typeof ticket.$inferInsert>, constraint: RegExp, why: string) =>
        assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened(values))), refusedWith("23514", constraint), why)
      await refuse({ resolution: "answered" }, /ticket_resolution_shape/, "open with a resolution")
      await refuse({ status: "completed", closedAt: at(16) }, /ticket_resolution_shape/, "completed without one")
      await refuse({ status: "rejected", closedAt: at(16), resolution: "no-action" }, /ticket_resolution_shape/, "rejected with one: a rejection has a reason and no resolution")
      await refuse({ status: "completed", resolution: "answered" }, /ticket_closed_shape/, "completed without its instant")
      await refuse({ status: "rejected" }, /ticket_closed_shape/, "rejected without its instant")
      await refuse({ closedAt: at(16) }, /ticket_closed_shape/, "open with a closing instant")
      await refuse({ recollectionRouteId: a.secondRoute }, /ticket_recollection_shape/, "a re-collection route on an open ticket")
      await refuse({ status: "completed", closedAt: at(16), resolution: "serviced", recollectionRouteId: a.secondRoute }, /ticket_recollection_shape/, "a re-collection route with another resolution")
      await refuse({ parentTicketId: a.spare }, /ticket_parent_shape/, "its own parent")
      await refuse({ status: "created" as TicketStatus }, /ticket_status_one_of/, "the prototype's Created folds into open")
      await refuse({ source: "driver" }, /ticket_source_one_of/, "Execution spells the device driver-app")
      // The shapes that stand: completed with a re-collection, completed without one, rejected, and reopened with everything cleared.
      await tx.insert(ticket).values([
        opened({ id: a.spare, number: 8900, status: "completed", closedAt: at(16), resolution: "recollected", recollectionRouteId: a.secondRoute }),
        opened({ id: a.other, number: 8901, status: "completed", closedAt: at(16), resolution: "no-action" }),
        opened({ id: a.third, number: 8902, status: "rejected", closedAt: at(16) }),
      ])
      const [reopened] = await tx.update(ticket).set({ status: "open", resolution: null, recollectionRouteId: null, closedAt: null }).where(eq(ticket.id, a.spare)).returning({ status: ticket.status })
      assert.equal(reopened.status, "open")
    }))

  test("the history's kind CASE agrees with the domain's ticketEventShape over every kind with each column set and unset (23514 ticket_event_kind_shape)", () =>
    seeded(async (tx) => {
      /** The whole row for a kind: what the row says of the four columns, on a completed status. */
      const full = { body: "Re-collected on Friday", objectKey: `${a.company}/${a.ticket}/${a.spare}.jpg`, visibility: "customer", resolution: "recollected" } as const
      const exemplar = (kind: TicketEventKind): TicketEventRow => {
        const shape = TICKET_EVENT_SHAPES[kind]
        return {
          status: "in-progress",
          body: shape.body === "none" ? null : full.body,
          objectKey: shape.objectKey === "none" ? null : full.objectKey,
          visibility: "internal",
          resolution: null,
        }
      }
      /** Whether Postgres takes the row, judged in a savepoint that is always rolled back; the kind CASE is the one check a row shaped this way can trip. */
      const lands = async (kind: TicketEventKind, row: TicketEventRow): Promise<boolean> => {
        const attempt = tx.transaction(async (savepoint) => {
          await savepoint.insert(ticketEvent).values(comment({ kind, ...row }))
          throw new Landed()
        })
        try {
          await attempt
        } catch (error) {
          if (error instanceof Landed) return true
          refusedWith("23514", /ticket_event_kind_shape/)(error)
          return false
        }
        throw new Error("the savepoint returned instead of rolling back")
      }
      let rows = 0
      for (const kind of TICKET_EVENT_KINDS) {
        const variations: TicketEventRow[] = [exemplar(kind)]
        for (const column of ["body", "objectKey"] as const) variations.push({ ...exemplar(kind), [column]: full[column] }, { ...exemplar(kind), [column]: null })
        for (const visibility of TICKET_VISIBILITIES) variations.push({ ...exemplar(kind), visibility })
        for (const status of TICKET_STATUSES) variations.push({ ...exemplar(kind), status, resolution: full.resolution }, { ...exemplar(kind), status, resolution: null })
        for (const row of variations) {
          assert.equal(await lands(kind, row), ticketEventShape(kind, row), `${kind}: ${JSON.stringify(row)}`)
          rows += 1
        }
      }
      assert.equal(rows, 76, "four kinds, nineteen rows each")
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticketEvent).values(comment({ kind: "edited" }))), refusedWith("23514", /ticket_event_kind_one_of|ticket_event_kind_shape/), "the history of a field edit is the audit log's")
    }))

  test("one comment per outbox event (23505 ticket_event_source_event_id_idx), a null passing; the history reads in recording order through its index", () =>
    seeded(async (tx) => {
      // The consumer's comment: a rejection folded into the driver's open case, no person, the event's id.
      await tx.insert(ticketEvent).values(comment({ body: "Rejected command: Pickup 1 is already completed", recordedBy: null, sourceEventId: a.outbox }))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticketEvent).values(comment({ id: a.other, body: "the same rejection again", recordedBy: null, sourceEventId: a.outbox }))), refusedWith("23505", /ticket_event_source_event_id_idx/))
      await tx.insert(ticketEvent).values([comment({ id: a.other }), comment({ id: a.third, body: "And again", visibility: "customer" })])
      const history = await tx.select({ id: ticketEvent.id, kind: ticketEvent.kind }).from(ticketEvent).where(and(eq(ticketEvent.companyId, a.company), eq(ticketEvent.ticketId, a.ticket))).orderBy(ticketEvent.id)
      assert.deepEqual(history.map((row) => row.kind), ["created", "comment", "comment", "comment"])
      assert.equal(history[0].id, a.event)
    }))

  test("an alert names a subject, its stamps come in pairs and follow its status (23514 alert_subject_shape, alert_acknowledged_shape, alert_resolved_shape, alert_stamps_shape)", () =>
    seeded(async (tx) => {
      const refuse = (values: Partial<typeof alert.$inferInsert>, constraint: RegExp, why: string) =>
        assert.rejects(tx.transaction((savepoint) => savepoint.insert(alert).values(raised(values))), refusedWith("23514", constraint), why)
      await refuse({ vehicleId: null }, /alert_subject_shape/, "about nothing")
      await refuse({ acknowledgedAt: at(11) }, /alert_acknowledged_shape/, "an instant without an account")
      await refuse({ acknowledgedBy: a.account }, /alert_acknowledged_shape/, "an account without an instant")
      await refuse({ resolvedAt: at(12) }, /alert_resolved_shape/, "resolved instant without an account")
      await refuse({ resolutionNote: "Fixed" }, /alert_resolved_shape/, "a note without a resolution")
      // Each status with what it lacks or should not have.
      await refuse({ status: "new", acknowledgedAt: at(11), acknowledgedBy: a.account }, /alert_stamps_shape/, "new and acknowledged")
      await refuse({ status: "new", resolvedAt: at(12), resolvedBy: a.account }, /alert_stamps_shape/, "new and resolved")
      await refuse({ status: "acknowledged" }, /alert_stamps_shape/, "acknowledged without its stamp")
      await refuse({ status: "acknowledged", acknowledgedAt: at(11), acknowledgedBy: a.account, resolvedAt: at(12), resolvedBy: a.account }, /alert_stamps_shape/, "acknowledged and resolved")
      await refuse({ status: "resolved", acknowledgedAt: at(11), acknowledgedBy: a.account }, /alert_stamps_shape/, "resolved without its stamp")
      await refuse({ status: "linked" }, /alert_stamps_shape|alert_status_one_of/, "linked to a ticket is a reading of ticket_id")
      // The shapes that stand, one per status: a resolved alert acknowledged first, and one resolved straight away.
      await tx.insert(alert).values([
        raised({ id: a.spare }),
        raised({ id: a.other, status: "acknowledged", acknowledgedAt: at(11), acknowledgedBy: a.account }),
        raised({ id: a.third, status: "resolved", acknowledgedAt: at(11), acknowledgedBy: a.account, resolvedAt: at(12), resolvedBy: a.secondAccount, resolutionNote: "Serviced" }),
        raised({ id: a.fourth, status: "resolved", resolvedAt: at(12), resolvedBy: a.account }),
      ])
      // Linked: the column, not a status.
      const [linked] = await tx.update(alert).set({ ticketId: a.ticket }).where(eq(alert.id, a.spare)).returning({ status: alert.status, ticketId: alert.ticketId })
      assert.deepEqual(linked, { status: "new", ticketId: a.ticket })
    }))

  test("a ticket's number is the company's once (23505 ticket_number_key), and the same number in another company is another ticket", () =>
    seeded(async (tx) => {
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(ticket).values(opened({ number: 8831 }))), refusedWith("23505", /ticket_number_key/))
      await tx.insert(ticket).values(opened({ companyId: b.company, projectId: b.project, createdBy: b.account, number: 8831 }))
    }))

  test("the counter answers disjoint numbers under two concurrent transactions: the second's update waits on the first's row lock and returns only once the first has committed", async () => {
    // Two creates that merely run together would pass on their numbers even if they took turns by accident, so the first is hand-held — its transaction, and with it the row lock, kept open until the test lets go — and the second is watched: Postgres reports its backend blocked behind the first's (`pg_blocking_pids`) before the first is released, and its update is timed to have returned only after.
    const companyId = a.spare
    await owner.db.insert(company).values({ id: companyId, companyId, name: "Counter", legalName: "Counter A/S", registrationNumber: "99999999", country: "DK", status: "active" })
    try {
      const [{ nextTicketNumber }] = await owner.db.select({ nextTicketNumber: company.nextTicketNumber }).from(company).where(eq(company.id, companyId))
      assert.equal(nextTicketNumber, 1000, "the default")
      /** One create taking its number: what the counter said before the update. */
      const take = async (tx: Tx): Promise<number> => {
        const [row] = await tx
          .update(company)
          .set({ nextTicketNumber: sql`${company.nextTicketNumber} + 1` })
          .where(and(eq(company.id, companyId), eq(company.companyId, companyId)))
          .returning({ next: company.nextTicketNumber })
        return row.next - 1
      }
      const backendOf = async (tx: Tx): Promise<number> => (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`))[0].pid
      const released = Promise.withResolvers<void>()
      const firstLocked = Promise.withResolvers<number>()
      const first = owner.db
        .transaction(async (tx) => {
          const pid = await backendOf(tx)
          const number = await take(tx)
          firstLocked.resolve(pid)
          await released.promise
          return number
        })
        .catch((error: unknown) => {
          firstLocked.reject(error)
          throw error
        })
      const secondStarted = Promise.withResolvers<number>()
      let secondUpdated = Number.NaN
      const second = owner.db
        .transaction(async (tx) => {
          secondStarted.resolve(await backendOf(tx))
          const number = await take(tx)
          secondUpdated = performance.now()
          return number
        })
        .catch((error: unknown) => {
          secondStarted.reject(error)
          throw error
        })
      /** Rejects if the second's update returns while the first still holds the row. */
      const slippedThrough = second.then(() => Promise.reject(new Error("the second's update returned while the first still held the row: the lock did not hold it")))
      void slippedThrough.catch(() => undefined)
      let releasedAt = Number.NaN
      try {
        const [firstPid, secondPid] = await Promise.all([firstLocked.promise, secondStarted.promise])
        // Postgres names the backends a process blocks: the second's update is waiting on the first's transaction once this answers a row, and not before.
        const blocked = async (): Promise<boolean> => (await owner.sql`select pid from pg_stat_activity where pid = ${secondPid} and ${firstPid} = any(pg_blocking_pids(pid))`).length > 0
        const deadline = Date.now() + 10_000
        while (!(await Promise.race([blocked(), slippedThrough]))) {
          assert.ok(Date.now() < deadline, "the second's update never waited on the first: the row lock did not hold it")
          await new Promise((resolve) => setTimeout(resolve, 20))
        }
        releasedAt = performance.now()
      } finally {
        released.resolve()
        await Promise.allSettled([first, second])
      }
      assert.deepEqual(await Promise.all([first, second]), [1000, 1001], "the first took the first number and the second the next: nothing shared, nothing skipped")
      assert.ok(secondUpdated > releasedAt, "the second's update returned only after the first's hold ended")
      const [{ after }] = await owner.db.select({ after: company.nextTicketNumber }).from(company).where(eq(company.id, companyId))
      assert.equal(after, 1002)
    } finally {
      await owner.db.delete(company).where(eq(company.id, companyId))
    }
  })

  test("the outbox takes Resolution's three kinds about a ticket, and nothing about an alert", () =>
    seeded(async (tx) => {
      const event = { companyId: a.company, projectId: a.project, aggregateKind: "ticket", aggregateId: a.ticket, occurredAt: at(9), payload: { id: a.ticket, status: "open" } } as const
      await tx.insert(outboxEvent).values([
        { ...event, id: a.spare, kind: "ticket-opened" },
        { ...event, id: a.other, kind: "ticket-completed" },
        { ...event, id: a.third, kind: "ticket-rejected" },
      ])
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(outboxEvent).values({ ...event, id: a.fourth, kind: "alert-raised" })), refusedWith("23514", /outbox_event_kind_one_of/))
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(outboxEvent).values({ ...event, id: a.fourth, kind: "ticket-opened", aggregateKind: "alert" })), refusedWith("23514", /outbox_event_aggregate_kind_one_of/))
    }))
})

/** Thrown out of a savepoint to roll it back after a statement landed. */
class Landed extends Error {}
