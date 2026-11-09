// The redirects of next.config.mjs, run through Next's own route builder: an
// address a browser may still hold from a page that is gone lands on the
// page that took its place. And the pages whose one job is a redirect, run
// as Next runs them.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { buildCustomRoute } from "next/dist/lib/build-custom-route"

import nextConfig from "../../next.config.mjs"
import ConfigurePage from "../../app/configure/page"
import ImprovePage from "../../app/improve/page"
import TemplatesPage from "../../app/templates/page"

/** Where a path is sent: the first redirect whose source matches, as Next tries them (with its own `/_next` kept out). */
async function redirectOf(pathname: string): Promise<string | undefined> {
  for (const rule of (await nextConfig.redirects?.()) ?? []) {
    const { regex } = buildCustomRoute("redirect", rule, ["/_next"])
    if (new RegExp(regex).test(pathname)) return rule.destination
  }
  return undefined
}

describe("the removed portfolio dashboard's addresses", () => {
  test("a project's pages go to the routes, the clients to Customers, the tasks and the inbox to Tickets", async () => {
    const landings: Record<string, string> = {
      "/projects/1": "/route-studio?module=routes",
      "/projects/1/backlog": "/route-studio?module=routes",
      "/clients": "/customers",
      "/clients/2": "/customers",
      "/tasks": "/tickets",
      "/inbox": "/tickets",
    }
    for (const [path, landing] of Object.entries(landings)) assert.equal(await redirectOf(path), landing, path)
  })

  test("the pages that took their place are not redirected", async () => {
    for (const path of ["/route-studio", "/customers", "/tickets", "/performance", "/operate"]) {
      assert.equal(await redirectOf(path), undefined, path)
    }
  })
})

/** Where a page that only redirects sends a browser: the address its `redirect` throws for Next to follow. */
function redirectedTo(page: () => unknown): string | undefined {
  try {
    page()
  } catch (thrown) {
    const digest = (thrown as { digest?: unknown }).digest
    if (typeof digest === "string" && digest.startsWith("NEXT_REDIRECT;")) return digest.split(";")[2]
    throw thrown
  }
  return undefined
}

describe("the pages that only redirect", () => {
  test("/templates opens Message templates, /configure Settings where it opens, and /improve the Dashboard", () => {
    assert.equal(redirectedTo(TemplatesPage), "/settings?pane=message-templates")
    assert.equal(redirectedTo(ConfigurePage), "/settings?pane=account")
    assert.equal(redirectedTo(ImprovePage), "/performance")
  })
})
