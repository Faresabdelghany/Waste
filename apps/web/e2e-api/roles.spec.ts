import type { Page } from "@playwright/test"

import { uniqueName } from "./env"
import { expect, test } from "./fixtures"
import { roleNamed } from "./tester"

// Settings › Users & roles › Roles on the Pilot (#291): a custom role is made
// with its copy and the matrix it starts from, its matrix saved whole in one
// PUT, and a system role's matrix shown read-only in the sentence the API
// refuses a change in — every seed restores it to its charter.

type Grant = { moduleKey: string; actions: string[] }
type RoleBody = { id: string; key: string | null; name: string; scope: string; description: string; system: boolean; grants: Grant[] }

const answerOf = (page: Page, method: string, path: RegExp) =>
  page.waitForResponse((response) => response.request().method() === method && path.test(new URL(response.url()).pathname.replace(/^\/waste-api/, "")))

const pairsOf = (grants: readonly Grant[]) => grants.flatMap((grant) => grant.actions.map((action) => `${grant.moduleKey}:${action}`)).sort()

async function openRoles(page: Page) {
  await page.goto("/settings?pane=access")
  await page.getByRole("tab", { name: /^Roles/ }).click()
  await expect(page.getByRole("row", { name: "Open permissions for Dispatcher" })).toBeVisible({ timeout: 15_000 })
}

test("Roles: a system role's matrix is read-only in the API's sentence; a new role starts from it and its matrix is saved whole in one PUT", async ({ page, api }) => {
  const dispatcher = (await (await api.get(`/roles/${(await roleNamed(api, "Dispatcher")).id}`)).json()) as RoleBody
  await openRoles(page)

  // The system role: every box shown, none to tick, and why.
  await page.getByRole("row", { name: "Open permissions for Dispatcher" }).click()
  await expect(page.getByTestId("role-permissions-kept")).toHaveText("Dispatcher is a system role, whose permissions every seed restores to its charter; make a custom role to allow something else.")
  const boxes = page.getByRole("checkbox", { name: /^Can (view|edit|create|delete) — / })
  await expect(boxes.first()).toBeDisabled()
  await expect(page.getByRole("button", { name: "Save permissions" })).toHaveCount(0)
  await page.getByRole("button", { name: "Roles", exact: true }).click()

  // New role, from the Dispatcher's permissions: the copy as typed and the matrix it starts from, posted in one RoleCreate.
  const name = uniqueName("E2E Night Dispatch")
  await page.getByRole("button", { name: "New role" }).click()
  const dialog = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "New role" }) })
  await dialog.getByLabel("Role name").fill(name)
  await dialog.getByRole("combobox", { name: "Scope" }).click()
  await page.getByRole("option", { name: "Assigned projects", exact: true }).click()
  await dialog.getByLabel("Description").fill("Live routes and tickets after hours")
  await dialog.getByRole("combobox", { name: "Start from" }).click()
  await page.getByRole("option", { name: "Dispatcher", exact: true }).click()
  const [created] = await Promise.all([answerOf(page, "POST", /^\/roles$/), dialog.getByRole("button", { name: "Create role" }).click()])
  expect(created.status()).toBe(201)
  expect(created.request().postDataJSON()).toEqual({ name, scope: "Assigned projects", description: "Live routes and tickets after hours", grants: dispatcher.grants })
  const role = (await created.json()) as RoleBody
  expect(role).toMatchObject({ name, key: null, system: false, grants: dispatcher.grants })

  // Its permissions open next, to change: one more box ticked, then one save, one PUT of the whole matrix.
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible()
  await expect(page.getByTestId("role-permissions-kept")).toHaveCount(0)
  const puts: string[] = []
  page.on("request", (request) => {
    if (request.method() === "PUT") puts.push(new URL(request.url()).pathname)
  })
  const save = page.getByRole("button", { name: "Save permissions" })
  await expect(save).toBeDisabled()
  const unticked = page.getByRole("checkbox", { name: /^Can delete — / }).and(page.locator('[data-state="unchecked"]')).first()
  await unticked.click()
  await expect(save).toBeEnabled()
  const [saved] = await Promise.all([answerOf(page, "PUT", new RegExp(`^/roles/${role.id}/grants$`)), save.click()])
  expect(saved.status()).toBe(200)
  expect(puts).toEqual([`/waste-api/roles/${role.id}/grants`])
  const answered = (await saved.json()) as RoleBody
  const added = pairsOf(answered.grants).filter((pair) => !pairsOf(dispatcher.grants).includes(pair))
  expect(added).toHaveLength(1)
  expect(added[0]).toMatch(/:delete$/)
  expect(pairsOf(dispatcher.grants).filter((pair) => !pairsOf(answered.grants).includes(pair))).toEqual([])
  expect(((await (await api.get(`/roles/${role.id}`)).json()) as RoleBody).grants).toEqual(answered.grants)
  await expect(page.getByText(`${name}'s permissions saved`)).toBeVisible()
  await expect(save).toBeDisabled()

  // The API holds the line for any other client: the system role's matrix is refused in the same sentence.
  const refused = await api.put(`/roles/${dispatcher.id}/grants`, { data: { grants: [] } })
  expect(refused.status()).toBe(409)
  expect(((await refused.json()) as { detail: string }).detail).toBe("Dispatcher is a system role, whose permissions every seed restores to its charter; make a custom role to allow something else")
  expect(((await (await api.get(`/roles/${dispatcher.id}`)).json()) as RoleBody).grants).toEqual(dispatcher.grants)
})
