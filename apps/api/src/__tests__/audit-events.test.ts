// The audit log through the API (#291, slice 9): a write is recorded with
// the principal as its actor and the `Waste-Change-Reason` header as its
// reason — bounded and percent-decoded, never the client's word for who —
// and `GET /audit-events` reads one row's history newest first, its sets'
// changes under it in one transaction per request, held to the view grant of
// the module the table belongs to and to the caller's projects, or the whole
// company's under `configure.privacy`.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Role } from "@waste/contracts/access"
import { AuditEvent, CHANGE_REASON_HEADER } from "@waste/contracts/audit"
import { Customer, Property } from "@waste/contracts/customers"
import { Page } from "@waste/contracts/pagination"
import { createDb, type Database } from "@waste/db/client"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { dropTenant, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
const AuditPage = Page(AuditEvent)

describe("the audit log through the API", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let olivia: Call
  let viewer: Call
  let other: Call

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    const app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    if (b) await dropTenant(pool, b.companyId)
    await pool?.close()
  })

  const history = async (call: Call, query: string) => {
    const response = await call(`/audit-events?${query}`)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return AuditPage.parse(await response.json())
  }
  const posted = async <T extends { id: string }>(call: Call, path: string, body: unknown, schema: { parse: (value: unknown) => T }): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body }), schema)
  const customerNamed = (call: Call, name: string) => posted(call, "/customers", { kind: "organisation", name }, Customer)

  test("a write is the principal's, with the reason its header gives; a row's history reads newest first", async () => {
    const reason = "Flyttet til boligselskabet – ny betaler fra 1. november"
    const customer = await customerNamed(olivia, "Østerbro Housing")
    const patched = await olivia(`/customers/${customer.id}`, { method: "PATCH", body: { name: "Østerbro Boligselskab" }, headers: { [CHANGE_REASON_HEADER]: encodeURIComponent(reason) } })
    assert.equal(patched.status, 200)
    const page = await history(olivia, `table=customer&rowId=${customer.id}`)
    assert.deepEqual(page.items.map((item) => item.action), ["update", "insert"], "newest first")
    const [renamed, made] = page.items
    assert.deepEqual(renamed.changed, { name: ["Østerbro Housing", "Østerbro Boligselskab"] })
    assert.equal(renamed.reason, reason, "percent-decoded, in any script")
    assert.equal(made.reason, null, "a write without the header says no reason")
    for (const item of page.items) {
      assert.deepEqual(item.actor, { id: a.users.olivia.id, fullName: "Olivia Larsen" })
      assert.deepEqual([item.table, item.rowId, item.parentTable, item.projectId], ["customer", customer.id, null, null])
    }
    assert.equal(page.nextCursor, null)
  })

  test("the reason is bounded and must decode: too long or malformed is a 400 naming the header, and nothing is written; a blank one is no reason", async () => {
    const customer = await customerNamed(olivia, "Nørrebro Housing")
    for (const value of [encodeURIComponent("x".repeat(2001)), "%E0%A4%A"]) {
      const refused = await olivia(`/customers/${customer.id}`, { method: "PATCH", body: { name: "Never written" }, headers: { [CHANGE_REASON_HEADER]: value } })
      assert.equal(refused.status, 400)
      assert.deepEqual((await readProblem(refused)).errors?.map((error) => error.path), [CHANGE_REASON_HEADER])
    }
    assert.equal(((await (await olivia(`/customers/${customer.id}`)).json()) as Customer).name, "Nørrebro Housing")
    const blank = await olivia(`/customers/${customer.id}`, { method: "PATCH", body: { name: "Nørrebro Boligselskab" }, headers: { [CHANGE_REASON_HEADER]: "%20%20" } })
    assert.equal(blank.status, 200)
    const [renamed] = (await history(olivia, `table=customer&rowId=${customer.id}`)).items
    assert.equal(renamed.reason, null)
  })

  test("a role's history holds its matrix's changes under it, one PUT one transaction", async () => {
    const role = await posted(olivia, "/roles", { name: "Night desk", scope: "Company", description: "Tickets after hours", grants: [{ moduleKey: "operate.tickets", actions: ["view"] }] }, Role)
    const put = await olivia(`/roles/${role.id}/grants`, { method: "PUT", body: { grants: [{ moduleKey: "operate.tickets", actions: ["edit"] }, { moduleKey: "customers.contacts", actions: ["view"] }] } })
    assert.equal(put.status, 200)
    const page = await history(olivia, `table=role&rowId=${role.id}`)
    const grants = page.items.filter((item) => item.table === "role_grant")
    assert.ok(grants.every((item) => item.parentTable === "role" && item.parentId === role.id))
    const replaced = grants.filter((item) => item.transactionId === grants[0].transactionId)
    assert.deepEqual(
      replaced.map((item) => [item.action, item.changed.module_key?.[0] ?? item.changed.module_key?.[1], item.changed.action?.[0] ?? item.changed.action?.[1]]).sort(),
      [
        ["delete", "operate.tickets", "view"],
        ["insert", "customers.contacts", "view"],
        ["insert", "operate.tickets", "edit"],
        ["insert", "operate.tickets", "view"],
      ],
      "the PUT replaced the set: the old row gone, the new rows written, together",
    )
    assert.ok(page.items.some((item) => item.table === "role" && item.action === "insert"))
  })

  test("a row's history asks view on the module its table belongs to; an unknown table, or a table without a row, is a 400", async () => {
    const customer = await customerNamed(olivia, "Amager Housing")
    const refused = await viewer(`/audit-events?table=customer&rowId=${customer.id}`)
    assert.equal(refused.status, 403)
    assert.match((await readProblem(refused)).detail ?? "", /view on customers\.contacts/)
    assert.equal((await viewer(`/audit-events?table=role&rowId=${a.roles.viewer.id}`)).status, 200, "the viewer views configure.access")
    const unknown = await olivia(`/audit-events?table=route&rowId=${customer.id}`)
    assert.equal(unknown.status, 400)
    assert.deepEqual((await readProblem(unknown)).errors?.map((error) => error.path), ["table"])
    const half = await olivia("/audit-events?table=customer")
    assert.equal(half.status, 400)
    assert.deepEqual((await readProblem(half)).errors?.map((error) => error.path), ["rowId"])
  })

  test("the company's whole history asks view on configure.privacy; another company's rows are never there", async () => {
    const customer = await customerNamed(olivia, "Valby Housing")
    const company = await history(olivia, "limit=200")
    assert.ok(company.items.some((item) => item.rowId === customer.id))
    const refused = await viewer("/audit-events")
    assert.equal(refused.status, 403)
    assert.match((await readProblem(refused)).detail ?? "", /view on configure\.privacy/)
    assert.deepEqual((await history(other, `table=customer&rowId=${customer.id}`)).items, [])
  })

  test("a project-scoped row of a project the caller does not work in has no history for them", async () => {
    // The viewer works in Copenhagen Central alone; given view on the properties, it reads their history there and nowhere else.
    const granted = await olivia(`/roles/${a.roles.viewer.id}/grants`, { method: "PUT", body: { grants: [...a.roles.viewer.grants, { moduleKey: "customers.properties", actions: ["view"] }] } })
    assert.equal(granted.status, 200)
    const property = (projectId: string, name: string) => posted(olivia, "/properties", { projectId, name, address: `${name}, 1000 København`, kind: "residential" }, Property)
    const mine = await property(a.projects.copenhagen.id, "Parkvej 18")
    const theirs = await property(a.projects.harbor.id, "Havnegade 2")
    assert.equal((await history(viewer, `table=property&rowId=${mine.id}`)).items.length, 1)
    assert.deepEqual((await history(viewer, `table=property&rowId=${theirs.id}`)).items, [])
    assert.equal((await history(olivia, `table=property&rowId=${theirs.id}`)).items.length, 1, "the administrator works in every project")
  })
})
