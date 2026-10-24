import { readFile } from "node:fs/promises"

import type { Page } from "@playwright/test"

import { expect, test } from "./fixtures"
import { uniqueName } from "./env"
import { listAll, projectNamed, TESTER_PROJECT } from "./tester"

// Improve › Imports on the API (#291 slice 12, row 20.1). A customers file
// is read in the browser, previewed — nothing written — and committed: its
// new customers are the API's, its refused row is recorded with the API's
// sentence and read back from the run beside it. A properties file into a
// project writes a property with its parties, and the same file imported
// again finds it unchanged. The template downloads as the kind's header row.

type Customer = { id: string; name: string; registrationNumber: string | null; email: string | null }
type Property = { id: string; address: string; parties: { customerId: string; role: string }[] }
type ImportRun = { id: string; kind: string; fileName: string; counts: { created: number; updated: number; unchanged: number; refused: number }; status: string }

/** A CVR-shaped number no other run has used: eight digits, from the clock and a random tail. */
const freshCvr = () => `9${String(Date.now() % 1_000_000).padStart(6, "0")}${Math.floor(Math.random() * 10)}`

/** Hands the page's file input a CSV of these lines, as a person choosing a file would. */
async function chooseFile(page: Page, name: string, lines: string[]) {
  await page.getByTestId("import-file").setInputFiles({ name, mimeType: "text/csv", buffer: Buffer.from(`${lines.join("\r\n")}\r\n`, "utf8") })
  await expect(page.getByTestId("import-file-reading")).toContainText(name)
}

/** Picks an option of one of the screen's selects by its label. */
async function choose(page: Page, label: string, option: string) {
  await page.getByLabel(label, { exact: true }).click()
  await page.getByRole("option", { name: option, exact: true }).click()
}

/** The outcome badges of a results table, in row order, once they have arrived. */
const outcomesOf = (page: Page, table: string) => page.getByTestId(table).getByTestId("import-result-row").locator("td:nth-child(2)")

test("a customers file is previewed without a write, committed, and its refused row read back from the run", async ({ page, api }) => {
  const stem = uniqueName("e2e customers").replace(/\s+/g, "-")
  const fileName = `${stem}.csv`
  const organisation = uniqueName("E2E Import Org")
  const person = uniqueName("E2E Import Person")
  const cvr = freshCvr()
  const email = `${stem.toLowerCase()}@import-e2e.example`

  await page.goto("/improve/imports")
  await expect(page.getByTestId("imports-on-api")).toBeVisible()

  // The template is the kind's header row.
  const download = page.waitForEvent("download")
  await page.getByTestId("import-template").click()
  const template = await readFile(await (await download).path(), "utf8")
  expect(template.startsWith("﻿"), "the byte-order mark a spreadsheet reads UTF-8 by").toBe(true)
  expect(template.slice(1).split(/\r\n/)[0]).toBe("kind,name,registration number,email,phone,billing address,service messages,status")

  await chooseFile(page, fileName, [
    "Kind,Name,Registration number,Email,Shoe size",
    `organisation,${organisation},${cvr},,44`,
    `person,${person},,${email},42`,
    "organisation,No key at all,,,",
  ])
  await expect(page.getByTestId("import-file-reading")).toContainText("Not read: Shoe size")

  await page.getByTestId("import-preview").click()
  await expect(page.getByTestId("import-preview-card")).toContainText("2 new · 0 changed · 0 unchanged · 1 refused. Nothing has been written.")
  await expect(outcomesOf(page, "import-preview-rows")).toHaveText(["New", "New", "Refused"])
  await expect(page.getByTestId("import-preview-rows")).toContainText("registration number: give it or the e-mail: a customer is matched on one")
  expect((await listAll<Customer>(api, "/customers")).some((customer) => customer.name === organisation), "a preview writes nothing").toBe(false)

  await page.getByTestId("import-commit").click()
  await expect(page.getByTestId("import-result-card")).toContainText("Imported")
  await expect(page.getByTestId("import-result-card")).toContainText("3 of 3 rows · 2 new · 0 changed · 0 unchanged · 1 refused")

  const customers = await listAll<Customer>(api, "/customers")
  expect(customers.find((customer) => customer.name === organisation)?.registrationNumber).toBe(cvr)
  expect(customers.find((customer) => customer.name === person)?.email).toBe(email)

  // The run is the API's record of the commit, newest first.
  const runs = await api.get("/imports", { params: { kind: "customers", limit: 5 } })
  expect(runs.status()).toBe(200)
  const [run] = ((await runs.json()) as { items: ImportRun[] }).items
  expect([run?.fileName, run?.status, run?.counts]).toEqual([fileName, "completed", { created: 2, updated: 0, unchanged: 0, refused: 1 }])

  // Its refusal, beside it in the recent runs.
  const listed = page.getByTestId("import-runs").getByTestId("import-run").filter({ hasText: fileName })
  await expect(listed).toContainText("2 new · 0 changed · 0 unchanged · 1 refused")
  await listed.getByRole("button", { name: "Refusals" }).click()
  await expect(page.getByTestId("import-refusal")).toHaveCount(1)
  await expect(page.getByTestId("import-refusal")).toContainText("registration number: give it or the e-mail: a customer is matched on one")
})

test("a properties file writes a property and its parties into its project, and the same file again finds it unchanged", async ({ page, api }) => {
  const project = await projectNamed(api, TESTER_PROJECT)
  const owner = (await listAll<Customer>(api, "/customers")).find((customer) => customer.registrationNumber !== null)
  if (owner === undefined) throw new Error("the tenant holds no customer with a registration number")
  const address = `${uniqueName("Importvej")} 7, 2100 København Ø`
  const fileName = `${uniqueName("e2e properties").replace(/\s+/g, "-")}.csv`
  const lines = ["address;name;kind;parties", `${address};${address.split(",")[0]};residential;owner: ${owner.registrationNumber}`]

  await page.goto("/improve/imports")
  await choose(page, "What the file holds", "Properties")
  await choose(page, "Project", project.name)
  await chooseFile(page, fileName, lines)
  await page.getByTestId("import-preview").click()
  await expect(outcomesOf(page, "import-preview-rows")).toHaveText(["New"])
  await page.getByTestId("import-commit").click()
  await expect(page.getByTestId("import-result-card")).toContainText("1 of 1 rows · 1 new")

  const written = (await listAll<Property>(api, "/properties", { projectId: project.id })).find((property) => property.address === address)
  expect(written?.parties).toEqual([{ customerId: owner.id, role: "owner" }])

  // The same file again, its address spelled as a person might: matched, and nothing to change.
  await chooseFile(page, fileName, [lines[0], lines[1].replace(address, `  ${address.toUpperCase()} `)])
  await page.getByTestId("import-preview").click()
  await expect(outcomesOf(page, "import-preview-rows")).toHaveText(["Unchanged"])
})
