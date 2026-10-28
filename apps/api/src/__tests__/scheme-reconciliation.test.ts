// The cadence against the promise on the API (O22 of #290): a scheme's read
// and write answers carry `warnings` naming the containers it collects whose
// effective service frequency — the placement's override, or its
// subscription's product's — its cadence under- or over-serves, judged on the
// API's `service_frequency` intervals. A warning never refuses the write.
import assert from "node:assert/strict"
import { randomInt } from "node:crypto"
import { after, before, describe, test } from "node:test"

import { Page } from "@waste/contracts/pagination"
import { RouteScheme } from "@waste/contracts/route-schemes"
import { createDb, type Database, type Tx } from "@waste/db/client"
import { agreement, subscription } from "@waste/db/schema/agreements"
import { containerType, product, serviceFrequency, wasteFraction } from "@waste/db/schema/catalogue"
import { container, containerServicePlacement } from "@waste/db/schema/containers"
import { customer, property } from "@waste/db/schema/customers"
import { withCompany } from "@waste/db/tenant"

import { createApp } from "../app"
import { reconciledOn } from "../routes/scheme-reconciliation"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { TOWN_HALL } from "./execution-fixtures"
import { dropTenant, seedTenant, testId, type Tenant } from "./tenant"
import { signingKeys } from "./tokens"

const database = databaseUnderTest()
const RouteSchemePage = Page(RouteScheme)

/** Wednesday 28 October 2026, noon in Copenhagen: the app's clock, so today is a day this file names. */
const NOON = new Date("2026-10-28T11:00:00Z")

const under = (served: string, count: string, promised: string, names: string) =>
  `Recurrence ${served} under-serves ${count} promised ${promised} (${names}) — raise the frequency or adjust the promised service frequency`
const over = (served: string, count: string, promised: string, names: string) =>
  `Recurrence ${served} over-serves ${count} promised ${promised} (${names}) — collections run more often than the promised service frequency`

describe("the day a scheme's promises are judged on", () => {
  test("is today, its first day where that is ahead, and its last day in force once it has ended", () => {
    assert.equal(reconciledOn({ validFrom: "2026-01-01", validTo: null }, "2026-10-28"), "2026-10-28")
    assert.equal(reconciledOn({ validFrom: "2027-01-04", validTo: null }, "2026-10-28"), "2027-01-04")
    assert.equal(reconciledOn({ validFrom: "2026-01-01", validTo: "2026-07-01" }, "2026-10-28"), "2026-06-30")
  })
})

