import type { Request } from "@playwright/test"

import { accessTokenOf, apiAs, chainLanded, expect, freshContext, recordToasts, signIn, test, toastsOf } from "./fixtures"
import { E2E, uniqueName } from "./env"
import { ensureTester } from "./tester"

// Scenario 2: a grant refused in-session. The tester's role, Route Planner,
// views the customers and edits none of them, and views nothing of the
// organisation. The record store reads only the switched modules the role
// views (`viewableModules`, lib/api/records/modules.ts; Issue #145), so
// Company & Projects is never asked for and nobody is told of it: it is not
// granted, a state of its own and not a failed read (Issue #200), and the
// customers the API returns are listed, found and opened beside it. A
// change the role may not make is still sent, the API refuses it —
// `about:blank` 403 — and the person is told in the API's own words
// (business-record-store.tsx, `reportProblem`) while the session stays
// open: authentication and authorization are apart (lib/api/session.ts),
// and only the account's own refusal ends a session.
test("a role without the grant is refused in the API's words and stays signed in", async ({ api, browser }) => {
  await ensureTester(api, E2E.testerEmail)
  const name = uniqueName("E2E Refused Organisation")
  const created = await api.post("/customers", { data: { kind: "organisation", name } })
  expect(created.status(), await created.text()).toBe(201)

  const context = await freshContext(browser)
  await recordToasts(context)
  try {
    const page = await context.newPage()
    const asked: string[] = []
    page.on("request", (request: Request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith("/waste-api/")) asked.push(`${request.method()} ${path}`)
    })
    await signIn(page, E2E.testerEmail, E2E.loginPassword)
    const customersRead = page.waitForResponse((response) => response.request().method() === "GET" && new URL(response.url()).pathname === "/waste-api/customers")
    await page.goto("/customers?module=contacts")
    expect((await customersRead).status()).toBe(200)

    // The organisation is not the role's to view: the store never asked, so there is nothing to say.
    expect(asked.filter((call) => /\/waste-api\/(company|projects)\b/.test(call))).toEqual([])
    await expect(page.getByText("configure.organization could not be read from the API")).toHaveCount(0)

    // A status change on a customer is an edit the role does not hold: sent, refused in the API's words.
    // The search is typed once: the modules landing after it no longer clear it (#197), and a module not granted loses no row (#200).
    await page.getByRole("main").getByRole("textbox", { name: /^Search .+/ }).fill(name)
    await page.getByRole("button", { name: `Open ${name}` }).click()
    const sheet = page.getByRole("dialog")
    await expect(sheet.getByRole("heading", { name })).toBeVisible()
    await sheet.getByRole("button", { name: "Inactive" }).click()
    const governed = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: "Inactive" }) })
    await governed.getByLabel("Decision or action reason").fill("E2E: a planner may not change a customer")
    const [patched] = await Promise.all([
      page.waitForResponse((response) => response.request().method() === "PATCH" && new URL(response.url()).pathname.startsWith("/waste-api/customers/")),
      governed.getByRole("button", { name: "Confirm inactive" }).click(),
    ])
    expect(patched.status()).toBe(403)
    await expect(page.getByText("This account's role does not allow edit on customers.contacts").first()).toBeVisible()
    // Told as a toast, which the record catches; the organisation, not granted, was told to nobody.
    const toasts = await toastsOf(page)
    expect(toasts).toContainEqual(expect.stringContaining("This account's role does not allow edit on customers.contacts"))
    expect(toasts?.filter((toast) => toast.includes("configure.organization"))).toEqual([])

    // Still here, still signed in: the page was not sent to /login, and the token the browser holds is still taken.
    await expect(page).toHaveURL(/\/customers/)
    const token = await accessTokenOf(context)
    expect(token).not.toBeNull()
    const tester = await apiAs(token as string)
    try {
      const me = await tester.get("/me")
      expect(me.status()).toBe(200)
      const customers = await tester.get("/customers", { params: { limit: 1 } })
      expect(customers.status()).toBe(200)
      const projects = await tester.get("/projects", { params: { limit: 1 } })
      expect(projects.status()).toBe(403)
      expect(await projects.json()).toMatchObject({ type: "about:blank", status: 403, detail: "This account's role does not allow view on configure.organization" })
    } finally {
      await tester.dispose()
    }
  } finally {
    await context.close()
  }
})

// Issue #200: a pane backed by a module the role does not view says so, in
// the store's sentence, rather than reading forever — the Route Planner holds
// no grant on the master data nor on the accounts — and the store neither
// asks the API for those modules nor tells anyone of them.
test("a pane backed by a module the role does not view says so in place of rows, with nothing asked and nobody toasted", async ({ api, browser }) => {
  await ensureTester(api, E2E.testerEmail)
  const context = await freshContext(browser)
  await recordToasts(context)
  try {
    const page = await context.newPage()
    const asked: string[] = []
    page.on("request", (request: Request) => {
      const path = new URL(request.url()).pathname
      if (path.startsWith("/waste-api/")) asked.push(`${request.method()} ${path}`)
    })
    await signIn(page, E2E.testerEmail, E2E.loginPassword)

    // Each page's whole load runs, the modules the role views included, and nothing is told on either.
    await page.goto("/settings?pane=master-data")
    await expect(page.getByText("The master data could not be read from the API: Your role does not allow view on configure.master")).toBeVisible()
    await expect(page.getByText("Reading the master data from the API…")).toHaveCount(0)
    await chainLanded(page)
    expect(await toastsOf(page)).toEqual([])

    await page.goto("/settings?pane=access")
    await expect(page.getByText("The users are not shown to your role.")).toBeVisible()
    await expect(page.getByText("Your role does not allow view on configure.access").first()).toBeVisible()
    await expect(page.getByText("Reading the company's users from the API…")).toHaveCount(0)
    await chainLanded(page)
    expect(await toastsOf(page)).toEqual([])
    expect(asked.filter((call) => /\/waste-api\/(waste-fractions|container-types|service-frequencies|vehicle-types|users|roles|company|projects)\b/.test(call))).toEqual([])
  } finally {
    await context.close()
  }
})
