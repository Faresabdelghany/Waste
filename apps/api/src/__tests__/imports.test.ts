// The CSV import (#291 slice 12) over one company: its templates, the
// preview that stores nothing, and a run written a batch at a time, safe to
// send twice — for each kind, the records it makes, the ones it matches and
// changes or leaves as they stand, and the rows it refuses in the families'
// own sentences, the column first. Then the grants, per request and per row,
// and the fences: a run of a project the caller does not work in, and
// another company's, are runs that do not exist here.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Agreement, Subscription } from "@waste/contracts/agreements"
import { ContainerType, Product } from "@waste/contracts/catalogue"
import { Container } from "@waste/contracts/containers"
import { Customer, Property, SharedCollectionPoint } from "@waste/contracts/customers"
import { ImportBatchResult, ImportPreview, ImportRun, ImportRunRow, type ImportKind, type ImportRowResult } from "@waste/contracts/imports"
import { Page } from "@waste/contracts/pagination"
import { PriceList } from "@waste/contracts/price-lists"
import { createDb, type Database } from "@waste/db/client"
import { IMPORT_COLUMNS } from "@waste/domain/imports/columns"

import { createApp } from "../app"
import { callingAs, type Call } from "./calls"
import { created } from "./created"
import { databaseUnderTest, ownerUnderTest } from "./database"
import { readProblem } from "./read-problem"
import { pointBody } from "./registry"
import { dropTenant, grantRole, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()
/** The owner sweeps the runs' rows, a ledger `wms_api` may not delete. */
const owner = ownerUnderTest()
const ImportRunPage = Page(ImportRun)
const ImportRunRowPage = Page(ImportRunRow)
const CustomerPage = Page(Customer)
const AgreementPage = Page(Agreement)
const SubscriptionPage = Page(Subscription)

const JANUARY = "2026-01-01"
const JULY = "2026-07-01"

type Cells = Record<string, string>
type Schema<T> = { parse: (value: unknown) => T }

/** A file's rows as the browser sends them: the header is row 1, so the first record is row 2. */
const rowsOf = (...cells: Cells[]) => cells.map((values, index) => ({ row: index + 2, values }))

/** What a row came to, less what only the database knows. */
const outcome = (result: ImportRowResult | undefined) => (result === undefined ? undefined : { row: result.row, outcome: result.outcome, key: result.key, detail: result.detail })

describe("the import endpoints", { skip: database.skip || owner.skip }, () => {
  let pool: Database
  let ownerPool: Database
  let keys: SigningKeys
  let a: Tenant
  let b: Tenant
  let app: ReturnType<typeof createApp>
  let olivia: Call
  /** The custom role on Copenhagen Central only: the import's grants, and `view` and `edit` on Customers and nothing more, so a new customer is refused and a match written. */
  let viewer: Call
  /** The Service Provider Manager: no grant on the import at all. */
  let lars: Call
  /** Another company's administrator. */
  let other: Call
  /** Another company's viewer: the import's own grant and nothing on what it writes. */
  let ungranted: Call
  let copenhagen: string
  let harbor: string

  let acme: Customer
  let boligforening: Customer
  let parkvej: Property
  let bin: ContainerType
  let residual: Product
  let bank: SharedCollectionPoint
  let tariff: PriceList

  const create = async <T extends { id: string }>(call: Call, path: string, values: unknown, schema: Schema<T>): Promise<T> =>
    created(call, path, await call(path, { method: "POST", body: values }), schema)

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    ownerPool = createDb(owner.url, { max: 1 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    b = await seedTenant(pool)
    copenhagen = a.projects.copenhagen.id
    harbor = a.projects.harbor.id
    await grantRole(pool, a.companyId, a.roles.viewer.id, [
      { moduleKey: "improve.imports", actions: ["view", "create"] },
      { moduleKey: "customers.contacts", actions: ["view", "edit"] },
      { moduleKey: "customers.properties", actions: ["view"] },
    ])
    await grantRole(pool, b.companyId, b.roles.viewer.id, [{ moduleKey: "improve.imports", actions: ["view", "create"] }])
    app = createApp({ probe: pool, pool, verifier: keys.verifier })
    olivia = callingAs(app, keys, a.users.olivia, a.companyId)
    viewer = callingAs(app, keys, a.users.viewer, a.companyId)
    lars = callingAs(app, keys, a.users.lars, a.companyId)
    other = callingAs(app, keys, b.users.olivia, b.companyId)
    ungranted = callingAs(app, keys, b.users.viewer, b.companyId)

    acme = await create(olivia, "/customers", { kind: "organisation", name: "Acme Housing", registrationNumber: "11111111", phone: "+45 11 11 11 11" }, Customer)
    boligforening = await create(olivia, "/customers", { kind: "organisation", name: "Kystbyen Boligforening", email: "admin@boligforening.example" }, Customer)
    // Two customers behind one administrator's address, which therefore names neither.
    await create(olivia, "/customers", { kind: "organisation", name: "Strandvej Ejerforening", email: "office@administrator.example" }, Customer)
    await create(olivia, "/customers", { kind: "organisation", name: "Havnevej Ejerforening", email: "office@administrator.example" }, Customer)
    parkvej = await create(olivia, "/properties", { projectId: copenhagen, name: "Parkvej 18", address: "Parkvej 18, 2100 København Ø", kind: "residential" }, Property)
    bin = await create(olivia, "/container-types", { name: "240 L bin", volumeLitres: 240 }, ContainerType)
    residual = await create(olivia, "/products", { projectId: copenhagen, name: "Residual collection", kind: "container-collection", unit: "pickup", status: "active" }, Product)
    bank = await create(olivia, "/shared-collection-points", pointBody(copenhagen, "Parkvej bank", "open"), SharedCollectionPoint)
    tariff = await create(olivia, "/price-lists", { projectId: copenhagen, code: "cph-2026", name: "Copenhagen 2026", validFrom: JANUARY }, PriceList)
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId, ownerPool)
    if (b) await dropTenant(pool, b.companyId, ownerPool)
    await pool?.close()
    await ownerPool?.close()
  })

  const preview = async (call: Call, kind: ImportKind, rows: ReturnType<typeof rowsOf>, projectId?: string): Promise<ImportPreview> => {
    const response = await call("/imports/preview", { method: "POST", body: { kind, projectId, fileName: `${kind}.csv`, rows } })
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return ImportPreview.parse(await response.json())
  }
  const startRun = (call: Call, kind: ImportKind, rowCount: number, projectId?: string): Promise<ImportRun> =>
    create(call, "/imports", { kind, projectId, fileName: `${kind}.csv`, rowCount }, ImportRun)
  const sendBatch = async (call: Call, run: ImportRun, rows: ReturnType<typeof rowsOf>): Promise<ImportBatchResult> => {
    const response = await call(`/imports/${run.id}/rows`, { method: "POST", body: { rows } })
    assert.equal(response.status, 201, JSON.stringify(await response.clone().json()))
    assert.equal(response.headers.get("location"), null, "the rows are appended to the run's ledger and read there")
    return ImportBatchResult.parse(await response.json())
  }
  /** A whole file through one run and one batch. */
  const commit = async (call: Call, kind: ImportKind, rows: ReturnType<typeof rowsOf>, projectId?: string): Promise<ImportBatchResult> =>
    sendBatch(call, await startRun(call, kind, rows.length, projectId), rows)
  const customersNamed = async (name: string): Promise<Customer[]> => {
    const response = await olivia("/customers?limit=200")
    return CustomerPage.parse(await response.json()).items.filter((customer) => customer.name === name)
  }
  const read = async <T>(path: string, schema: Schema<T>, call: Call = olivia): Promise<T> => {
    const response = await call(path)
    assert.equal(response.status, 200, JSON.stringify(await response.clone().json()))
    return schema.parse(await response.json())
  }

  describe("GET /imports/templates/:kind", () => {
    test("answers each kind's header row as a UTF-8 CSV attachment, with commas or, asked, semicolons", async () => {
      for (const kind of ["customers", "properties", "containers", "agreements"] as const) {
        const response = await olivia(`/imports/templates/${kind}`)
        assert.equal(response.status, 200)
        assert.equal(response.headers.get("content-type"), "text/csv; charset=utf-8")
        assert.equal(response.headers.get("content-disposition"), `attachment; filename="${kind}-import-template.csv"`)
        const bytes = new Uint8Array(await response.arrayBuffer())
        assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], "the byte-order mark a spreadsheet reads UTF-8 by")
        assert.equal(new TextDecoder().decode(bytes.slice(3)), `${IMPORT_COLUMNS[kind].map((column) => column.header).join(",")}\r\n`)
      }
      const semicolons = await olivia("/imports/templates/customers?separator=semicolon")
      assert.equal((await semicolons.text()).replace(/^﻿/, ""), `${IMPORT_COLUMNS.customers.map((column) => column.header).join(";")}\r\n`)
    })

    test("refuses a kind there is no import of, and a role without the import's grant", async () => {
      assert.equal((await olivia("/imports/templates/vehicles")).status, 400)
      assert.equal((await lars("/imports/templates/customers")).status, 403)
    })
  })

  describe("POST /imports/preview", () => {
    test("answers what each customer row would become and stores nothing: made, matched and left, matched and changed, refused in the column's sentence", async () => {
      const result = await preview(
        olivia,
        "customers",
        rowsOf(
          { kind: "organisation", name: "Nordhavn Erhverv", "registration number": "22222222" },
          { kind: "person", name: "Ida Holm", email: "Ida.Holm@example.com" },
          { kind: "organisation", name: "Acme Housing", "registration number": "11111111", phone: "+45 11 11 11 11" },
          { kind: "organisation", name: "Acme Housing", "registration number": "11111111", phone: "+45 99 99 99 99" },
          { kind: "organisation", name: "Kystbyen Boligforening", email: "ADMIN@boligforening.example", "service messages": "no" },
          { kind: "organisation", name: "No Key At All" },
          { name: "No Kind", email: "nokind@example.com" },
          { kind: "robot", name: "Wrong Kind", email: "robot@example.com" },
          { kind: "person", name: "Bad Mail", email: "not-an-email" },
          { kind: "person", name: "Unsure", email: "unsure@example.com", "service messages": "maybe" },
          { kind: "organisation", name: "Shared Address", email: "office@administrator.example" },
          // The row before made Nordhavn: this one sees it, as the commit would.
          { kind: "organisation", name: "Nordhavn Erhverv", "registration number": "22222222", phone: "+45 22 22 22 22" },
        ),
      )
      const rows = result.rows.map(outcome)
      assert.deepEqual(rows[0], { row: 2, outcome: "created", key: "registration number 22222222", detail: null })
      assert.deepEqual(rows[1], { row: 3, outcome: "created", key: "email ida.holm@example.com", detail: null })
      assert.deepEqual(rows[2], { row: 4, outcome: "unchanged", key: "registration number 11111111", detail: null })
      assert.equal(result.rows[2]?.resourceId, acme.id)
      assert.deepEqual(rows[3], { row: 5, outcome: "updated", key: "registration number 11111111", detail: null })
      assert.deepEqual(rows[4], { row: 6, outcome: "updated", key: "email admin@boligforening.example", detail: null }, "the e-mail matched whatever its case, and service messages moved")
      assert.equal(result.rows[4]?.resourceId, boligforening.id)
      assert.deepEqual(rows[5], { row: 7, outcome: "refused", key: null, detail: "registration number: give it or the e-mail: a customer is matched on one" })
      assert.deepEqual(rows[6], { row: 8, outcome: "refused", key: "email nokind@example.com", detail: "kind: give it on every row" })
      assert.match(rows[7]?.detail ?? "", /^kind: Invalid option/)
      assert.match(rows[8]?.detail ?? "", /^email: Invalid email/)
      assert.equal(rows[9]?.detail, "service messages: yes or no")
      assert.equal(rows[10]?.detail, "email: 2 customers have the e-mail office@administrator.example: give the registration number to say which")
      assert.deepEqual(rows[11], { row: 13, outcome: "updated", key: "registration number 22222222", detail: null })
      assert.deepEqual(result.counts, { created: 2, updated: 3, unchanged: 1, refused: 6 })

      assert.deepEqual(await customersNamed("Nordhavn Erhverv"), [], "a preview stores nothing")
      const stored = await read(`/customers/${acme.id}`, Customer)
      assert.equal(stored.phone, "+45 11 11 11 11")
    })

    test("refuses a cell under a header the kind does not know, at the cell, and holds the project to the kind", async () => {
      const unknown = await olivia("/imports/preview", { method: "POST", body: { kind: "customers", fileName: "c.csv", rows: rowsOf({ kind: "person", name: "X", colour: "red" }) } })
      assert.equal(unknown.status, 400)
      const problem = await readProblem(unknown)
      assert.equal(problem.errors?.[0]?.path, "rows.0.values.colour")
      assert.match(problem.errors?.[0]?.message ?? "", /^Not a column of a customers import; the columns are kind, name, registration number/)

      const named = await olivia("/imports/preview", { method: "POST", body: { kind: "customers", projectId: copenhagen, fileName: "c.csv", rows: rowsOf({ kind: "person", name: "X" }) } })
      assert.deepEqual((await readProblem(named)).errors, [{ path: "projectId", message: "Customers are the company's, not a project's: an import of customers names no project" }])
      const missing = await olivia("/imports/preview", { method: "POST", body: { kind: "properties", fileName: "p.csv", rows: rowsOf({ address: "X" }) } })
      assert.deepEqual((await readProblem(missing)).errors?.map((error) => error.path), ["projectId"])
      const outOfReach = await viewer("/imports/preview", { method: "POST", body: { kind: "properties", projectId: harbor, fileName: "p.csv", rows: rowsOf({ address: "X" }) } })
      assert.deepEqual((await readProblem(outOfReach)).errors, [{ path: "projectId", message: "Not a project this account works in" }])
    })

    test("asks the import's create and the target module's view of the request, and the target's create per row", async () => {
      assert.equal((await lars("/imports/preview", { method: "POST", body: { kind: "customers", fileName: "c.csv", rows: rowsOf({ kind: "person", name: "X" }) } })).status, 403)
      const blind = await ungranted("/imports/preview", { method: "POST", body: { kind: "customers", fileName: "c.csv", rows: rowsOf({ kind: "person", name: "X", email: "x@example.com" }) } })
      assert.equal(blind.status, 403)
      assert.equal((await readProblem(blind)).detail, "This account's role does not allow view on customers.contacts")

      const result = await preview(
        viewer,
        "customers",
        rowsOf({ kind: "organisation", name: "Brand New", "registration number": "33333333" }, { kind: "organisation", name: "Acme Housing", "registration number": "11111111", phone: "+45 33 33 33 33" }),
      )
      assert.deepEqual(result.rows.map(outcome), [
        { row: 2, outcome: "refused", key: "registration number 33333333", detail: "This account's role does not allow create on customers.contacts" },
        { row: 3, outcome: "updated", key: "registration number 11111111", detail: null },
      ])
    })
  })

  describe("POST /imports and POST /imports/:id/rows", () => {
    test("writes a run a batch at a time, records each row, answers a batch sent again as recorded, and refuses rows beyond the file", async () => {
      const run = await startRun(olivia, "customers", 3)
      assert.deepEqual([run.kind, run.projectId, run.rowCount, run.status, run.requestedBy], ["customers", null, 3, "running", a.users.olivia.id])
      assert.deepEqual(run.counts, { created: 0, updated: 0, unchanged: 0, refused: 0 })

      const first = rowsOf({ kind: "organisation", name: "Batch One", "registration number": "44444444" }, { kind: "organisation", name: "No Key" })
      const answered = await sendBatch(olivia, run, first)
      assert.deepEqual(answered.rows.map((row) => row.outcome), ["created", "refused"])
      assert.deepEqual(answered.run.counts, { created: 1, updated: 0, unchanged: 0, refused: 1 })
      assert.equal(answered.run.status, "running")
      const [made] = await customersNamed("Batch One")
      assert.equal(made?.id, answered.rows[0]?.resourceId)

      // The answer was lost and the batch is sent again whole: nothing is written twice.
      const again = await sendBatch(olivia, run, first)
      assert.deepEqual(again.rows, answered.rows)
      assert.deepEqual(again.run.counts, answered.run.counts)
      assert.equal((await customersNamed("Batch One")).length, 1)

      const tooMany = await olivia(`/imports/${run.id}/rows`, { method: "POST", body: { rows: [{ row: 4, values: { kind: "person", name: "Four", email: "four@example.com" } }, { row: 5, values: { kind: "person", name: "Five", email: "five@example.com" } }] } })
      assert.equal(tooMany.status, 409)
      assert.equal((await readProblem(tooMany)).detail, "The run holds 3 rows and has recorded 2; this batch would record 2 more")
      assert.deepEqual(await customersNamed("Four"), [], "a refused batch writes nothing")

      const last = await sendBatch(olivia, run, [{ row: 4, values: { kind: "organisation", name: "Batch One", "registration number": "44444444" } }])
      assert.deepEqual(last.rows.map((row) => row.outcome), ["unchanged"])
      assert.equal(last.run.status, "completed")
      assert.deepEqual(last.run.counts, { created: 1, updated: 0, unchanged: 1, refused: 1 })

      const stored = await read(`/imports/${run.id}`, ImportRun)
      assert.deepEqual(stored.counts, last.run.counts)
      const rows = await read(`/imports/${run.id}/rows`, ImportRunRowPage)
      assert.deepEqual(rows.items.map((row) => [row.row, row.outcome]), [[2, "created"], [3, "refused"], [4, "unchanged"]])
      const refusals = await read(`/imports/${run.id}/rows?outcome=refused`, ImportRunRowPage)
      assert.deepEqual(refusals.items.map((row) => [row.row, row.detail]), [[3, "registration number: give it or the e-mail: a customer is matched on one"]])
    })

    test("writes properties with their parties, matching an address whatever its case and spacing", async () => {
      const result = await commit(
        olivia,
        "properties",
        rowsOf(
          { address: "Strandvejen 4, 2100 København Ø", name: "Strandvejen 4", kind: "residential", parties: "owner: 11111111; payer: admin@boligforening.example" },
          { address: "  parkvej 18,   2100 København Ø ", name: "Parkvej 18", kind: "residential", "registry id": "100023456", parties: "owner: 11111111" },
          { address: "Parkvej 18, 2100 København Ø", name: "Parkvej 18", kind: "residential" },
          { address: "Søndergade 1", name: "Søndergade 1", kind: "residential", parties: "landlord: 11111111" },
          { address: "Søndergade 2", name: "Søndergade 2", kind: "residential", parties: "owner: 99999999" },
          { address: "Søndergade 3", name: "Søndergade 3", kind: "castle" },
        ),
        copenhagen,
      )
      assert.deepEqual(result.rows.slice(0, 5).map(outcome), [
        { row: 2, outcome: "created", key: "address Strandvejen 4, 2100 København Ø", detail: null },
        // A cell is trimmed before it is read, whoever sent it.
        { row: 3, outcome: "updated", key: "address parkvej 18,   2100 København Ø", detail: null },
        { row: 4, outcome: "unchanged", key: "address Parkvej 18, 2100 København Ø", detail: null },
        { row: 5, outcome: "refused", key: "address Søndergade 1", detail: "parties: landlord is not a role; the roles are owner, payer, tenant, administrator, service-contact" },
        { row: 6, outcome: "refused", key: "address Søndergade 2", detail: "parties: No customer of this company has registration number 99999999" },
      ])
      assert.equal(result.rows[5]?.outcome, "refused")
      assert.match(result.rows[5]?.detail ?? "", /^kind: Invalid option/)
      assert.equal(result.rows[1]?.resourceId, parkvej.id)
      const strandvejen = await read(`/properties/${result.rows[0]!.resourceId}`, Property)
      assert.deepEqual(
        strandvejen.parties.map((party) => [party.customerId, party.role]).sort(),
        [[acme.id, "owner"], [boligforening.id, "payer"]].sort(),
      )
      const corrected = await read(`/properties/${parkvej.id}`, Property)
      assert.equal(corrected.registryId, "100023456")
      assert.equal(corrected.address, "Parkvej 18, 2100 København Ø", "the key's own cell is never patched")
      assert.deepEqual(corrected.parties.map((party) => [party.customerId, party.role]), [[acme.id, "owner"]])
    })

    test("writes containers by label, naming the type, and refuses a label of another project and a type the company has not", async () => {
      await create(olivia, "/containers", { projectId: harbor, label: "HARBOR-1", containerTypeId: bin.id }, Container)
      const result = await commit(
        olivia,
        "containers",
        rowsOf(
          { label: "CPH-1", "container type": "240 L bin", barcode: "5701", ownership: "Customer" },
          { label: "CPH-1", "container type": "240 L bin", barcode: "5702" },
          { label: "HARBOR-1", "container type": "240 L bin" },
          { label: "CPH-2", "container type": "660 L bin" },
        ),
        copenhagen,
      )
      assert.deepEqual(result.rows.map(outcome), [
        { row: 2, outcome: "created", key: "label CPH-1", detail: null },
        { row: 3, outcome: "updated", key: "label CPH-1", detail: null },
        { row: 4, outcome: "refused", key: "label HARBOR-1", detail: "label: This company already has a container labelled HARBOR-1, in another project" },
        { row: 5, outcome: "refused", key: "label CPH-2", detail: "container type: No container type of this company is named 660 L bin" },
      ])
      const made = await read(`/containers/${result.rows[0]!.resourceId}`, Container)
      assert.deepEqual([made.projectId, made.containerTypeId, made.barcode, made.ownership], [copenhagen, bin.id, "5702", "customer"])
    })

    test("writes agreements with a subscription per row, both or neither, matched on the number and the first day", async () => {
      const result = await commit(
        olivia,
        "agreements",
        rowsOf(
          { number: "IMP-1", customer: "11111111", payer: "admin@boligforening.example", "billing cadence": "Monthly", "valid from": JANUARY, "price list": "CPH-2026", product: "Residual collection", property: "Parkvej 18, 2100 København Ø", quantity: "2" },
          { number: "IMP-1", customer: "11111111", payer: "admin@boligforening.example", "billing cadence": "monthly", "valid from": JANUARY, product: "Residual collection", "shared collection point": "Parkvej bank" },
          { number: "IMP-1", customer: "11111111", "billing cadence": "monthly", "valid from": JANUARY, product: "Residual collection", property: "parkvej 18, 2100 København Ø", quantity: "2" },
          { number: "IMP-1", customer: "11111111", "billing cadence": "monthly", "valid from": JANUARY, product: "Residual collection", property: "Parkvej 18, 2100 København Ø", quantity: "3" },
          { number: "IMP-2", customer: "11111111", "billing cadence": "monthly", "valid from": JANUARY, product: "Garden waste", property: "Parkvej 18, 2100 København Ø" },
          { number: "IMP-3", customer: "11111111", "billing cadence": "monthly", "valid from": JANUARY, quantity: "1" },
          { number: "IMP-4", customer: "11111111", "billing cadence": "monthly", "valid from": "1 January", product: "Residual collection" },
          { number: "IMP-5", customer: "11111111", "billing cadence": "monthly", "valid from": JULY, "subscription from": JANUARY, product: "Residual collection", "shared collection point": "Parkvej bank" },
          { number: "IMP-6", customer: "11111111", "billing cadence": "monthly", "valid from": JULY, status: "active" },
          // IMP-6's payer is its customer, its cell empty: a new customer takes the payer with it.
          { number: "IMP-6", customer: "admin@boligforening.example", "billing cadence": "monthly", "valid from": JULY },
          // IMP-1's payer was named apart, and stays when the customer moves with the payer's cell empty.
          { number: "IMP-1", customer: "44444444", "billing cadence": "monthly", "valid from": JANUARY },
          { number: "IMP-7", customer: "11111111", "billing cadence": "monthly", "valid from": JULY, product: "Residual collection", "shared collection point": "Parkvej bank", quantity: "99999999999" },
        ),
        copenhagen,
      )
      assert.deepEqual(result.rows.map(outcome), [
        { row: 2, outcome: "created", key: "number IMP-1 from 2026-01-01, Residual collection at Parkvej 18, 2100 København Ø", detail: null },
        { row: 3, outcome: "created", key: "number IMP-1 from 2026-01-01, Residual collection at Parkvej bank", detail: null },
        { row: 4, outcome: "unchanged", key: "number IMP-1 from 2026-01-01, Residual collection at parkvej 18, 2100 København Ø", detail: null },
        { row: 5, outcome: "updated", key: "number IMP-1 from 2026-01-01, Residual collection at Parkvej 18, 2100 København Ø", detail: null },
        { row: 6, outcome: "refused", key: "number IMP-2 from 2026-01-01, Garden waste at Parkvej 18, 2100 København Ø", detail: "product: No product of this project is named Garden waste" },
        { row: 7, outcome: "refused", key: "number IMP-3 from 2026-01-01", detail: "product: a subscription names its product: give it, or leave quantity empty" },
        { row: 8, outcome: "refused", key: "number IMP-4 from 1 January, Residual collection", detail: "valid from: a day as YYYY-MM-DD" },
        { row: 9, outcome: "refused", key: "number IMP-5 from 2026-07-01, Residual collection at Parkvej bank from 2026-01-01", detail: "subscription from: Outside the agreement's period" },
        { row: 10, outcome: "created", key: "number IMP-6 from 2026-07-01", detail: null },
        { row: 11, outcome: "updated", key: "number IMP-6 from 2026-07-01", detail: null },
        { row: 12, outcome: "updated", key: "number IMP-1 from 2026-01-01", detail: null },
        { row: 13, outcome: "refused", key: "number IMP-7 from 2026-07-01, Residual collection at Parkvej bank", detail: "quantity: a whole number no larger than 2147483647" },
      ])
      const agreements = AgreementPage.parse(await (await olivia(`/agreements?projectId=${copenhagen}&limit=200`)).json()).items
      const imp1 = agreements.find((agreement) => agreement.number === "IMP-1")!
      assert.equal(imp1.id, result.rows[0]?.resourceId, "an agreements row names the agreement")
      // The price list was named CPH-2026 and is coded cph-2026: a code is matched case aside.
      const [batchOne] = await customersNamed("Batch One")
      assert.deepEqual([imp1.customerId, imp1.payerCustomerId, imp1.billingCadence, imp1.currency, imp1.priceListId, imp1.status], [batchOne?.id, boligforening.id, "monthly", "DKK", tariff.id, "draft"])
      const imp6 = agreements.find((agreement) => agreement.number === "IMP-6")
      assert.deepEqual([imp6?.customerId, imp6?.payerCustomerId], [boligforening.id, boligforening.id], "a payer that was the customer moved with it")
      assert.equal(agreements.some((agreement) => agreement.number === "IMP-5"), false, "a refused subscription takes its agreement with it")
      const lines = SubscriptionPage.parse(await (await olivia(`/agreements/${imp1.id}/subscriptions`)).json()).items
      assert.deepEqual(
        lines.map((line) => [line.productId, line.propertyId, line.sharedCollectionPointId, line.quantity, line.validFrom]),
        [
          [residual.id, parkvej.id, null, 3, JANUARY],
          [residual.id, null, bank.id, 1, JANUARY],
        ],
      )
    })

    test("asks the target's grants per row on a commit too, and writes what the role may", async () => {
      const result = await commit(
        viewer,
        "customers",
        rowsOf({ kind: "organisation", name: "Viewer's New", "registration number": "55555555" }, { kind: "organisation", name: "Acme Housing", "registration number": "11111111", phone: "+45 55 55 55 55" }),
      )
      assert.deepEqual(result.rows.map((row) => row.outcome), ["refused", "updated"])
      assert.equal((await read(`/customers/${acme.id}`, Customer)).phone, "+45 55 55 55 55")
      assert.deepEqual(await customersNamed("Viewer's New"), [])
    })
  })

  describe("GET /imports and GET /imports/:id", () => {
    test("lists the company's runs newest first, each kind and project as asked, and fences a project's run and another company's", async () => {
      const harborRun = await startRun(olivia, "containers", 1, harbor)
      const page = await read("/imports?limit=200", ImportRunPage)
      assert.equal(page.items[0]?.id, harborRun.id, "newest first")
      const ids = page.items.map((run) => run.id)
      assert.deepEqual([...ids].sort().reverse(), ids)
      assert.ok(page.items.every((run) => run.projectId === null || [copenhagen, harbor].includes(run.projectId)))
      assert.ok((await read("/imports?kind=agreements", ImportRunPage)).items.every((run) => run.kind === "agreements"))
      assert.deepEqual((await read(`/imports?projectId=${harbor}`, ImportRunPage)).items.map((run) => run.id), [harborRun.id])

      // The viewer works in Copenhagen Central alone: the company's Customers runs and Copenhagen's, never Harbor's.
      const seen = await read("/imports?limit=200", ImportRunPage, viewer)
      assert.ok(seen.items.length > 0)
      assert.ok(seen.items.every((run) => run.projectId === null || run.projectId === copenhagen))
      assert.equal((await viewer(`/imports/${harborRun.id}`)).status, 404)
      // A run's ledger names the records it matched, so the viewer, who reads customers and properties and no containers, reads no containers run, Copenhagen's included.
      assert.deepEqual([...new Set(seen.items.map((run) => run.kind))].sort(), ["customers", "properties"])
      const copenhagenContainers = page.items.find((run) => run.kind === "containers" && run.projectId === copenhagen)
      assert.ok(copenhagenContainers !== undefined)
      assert.equal((await viewer(`/imports/${copenhagenContainers.id}`)).status, 404)
      assert.equal((await viewer(`/imports/${copenhagenContainers.id}/rows`)).status, 404)
      assert.equal((await viewer(`/imports/${harborRun.id}/rows`, { method: "POST", body: { rows: rowsOf({ label: "X", "container type": "240 L bin" }) } })).status, 404)
      assert.equal((await other(`/imports/${harborRun.id}`)).status, 404)
      assert.deepEqual((await read("/imports", ImportRunPage, other)).items, [])
    })
  })
})
