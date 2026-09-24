// The Registry tables against Postgres (Issue #78, slice 1), on a fresh
// database of this file's own so that "migration 0004 applies to a clean
// database" is proved and nothing depends on what the shared local database
// holds: the composite keys refuse another tenant's and another project's
// record, the generated location column and the checks hold, the three
// exclusion constraints refuse two of one thing at a time and accept the
// second once the first has ended, and the fence shows the API role exactly
// its company's rows in each of the fifteen. Every test runs as the owner in a
// transaction that is rolled back, so nothing needs cleaning up.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import type { Point } from "@waste/contracts/geojson"
import { eq, getTableName, sql } from "drizzle-orm"
import type { PgTable } from "drizzle-orm/pg-core"

import { createDb, type Database, type Tx } from "../client"
import { migrateDatabase } from "../migrate"
import { API_ROLE } from "../roles"
import { agreement, subscription } from "../schema/agreements"
import { containerType, product, serviceFrequency, wasteFraction } from "../schema/catalogue"
import { container, containerServicePlacement } from "../schema/containers"
import { customer, property, propertyGroup, propertyGroupMember, propertyParty, sharedCollectionPoint, sharedCollectionPointMember } from "../schema/customers"
import { company, project } from "../schema/organisation"
import { withCompany } from "../tenant"
import { databaseUnderTest, freshDatabase, type FreshDatabase } from "./database"
import { refusedWith, rolledBack, rolledBackIn } from "./specimen"

const database = databaseUnderTest()

/** One company's fixture ids, a nibble telling the companies apart. */
const ids = (n: "a" | "b") => ({
  company: `018f7c2e-${n}000-7000-8000-000000000001`,
  project: `018f7c2e-${n}000-7000-8000-000000000002`,
  wasteFraction: `018f7c2e-${n}000-7000-8000-000000000003`,
  containerType: `018f7c2e-${n}000-7000-8000-000000000004`,
  serviceFrequency: `018f7c2e-${n}000-7000-8000-000000000005`,
  product: `018f7c2e-${n}000-7000-8000-000000000006`,
  customer: `018f7c2e-${n}000-7000-8000-000000000007`,
  property: `018f7c2e-${n}000-7000-8000-000000000008`,
  propertyParty: `018f7c2e-${n}000-7000-8000-000000000009`,
  propertyGroup: `018f7c2e-${n}000-7000-8000-00000000000a`,
  propertyGroupMember: `018f7c2e-${n}000-7000-8000-00000000000b`,
  point: `018f7c2e-${n}000-7000-8000-00000000000c`,
  pointMember: `018f7c2e-${n}000-7000-8000-00000000000d`,
  agreement: `018f7c2e-${n}000-7000-8000-00000000000e`,
  subscription: `018f7c2e-${n}000-7000-8000-00000000000f`,
  container: `018f7c2e-${n}000-7000-8000-000000000010`,
  placement: `018f7c2e-${n}000-7000-8000-000000000011`,
  /** Free for a test's own rows. */
  spare: `018f7c2e-${n}000-7000-8000-0000000000e1`,
  other: `018f7c2e-${n}000-7000-8000-0000000000e2`,
  third: `018f7c2e-${n}000-7000-8000-0000000000e3`,
})
const a = ids("a")
const b = ids("b")

/** Copenhagen town hall, a point every geometry write here uses. */
const TOWN_HALL: Point = { type: "Point", coordinates: [12.5683, 55.6761] }
/** The first day of the seeded periods; every date in this file is a `YYYY-MM-DD` string, as the validity columns read. */
const OPENED = "2026-01-01"

const tables: Record<string, PgTable> = {
  wasteFraction,
  containerType,
  serviceFrequency,
  product,
  customer,
  property,
  propertyParty,
  propertyGroup,
  propertyGroupMember,
  sharedCollectionPoint,
  sharedCollectionPointMember,
  agreement,
  subscription,
  container,
  containerServicePlacement,
}

