// The collection reminders (C18 of #291), on a database of their own since
// the sweep reads across companies: before two in the afternoon on the
// project's clock nothing is sent; after it, the customers of the next day's
// scheduled collections are reminded once, with the day filled in — not an
// office stop's customer, not another day's, not one without an address on
// the template's channel — and a later run queues nothing twice. One run is
// bounded by its batch and a day by its cap, a customer beyond the cap
// counted and never reminded.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { createDb, type Database } from "@waste/db/client"
import { migrateDatabase } from "@waste/db/migrate"
import { customer } from "@waste/db/schema/customers"
import { route } from "@waste/db/schema/execution"
import { message, messageTemplate } from "@waste/db/schema/messaging"
import { notificationRule } from "@waste/db/schema/notifications"
import { withCompany } from "@waste/db/tenant"
import { and, asc, eq } from "drizzle-orm"

import { collectionRemindersJob, REMINDER_CHUNK, remindProject, runCollectionReminders } from "../jobs/collection-reminders"
import type { JobContext } from "../jobs/definition"
import { rolesUnderTest, withDatabaseName } from "./database"
import { at, FIXTURE_DAY, placeBin, seedCompletedRoute, seedFinanceTenant, testId, type FinanceTenant, type PlacedBin } from "./finance-tenant"

const roles = rolesUnderTest()
/** The fixtures' Monday's next day, the day the afternoon's reminders are of. */
const TUESDAY = "2026-10-06"
const WEDNESDAY = "2026-10-07"

