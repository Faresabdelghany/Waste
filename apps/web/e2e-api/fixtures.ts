// The suite's fixtures (Issue #151): the browser's own API session as a
// request context, so a spec can read back through the API what it just did
// in the browser — a `Location` the browser followed, a row's shape — under
// the very token the page holds, and can prepare what the product's surfaces
// do not yet write (an Invitation, until #163 lands).
import { test as baseTest, request, type APIRequestContext, type APIResponse, type Browser, type BrowserContext, type BrowserContextOptions, type Page } from "@playwright/test"

import { API_SESSION_STORAGE_KEY } from "../lib/storage-keys"
import { E2E } from "./env"

export { expect } from "@playwright/test"

/** The access token a browser context holds, as lib/api/session-storage.ts persisted it, or null when nobody is signed in there. */
export async function accessTokenOf(context: BrowserContext): Promise<string | null> {
  const state = await context.storageState()
  for (const origin of state.origins) {
    const entry = origin.localStorage.find((item) => item.name === API_SESSION_STORAGE_KEY)
    if (entry === undefined) continue
    try {
      const parsed = JSON.parse(entry.value) as { accessToken?: unknown }
      return typeof parsed.accessToken === "string" ? parsed.accessToken : null
    } catch {
      return null
    }
  }
  return null
}

/** A request context on the API's own origin, speaking as the holder of `token`. */
export function apiAs(token: string): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: E2E.apiUrl,
    extraHTTPHeaders: { authorization: `Bearer ${token}`, accept: "application/json" },
  })
}

/** An RFC 9457 problem as the API answers one. */
export type Problem = { type?: string; title?: string; status?: number; detail?: string; errors?: { path: string; message: string }[] }

export async function problemOf(response: APIResponse): Promise<Problem> {
  return (await response.json()) as Problem
}

/**
 * A browser context nobody is signed in on. `browser.newContext()` in a test
 * takes the project's `use` options, the administrator's storage state
 * among them, so a second person's context has to say so.
 */
export function freshContext(browser: Browser, options: BrowserContextOptions = {}): Promise<BrowserContext> {
  return browser.newContext({ ...options, storageState: { cookies: [], origins: [] } })
}

/**
 * Signs a person in through the real form on /login and lands them; the page
 * ends up wherever `/me` sends them. A refusal — Auth's, or the landing's —
 * fails at once with the form's own sentence, rather than as a timeout that
 * says nothing about credentials.
 */
export async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto("/login")
  await page.getByLabel("E-mail").fill(email)
  await page.getByLabel("Password").fill(password)
  await page.getByRole("button", { name: "Sign in" }).click()
  const alert = page.locator("form, main").getByRole("alert").filter({ hasText: /\S/ }).first()
  const outcome = await Promise.race([
    page.waitForURL((url) => url.pathname !== "/login").then(() => null),
    alert.waitFor().then(() => alert.textContent()),
  ])
  if (outcome !== null) throw new Error(`sign-in as ${email} was refused: ${outcome.trim()}`)
}

/**
 * Records every toast a context's pages show, from the first paint on, so
 * one raised and dismissed before an assertion still counts: sonner's
 * `[data-sonner-toast]` items, as they are added. Read with `toastsOf`
 * before the page navigates away, since a new document starts a new record.
 */
export async function recordToasts(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const shown: string[] = []
    Object.assign(window, { __e2eToasts: shown })
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (!(node instanceof Element)) continue
          for (const toast of [node, ...node.querySelectorAll("[data-sonner-toast]")]) {
            if (toast.matches("[data-sonner-toast]")) shown.push(toast.textContent ?? "")
          }
        }
      }
    }).observe(document, { childList: true, subtree: true })
  })
}

/** The toasts the page's document has shown so far; undefined where `recordToasts` was not set up, so no assertion passes on nothing. */
export function toastsOf(page: Page): Promise<string[] | undefined> {
  return page.evaluate(() => (window as unknown as { __e2eToasts?: string[] }).__e2eToasts)
}

/**
 * Waits for the record store's chain of switched modules to land after a
 * page load (business-record-store.tsx loads them one after another once a
 * person is signed in). A spec that then acts on the account — deactivates
 * it, ages its session — acts on a page with no read in flight, since a read
 * still out would meet the refusal first and end the session before the
 * test asks for it; and a page that has settled shows every switched
 * module's server rows. Every slice of #81 lengthens the chain, so a spec
 * waits here rather than for one module's list.
 */
export async function chainLanded(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle")
}

type Fixtures = {
  /** The API as the administrator the setup project signed in: the token the browser under test holds. */
  api: APIRequestContext
}

export const test = baseTest.extend<Fixtures>({
  api: async ({ context }, use) => {
    const token = await accessTokenOf(context)
    if (token === null) throw new Error("the browser context holds no API session: did the setup project run?")
    const api = await apiAs(token)
    await use(api)
    await api.dispose()
  },
})