/** A company with its project and one row in each of the fifteen Registry tables, inserted as the owner in dependency order. */
async function seed(tx: Tx, n: "a" | "b"): Promise<void> {
  const own = ids(n)
  await tx.insert(company).values({ id: own.company, companyId: own.company, name: `Company ${n}`, legalName: `Company ${n} A/S`, registrationNumber: `1000000${n}`, country: "DK", status: "active" })
  await tx.insert(project).values({ id: own.project, companyId: own.company, name: "Copenhagen Central", kind: "Municipality", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
  await tx.insert(wasteFraction).values({ id: own.wasteFraction, companyId: own.company, key: "residual", name: "Residual waste" })
  await tx.insert(containerType).values({ id: own.containerType, companyId: own.company, name: "240 L bin", volumeLitres: 240 })
  await tx.insert(serviceFrequency).values({ id: own.serviceFrequency, companyId: own.company, projectId: own.project, name: "Weekly", collectionsPerWeek: 1, weeksBetween: 1 })
  await tx.insert(product).values({
    id: own.product,
    companyId: own.company,
    projectId: own.project,
    name: "Residual 240 L weekly",
    kind: "container-collection",
    status: "active",
    unit: "pickup",
    containerTypeId: own.containerType,
    wasteFractionId: own.wasteFraction,
    serviceFrequencyId: own.serviceFrequency,
  })
  await tx.insert(customer).values({ id: own.customer, companyId: own.company, kind: "organisation", name: "Parkvej Boligforening", registrationNumber: `3000000${n}`, email: `post@${n}.example`, status: "active" })
  await tx.insert(property).values({
    id: own.property,
    companyId: own.company,
    projectId: own.project,
    name: "Parkvej 18",
    address: "Parkvej 18, 8000 Aarhus C",
    registryId: `4000000${n}`,
    kind: "residential",
    location: TOWN_HALL,
    status: "active",
  })
  await tx.insert(propertyParty).values({ id: own.propertyParty, companyId: own.company, projectId: own.project, propertyId: own.property, customerId: own.customer, role: "owner" })
  await tx.insert(propertyGroup).values({ id: own.propertyGroup, companyId: own.company, projectId: own.project, name: "Parkvej housing", purpose: "administration", responsibleCustomerId: own.customer, status: "active" })
  await tx.insert(propertyGroupMember).values({ id: own.propertyGroupMember, companyId: own.company, projectId: own.project, propertyGroupId: own.propertyGroup, propertyId: own.property, role: "member" })
  await tx.insert(sharedCollectionPoint).values({
    id: own.point,
    companyId: own.company,
    projectId: own.project,
    name: "Torvet station",
    kind: "underground",
    address: "Torvet 1, 8000 Aarhus C",
    location: TOWN_HALL,
    eligibilityDistanceM: 150,
    operatingModel: "municipal",
    accessMode: "open",
    billingMode: "municipal",
    status: "open",
  })
  await tx.insert(sharedCollectionPointMember).values({ id: own.pointMember, companyId: own.company, projectId: own.project, sharedCollectionPointId: own.point, propertyId: own.property, role: "service-member" })
  await tx.insert(agreement).values({
    id: own.agreement,
    companyId: own.company,
    projectId: own.project,
    validFrom: OPENED,
    number: "AGR-2408",
    customerId: own.customer,
    payerCustomerId: own.customer,
    status: "active",
    billingCadence: "monthly",
    currency: "DKK",
  })
  await tx.insert(subscription).values({ id: own.subscription, companyId: own.company, projectId: own.project, validFrom: OPENED, agreementId: own.agreement, productId: own.product, propertyId: own.property })
  await tx.insert(container).values({ id: own.container, companyId: own.company, projectId: own.project, label: "BIN-82014", containerTypeId: own.containerType, ownership: "company" })
  await tx.insert(containerServicePlacement).values({
    id: own.placement,
    companyId: own.company,
    projectId: own.project,
    validFrom: OPENED,
    containerId: own.container,
    subscriptionId: own.subscription,
    wasteFractionId: own.wasteFraction,
  })
}

describe("the Registry tables against a fresh database", { skip: database.skip }, () => {
  let fresh: FreshDatabase
  let owner: Database

  before(async () => {
    fresh = await freshDatabase(database.adminUrl, "waste_registry")
    await migrateDatabase(fresh.url)
    owner = createDb(fresh.url, { max: 2 })
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

  test("0004 created the fifteen tables in wms, each fenced (row-level security enabled and forced, one policy for the API role) and with its updated_at trigger", async () => {
    const names = Object.values(tables).map(getTableName).sort()
    assert.equal(names.length, 15)
    const rows = await owner.sql<{ table: string; enabled: boolean; forced: boolean; policies: string[]; triggers: string[] }[]>`
      select c.relname as table, c.relrowsecurity as enabled, c.relforcerowsecurity as forced,
        (select array_agg(p.policyname order by p.policyname) from pg_policies p where p.schemaname = 'wms' and p.tablename = c.relname) as policies,
        (select array_agg(t.tgname order by t.tgname) from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal) as triggers
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'wms' and c.relkind = 'r' and c.relname = any (${names}::text[])
      order by c.relname`
    assert.deepEqual(
      rows.map(({ table, enabled, forced, policies, triggers }) => ({ table, enabled, forced, policies, triggers })),
      names.map((table) => ({ table, enabled: true, forced: true, policies: [`${table}_tenant_fence`], triggers: [`${table}_touch_updated_at`] })),
    )
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
  const one = Object.fromEntries(Object.keys(tables).map((name) => [name, 1]))

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

  test("under withCompany as the API role, each of the fifteen tables shows the company's rows and nothing of another company's", async () => {
    const seenByA = await asCompany(a.company, async (tx) => ({
      counts: await counts(tx),
      properties: (await tx.select({ id: property.id }).from(property)).map((row) => row.id),
    }))
    assert.deepEqual(seenByA, { counts: one, properties: [a.property] })
    const seenByB = await asCompany(b.company, async (tx) => ({
      counts: await counts(tx),
      properties: (await tx.select({ id: property.id }).from(property)).map((row) => row.id),
    }))
    assert.deepEqual(seenByB, { counts: one, properties: [b.property] })
  })

  test("a row that names another company's catalogue row, customer or fraction is refused by the composite key (23503)", () =>
    seeded(async (tx) => {
      await assert.rejects(
        tx.transaction((savepoint) =>
          savepoint.insert(product).values({ id: a.spare, companyId: a.company, projectId: a.project, name: "Borrowed", kind: "container-collection", status: "draft", unit: "pickup", containerTypeId: b.containerType }),
        ),
        refusedWith("23503", /product_container_type_id_fk/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(propertyParty).values({ id: a.spare, companyId: a.company, projectId: a.project, propertyId: a.property, customerId: b.customer, role: "payer" })),
        refusedWith("23503", /property_party_customer_id_fk/),
      )
      await assert.rejects(
        tx.transaction((savepoint) =>
          savepoint.insert(containerServicePlacement).values({
            // A period before the seeded placement's, so the exclusion constraint has nothing to say and the key is what refuses.
            id: a.spare,
            companyId: a.company,
            projectId: a.project,
            validFrom: "2025-01-01",
            validTo: OPENED,
            containerId: a.container,
            subscriptionId: a.subscription,
            wasteFractionId: b.wasteFraction,
          }),
        ),
        refusedWith("23503", /container_service_placement_waste_fraction_id_fk/),
      )
      // The same rows within the tenant land.
      await tx.insert(product).values({ id: a.spare, companyId: a.company, projectId: a.project, name: "Borrowed", kind: "container-collection", status: "draft", unit: "pickup", containerTypeId: a.containerType })
      await tx.insert(propertyParty).values({ id: a.other, companyId: a.company, projectId: a.project, propertyId: a.property, customerId: a.customer, role: "payer" })
    }))

  test("a subscription cannot name a property of another project of its own company (23503 subscription_property_id_fk)", () =>
    seeded(async (tx) => {
      await tx.insert(project).values({ id: a.spare, companyId: a.company, name: "Harbor", kind: "Contract", language: "da", currency: "DKK", timezone: "Europe/Copenhagen", status: "active" })
      await tx.insert(property).values({ id: a.other, companyId: a.company, projectId: a.spare, name: "Havnegade 2", address: "Havnegade 2", kind: "commercial", status: "active" })
      await assert.rejects(
        tx.transaction((savepoint) =>
          savepoint.insert(subscription).values({ id: a.third, companyId: a.company, projectId: a.project, validFrom: OPENED, agreementId: a.agreement, productId: a.product, propertyId: a.other }),
        ),
        refusedWith("23503", /subscription_property_id_fk/),
      )
    }))

  test("location_id follows whichever place the subscription names; both places are refused by the check (23514), neither by the generated column itself (23502)", () =>
    seeded(async (tx) => {
      const locationOf = async (id: string): Promise<string | null> => {
        const [row] = await tx.execute<{ locationId: string | null }>(sql`select ${subscription.locationId} as "locationId" from ${subscription} where ${eq(subscription.id, id)}`)
        return row.locationId
      }
      assert.equal(await locationOf(a.subscription), a.property)
      await tx.insert(subscription).values({ id: a.spare, companyId: a.company, projectId: a.project, validFrom: OPENED, agreementId: a.agreement, productId: a.product, sharedCollectionPointId: a.point })
      assert.equal(await locationOf(a.spare), a.point)
      // Naming neither place makes the coalesce null, and Postgres checks NOT
      // NULL before any CHECK constraint, so the generated column answers
      // first: the row is refused either way, and the API's own body check
      // (the contracts' one-of refine) is what a caller sees.
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(subscription).values({ id: a.other, companyId: a.company, projectId: a.project, validFrom: OPENED, agreementId: a.agreement, productId: a.product })),
        refusedWith("23502", /location_id/),
      )
      await assert.rejects(
        tx.transaction((savepoint) =>
          savepoint.insert(subscription).values({
            id: a.other,
            companyId: a.company,
            projectId: a.project,
            validFrom: OPENED,
            agreementId: a.agreement,
            productId: a.product,
            propertyId: a.property,
            sharedCollectionPointId: a.point,
          }),
        ),
        refusedWith("23514", /subscription_location_exactly_one/),
      )
    }))

  test("one agreement of a number at a time (23P01 agreement_no_overlap), and the number is free again once the first has ended", () =>
    seeded(async (tx) => {
      const second = (validFrom: string) => ({
        id: a.spare,
        companyId: a.company,
        projectId: a.project,
        validFrom,
        number: "AGR-2408",
        customerId: a.customer,
        payerCustomerId: a.customer,
        status: "active",
        billingCadence: "monthly",
        currency: "DKK",
      })
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(agreement).values(second("2026-07-01"))), refusedWith("23P01", /agreement_no_overlap/))
      // The period is half-open, so a second agreement may start on the day the first ends.
      await tx.update(agreement).set({ validTo: "2026-07-01" }).where(eq(agreement.id, a.agreement))
      await tx.insert(agreement).values(second("2026-07-01"))
      // Another number over the same period is another agreement, not an overlap.
      await tx.insert(agreement).values({ ...second(OPENED), id: a.other, number: "AGR-2409" })
    }))

  test("one subscription per agreement, product and place at a time, and one placement per container (23P01)", () =>
    seeded(async (tx) => {
      const twin = (validFrom: string) => ({ id: a.spare, companyId: a.company, projectId: a.project, validFrom, agreementId: a.agreement, productId: a.product, propertyId: a.property })
      await assert.rejects(tx.transaction((savepoint) => savepoint.insert(subscription).values(twin("2026-07-01"))), refusedWith("23P01", /subscription_no_overlap/))
      await tx.update(subscription).set({ validTo: "2026-07-01" }).where(eq(subscription.id, a.subscription))
      await tx.insert(subscription).values(twin("2026-07-01"))

      // A container serves in one place at a time, whatever it serves.
      const placed = (validFrom: string, subscriptionId: string) => ({
        id: a.other,
        companyId: a.company,
        projectId: a.project,
        validFrom,
        containerId: a.container,
        subscriptionId,
        wasteFractionId: a.wasteFraction,
      })
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(containerServicePlacement).values(placed("2026-09-01", a.spare))),
        refusedWith("23P01", /container_service_placement_no_overlap/),
      )
      await tx.update(containerServicePlacement).set({ validTo: "2026-09-01" }).where(eq(containerServicePlacement.id, a.placement))
      await tx.insert(containerServicePlacement).values(placed("2026-09-01", a.spare))
    }))

  test("a property may have no location, and a point outside WGS 84 is refused (23514 property_location_valid)", () =>
    seeded(async (tx) => {
      await tx.insert(property).values({ id: a.spare, companyId: a.company, projectId: a.project, name: "Not yet geocoded", address: "Ukendt vej 1", kind: "other", status: "active" })
      await assert.rejects(
        tx.transaction((savepoint) =>
          savepoint.insert(property).values({
            id: a.other,
            companyId: a.company,
            projectId: a.project,
            name: "Off the map",
            address: "Nowhere",
            kind: "other",
            location: { type: "Point", coordinates: [200, 55.6761] },
            status: "active",
          }),
        ),
        refusedWith("23514", /property_location_valid/),
      )
    }))

  test("the service frequency shape: an interval needs a rate to belong to, and the two intervals are never both given (23514 service_frequency_shape)", () =>
    seeded(async (tx) => {
      const frequency = (name: string, values: { collectionsPerWeek?: number; weeksBetween?: number; daysBetween?: number }) => ({
        id: a.spare,
        companyId: a.company,
        projectId: a.project,
        name,
        ...values,
      })
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(serviceFrequency).values(frequency("Both intervals", { collectionsPerWeek: 2, weeksBetween: 1, daysBetween: 3 }))),
        refusedWith("23514", /service_frequency_shape/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(serviceFrequency).values(frequency("On demand, every three days", { daysBetween: 3 }))),
        refusedWith("23514", /service_frequency_shape/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(serviceFrequency).values(frequency("On demand, fortnightly", { weeksBetween: 2 }))),
        refusedWith("23514", /service_frequency_shape/),
      )
      // On demand is no rate and no interval; monthly is one a week with neither.
      await tx.insert(serviceFrequency).values(frequency("On demand", {}))
      await tx.insert(serviceFrequency).values({ ...frequency("Monthly", { collectionsPerWeek: 1 }), id: a.other })
    }))

  test("a quantity is a count above zero (23514 subscription_quantity_positive)", () =>
    seeded(async (tx) => {
      await assert.rejects(
        tx.transaction((savepoint) =>
          savepoint.insert(subscription).values({ id: a.spare, companyId: a.company, projectId: a.project, validFrom: OPENED, agreementId: a.agreement, productId: a.product, sharedCollectionPointId: a.point, quantity: 0 }),
        ),
        refusedWith("23514", /subscription_quantity_positive/),
      )
      await tx.insert(subscription).values({ id: a.spare, companyId: a.company, projectId: a.project, validFrom: OPENED, agreementId: a.agreement, productId: a.product, sharedCollectionPointId: a.point, quantity: 3 })
    }))

  test("a customer's e-mail is lowercase (23514) and a registration number is one company's once (23505 customer_registration_number_idx); people without one are many", () =>
    seeded(async (tx) => {
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(customer).values({ id: a.spare, companyId: a.company, kind: "person", name: "Olivia Larsen", email: "Olivia.Larsen@kystbyen.example", status: "active" })),
        refusedWith("23514", /customer_email_lowercase/),
      )
      await assert.rejects(
        tx.transaction((savepoint) => savepoint.insert(customer).values({ id: a.spare, companyId: a.company, kind: "organisation", name: "Twin", registrationNumber: "3000000a", status: "active" })),
        refusedWith("23505", /customer_registration_number_idx/),
      )
      // Another company may hold the same registration, and a person has none at all.
      await tx.insert(customer).values({ id: b.spare, companyId: b.company, kind: "organisation", name: "Same registration, other company", registrationNumber: "3000000a", status: "active" })
      await tx.insert(customer).values([
        { id: a.spare, companyId: a.company, kind: "person", name: "Olivia Larsen", email: "olivia.larsen@kystbyen.example", status: "active" },
        { id: a.other, companyId: a.company, kind: "person", name: "Jens Holm", status: "active" },
      ])
    }))
})
