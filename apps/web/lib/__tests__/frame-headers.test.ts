// The frame headers of next.config.mjs (#321), run through Next's own route
// builder, the one that writes them into the routes manifest a deployment
// answers by: every page refuses to be framed, the public Collection Days
// widget alone may be.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { buildCustomRoute } from "next/dist/lib/build-custom-route"

import nextConfig, { FRAME_HEADERS } from "../../next.config.mjs"

type Header = { key: string; value: string }

/** The headers a path answers, as Next applies them: every rule whose source matches, a later one's key overriding an earlier one's. */
async function headersOf(pathname: string): Promise<Record<string, string>> {
  const rules = (await nextConfig.headers?.()) ?? []
  const answered: Record<string, string> = {}
  for (const rule of rules) {
    const { regex } = buildCustomRoute("header", { ...rule, headers: rule.headers as Header[] })
    if (!new RegExp(regex).test(pathname)) continue
    for (const header of rule.headers as Header[]) answered[header.key.toLowerCase()] = header.value
  }
  return answered
}

describe("the frame headers", () => {
  test("every page refuses to be framed, the signed-in office's and the public ones alike", async () => {
    for (const path of ["/", "/login", "/operate", "/settings", "/route-studio", "/driver", "/p/kystbyen/sorting", "/p/kystbyen/calendar", "/p/kystbyen/calendar/01a0d2a4-a280-700c-8000-00000000000b", "/p/kystbyen/calendar/embedded", "/p/kystbyen/calendar/embed/a/b"]) {
      assert.deepEqual(await headersOf(path), { "content-security-policy": "frame-ancestors 'none'", "x-frame-options": "DENY" }, path)
    }
  })

  test("the widget a municipality embeds may be framed by anyone, its search and an address's days, and carries no X-Frame-Options", async () => {
    for (const path of ["/p/kystbyen/calendar/embed", "/p/kystbyen/calendar/embed/", "/p/kystbyen/calendar/embed/01a0d2a4-a280-700c-8000-00000000000b"]) {
      assert.deepEqual(await headersOf(path), { "content-security-policy": "frame-ancestors *" }, path)
    }
  })

  test("the two answers are the config's", () => {
    assert.deepEqual(FRAME_HEADERS.refused.map((header) => header.key), ["Content-Security-Policy", "X-Frame-Options"])
    assert.deepEqual(FRAME_HEADERS.embeddable, [{ key: "Content-Security-Policy", value: "frame-ancestors *" }])
  })
})