describe("messaging.collection-reminders", { skip: roles.skip }, () => {
  const name = `waste_worker_reminders_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  let admin: Database
  let api: Database
  let worker: Database
  let tenant: FinanceTenant
  const templateId = testId()
  const bins: Record<"housing" | "anna" | "bo" | "office", PlacedBin> = {} as never
  const lines: string[] = []
  let NOW = at(FIXTURE_DAY, "13:30")
  const context = () => ({ api, worker, now: () => NOW, send: async () => testId(), log: (line: string) => void lines.push(line) }) as unknown as JobContext
  const project = () => ({ companyId: tenant.companyId, projectId: tenant.projects.copenhagen.id, templateId, channel: "email" as const })

  /** A planned route of the scheme operating on `day`, its stops planned. */
  const plannedRoute = async (day: string, stops: Parameters<typeof seedCompletedRoute>[2]) => {
    const seeded = await seedCompletedRoute(api, tenant, stops, day)
    await withCompany(api.db, tenant.companyId, (tx) =>
      tx.update(route).set({ status: "planned", dispatchedAt: null, startedAt: null, completedAt: null, actualVehicleId: null, actualDriverId: null }).where(eq(route.id, seeded.id)),
    )
    return seeded
  }
  const reminded = (day: string) =>
    withCompany(api.db, tenant.companyId, async (tx) =>
      (await tx.select({ customerId: message.customerId, body: message.body }).from(message).where(and(eq(message.companyId, tenant.companyId), eq(message.templateId, templateId))).orderBy(asc(message.id))).filter((row) =>
        row.body.endsWith(day),
      ),
    )

  before(async () => {
    if (roles.skip) return
    admin = createDb(roles.adminUrl, { max: 1 })
    await admin.sql.unsafe(`create database "${name}"`)
    await migrateDatabase(withDatabaseName(roles.adminUrl, name))
    api = createDb(withDatabaseName(roles.apiUrl, name), { max: 2 })
    worker = createDb(withDatabaseName(roles.workerUrl, name), { max: 2 })
    tenant = await seedFinanceTenant(api)
    const productId = tenant.products.residual.id
    bins.housing = await placeBin(api, tenant, "H-1", { agreementId: tenant.agreements.housing.id, productId })
    bins.anna = await placeBin(api, tenant, "A-1", { agreementId: tenant.agreements.anna.id, productId })
    bins.bo = await placeBin(api, tenant, "B-1", { agreementId: tenant.agreements.draft.id, productId })
    bins.office = await placeBin(api, tenant, "O-1", { agreementId: tenant.agreements.housing.id, productId })
    await withCompany(api.db, tenant.companyId, async (tx) => {
      await tx.update(customer).set({ email: "kontor@housing.example", serviceMessagesAllowed: true }).where(eq(customer.id, tenant.customers.housing.id))
      await tx.update(customer).set({ email: "anna@anna.example", serviceMessagesAllowed: true }).where(eq(customer.id, tenant.customers.anna.id))
      await tx.update(customer).set({ email: null, phone: "+45 11 22 33 44" }).where(eq(customer.id, tenant.customers.bo.id))
      await tx.insert(messageTemplate).values({ id: templateId, companyId: tenant.companyId, projectId: tenant.projects.copenhagen.id, name: "Reminder", purpose: "service", channel: "email", subject: "Tomorrow", body: "We collect on {{collectionDate}}", status: "active" })
      await tx.insert(notificationRule).values({ companyId: tenant.companyId, projectId: tenant.projects.copenhagen.id, event: "collection-reminder", templateId })
    })
    // Tuesday: the housing association's, Anna's and Bo's emptyings, Bo with no e-mail address.
    await plannedRoute(TUESDAY, [
      { containerId: bins.housing.containerId, propertyId: bins.housing.propertyId, status: "planned" },
      { containerId: bins.anna.containerId, propertyId: bins.anna.propertyId, status: "planned" },
      { containerId: bins.bo.containerId, propertyId: bins.bo.propertyId, status: "planned" },
    ])
    // Wednesday, for the bounds: the housing association's and Anna's emptyings, and the office's repair at the housing association's other bin.
    await plannedRoute(WEDNESDAY, [
      { containerId: bins.housing.containerId, propertyId: bins.housing.propertyId, status: "planned" },
      { containerId: bins.anna.containerId, propertyId: bins.anna.propertyId, status: "planned" },
      { containerId: bins.office.containerId, propertyId: bins.office.propertyId, status: "planned", origin: "office", service: "repair" },
    ])
  })

  after(async () => {
    await Promise.allSettled([api?.close(), worker?.close()])
    try {
      await admin?.sql.unsafe(`drop database if exists "${name}" with (force)`)
    } finally {
      await admin?.close()
    }
  })

  test("is hourly off the hour, with no retry: the next hour is the retry", () => {
    assert.equal(collectionRemindersJob.schedule, "7 * * * *")
    assert.equal(collectionRemindersJob.queueOptions?.retryLimit, 0)
    assert.equal(REMINDER_CHUNK, 50, "below the 64 subtransactions Postgres caches")
  })

  test("before two in the afternoon on the project's clock, nothing is sent", async () => {
    NOW = at(FIXTURE_DAY, "13:30")
    assert.deepEqual(await runCollectionReminders(context()), [])
    assert.deepEqual(await reminded(TUESDAY), [])
  })

  test("after it, the next day's scheduled collections' customers with an address are reminded once, the day filled in", async () => {
    NOW = at(FIXTURE_DAY, "14:10")
    const [outcome] = await runCollectionReminders(context())
    assert.deepEqual(outcome, { companyId: tenant.companyId, projectId: tenant.projects.copenhagen.id, day: TUESDAY, queued: 2, refused: 0, beyondCap: 0 })
    const rows = await reminded(TUESDAY)
    assert.deepEqual(rows.map((row) => row.customerId).sort(), [tenant.customers.housing.id, tenant.customers.anna.id].sort(), "Bo has no e-mail address, and is not counted")
    assert.equal(rows[0]?.body, `We collect on ${TUESDAY}`)

    NOW = at(FIXTURE_DAY, "15:10")
    const [again] = await runCollectionReminders(context())
    assert.equal(again?.queued, 0, "a later run reminds nobody twice")
    assert.equal((await reminded(TUESDAY)).length, 2)
  })

  test("one run is bounded by its batch, a day by its cap, and a customer beyond the cap is counted, never reminded", async () => {
    lines.length = 0
    const first = await remindProject(project(), WEDNESDAY, context(), { cap: 1, batch: 1 })
    assert.deepEqual([first.queued, first.beyondCap], [1, 1], "of two customers due, the cap's one; the other counted")
    assert.match(lines.join("\n"), /1 customers beyond the day's cap of 1/)
    const second = await remindProject(project(), WEDNESDAY, context(), { cap: 1, batch: 1 })
    assert.equal(second.queued, 0, "the day's cap is reached")
    const rows = await reminded(WEDNESDAY)
    assert.deepEqual(rows.map((row) => row.customerId), [[tenant.customers.housing.id, tenant.customers.anna.id].sort()[0]], "the first in customer-id order; the office's repair reminds nobody")

    const third = await remindProject(project(), WEDNESDAY, context(), { cap: 10, batch: 1 })
    assert.equal(third.queued, 1, "a higher cap reaches the next")
    assert.equal((await reminded(WEDNESDAY)).length, 2)
  })
})