describe("a route scheme's frequency warnings", { skip: database.skip }, () => {
  let pool: Database
  let a: Tenant
  let olivia: Call
  /** Ground: the weekly promise every container inherits from its product, unless its placement overrides it. */
  const ids = {
    fraction: testId(),
    type: testId(),
    property: testId(),
    weekly: testId(),
    twice: testId(),
    onDemand: testId(),
    weeklyBin: testId(),
    twiceBin: testId(),
    demandBin: testId(),
    unplacedBin: testId(),
    laterBin: testId(),
  }

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    const keys = await signingKeys()
    a = await seedTenant(pool)
    const { companyId } = a
    const projectId = a.projects.copenhagen.id
    const scoped = { companyId, projectId }
    await withCompany(pool.db, companyId, async (tx: Tx) => {
      await tx.insert(wasteFraction).values({ id: ids.fraction, companyId, key: "residual", name: "Residual waste" })
      await tx.insert(containerType).values({ id: ids.type, companyId, name: "240 L bin", volumeLitres: 240 })
      await tx.insert(serviceFrequency).values([
        { id: ids.weekly, ...scoped, name: "Every week", collectionsPerWeek: 1, weeksBetween: 1 },
        { id: ids.twice, ...scoped, name: "Twice a week", collectionsPerWeek: 2, daysBetween: 3 },
        { id: ids.onDemand, ...scoped, name: "On demand" },
      ])
      await tx.insert(property).values({ id: ids.property, ...scoped, name: "Parkvej 18", address: "Parkvej 18, 2100 København Ø", kind: "residential", location: TOWN_HALL, status: "active" })
      const bin = (id: string, label: string) => ({ id, ...scoped, label, containerTypeId: ids.type, ownership: "company" })
      await tx.insert(container).values([
        bin(ids.weeklyBin, "BIN-W"),
        bin(ids.twiceBin, "BIN-T"),
        bin(ids.demandBin, "BIN-D"),
        bin(ids.unplacedBin, "BIN-U"),
        bin(ids.laterBin, "BIN-L"),
      ])
      const customerId = testId()
      const productId = testId()
      const agreementId = testId()
      const subscriptionId = testId()
      await tx.insert(customer).values({ id: customerId, companyId, kind: "organisation", name: "Parkvej Boligforening", registrationNumber: String(randomInt(10_000_000, 100_000_000)), status: "active" })
      await tx.insert(product).values({ id: productId, ...scoped, name: "Residual 240 L", kind: "container-collection", status: "active", unit: "pickup", containerTypeId: ids.type, wasteFractionId: ids.fraction, serviceFrequencyId: ids.weekly })
      await tx.insert(agreement).values({ id: agreementId, ...scoped, validFrom: "2026-01-01", number: "AGR-022", customerId, payerCustomerId: customerId, status: "active", billingCadence: "monthly", currency: "DKK" })
      await tx.insert(subscription).values({ id: subscriptionId, ...scoped, validFrom: "2026-01-01", agreementId, productId, propertyId: ids.property })
      const placement = (containerId: string, serviceFrequencyId: string | null, validFrom = "2026-01-01") => ({ id: testId(), ...scoped, validFrom, containerId, subscriptionId, wasteFractionId: ids.fraction, serviceFrequencyId })
      await tx.insert(containerServicePlacement).values([
        placement(ids.weeklyBin, null),
        placement(ids.twiceBin, ids.twice),
        placement(ids.demandBin, ids.onDemand),
        // Placed from next year: no promise today, the weekly one for a scheme that starts then.
        placement(ids.laterBin, null, "2027-01-04"),
      ])
    })
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, now: () => NOON })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    await pool?.close()
  })

  const picked = (name: string, days: string[], containerIds: string[], id?: string) => ({ ...(id === undefined ? {} : { id }), name, days, stopSource: "manual", containerIds })
  const scheme = async (name: string, values: Record<string, unknown>) => {
    const body = { projectId: a.projects.copenhagen.id, name, serviceType: "container-collection", frequency: "weekly", serviceDays: ["monday", "thursday"], validFrom: "2026-10-01", ...values }
    return created(olivia, "/route-schemes", await olivia("/route-schemes", { method: "POST", body }), RouteScheme)
  }
  const read = async (id: string) => {
    const response = await olivia(`/route-schemes/${id}`)
    assert.equal(response.status, 200)
    return RouteScheme.parse(await response.json())
  }

  test("a create answers the containers its cadence under-serves, and still writes the scheme", async () => {
    const written = await scheme("Promises Monday", {
      collectionGroups: [picked("Monday", ["monday"], [ids.weeklyBin, ids.twiceBin, ids.demandBin, ids.unplacedBin])],
    })
    assert.deepEqual(written.warnings, [under("Every week", "1 container", "Twice a week", "BIN-T")], "the weekly bin is kept, the on-demand and unplaced ones promise nothing")
    assert.deepEqual((await read(written.id)).warnings, written.warnings, "a read says what the write answered")
  })

  test("a container collected on two days is served twice a week: the twice-weekly promise kept, the weekly one over-served, its days named", async () => {
    const written = await scheme("Promises twice", {
      collectionGroups: [picked("Twice", ["monday", "thursday"], [ids.weeklyBin, ids.twiceBin])],
    })
    assert.deepEqual(written.warnings, [over("Every week on Mon, Thu", "1 container", "Every week", "BIN-W")])
  })

  test("a patch answers the warnings the edit leaves: a cadence that drops to every second week under-serves the weekly promise", async () => {
    const written = await scheme("Promises patched", {
      collectionGroups: [picked("Monday", ["monday"], [ids.weeklyBin])],
    })
    assert.deepEqual(written.warnings, [])
    const response = await olivia(`/route-schemes/${written.id}`, { method: "PATCH", body: { frequency: "every-2-weeks", weekRotation: "even" } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    assert.deepEqual(RouteScheme.parse(await response.json()).warnings, [under("Every 2 weeks", "1 container", "Every week", "BIN-W")])
    const list = await olivia(`/route-schemes?projectId=${a.projects.copenhagen.id}`)
    const listed = RouteSchemePage.parse(await list.json()).items.find((item) => item.id === written.id)
    assert.deepEqual(listed?.warnings, [under("Every 2 weeks", "1 container", "Every week", "BIN-W")], "a page carries them too")
  })

  test("the promise is the one in force on the scheme's first day where that is ahead", async () => {
    const now = await scheme("Promises now", { collectionGroups: [picked("Monday", ["monday"], [ids.laterBin])], frequency: "every-2-weeks", weekRotation: "odd" })
    assert.deepEqual(now.warnings, [], "not placed today")
    const later = await scheme("Promises later", { collectionGroups: [picked("Monday", ["monday"], [ids.laterBin])], frequency: "every-2-weeks", weekRotation: "odd", validFrom: "2027-01-04" })
    assert.deepEqual(later.warnings, [under("Every 2 weeks", "1 container", "Every week", "BIN-L")])
  })

  test("a rule group lends no container before a run has matched one", async () => {
    const written = await scheme("Promises by rule", {
      collectionGroups: [{ name: "Rule", days: ["monday"], stopSource: "rule", rule: { wasteFractionIds: [ids.fraction], containerTypeIds: [], vehicleTypeId: null } }],
      frequency: "every-2-weeks",
      weekRotation: "odd",
    })
    assert.deepEqual(written.warnings, [])
  })
})
