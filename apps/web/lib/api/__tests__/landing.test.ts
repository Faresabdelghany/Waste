// Where a person goes on the Pilot (Issue #150): the landing `/me` decides,
// the sign-in gate in front of every page but /login, where it sends an
// unsigned visitor, and the return to where they were going.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { afterSignIn, carriesNext, gateOf, landingOf, returnPath, signInTarget, type GateState } from "../landing"

const NORDREN = { id: "01a0d2a4-a280-7003-8000-000000000001", legalName: "NordRen ApS" }
const DRIVER = { driver: { id: "01a0d2a4-a280-7019-8000-000000000001" }, serviceProvider: null }
const OFFICE = { driver: null, serviceProvider: null }
const PROVIDER = { driver: null, serviceProvider: NORDREN }
/** A provider's own driver with a login: a driver profile and a Service Provider Access both. */
const PROVIDERS_DRIVER = { driver: { id: "01a0d2a4-a280-7019-8000-000000000002" }, serviceProvider: NORDREN }

describe("the landing", () => {
  test("a driver lands on the driver's app, a Service Provider's account on its workspace, everyone else on operations", () => {
    assert.equal(landingOf(DRIVER), "/driver")
    assert.equal(landingOf(PROVIDER), "/service-provider-workspace")
    assert.equal(landingOf(OFFICE), "/operate")
  })

  test("a Site attendant lands on the check-in, after a driver and a provider; any other role's key on operations", () => {
    const attendant = { role: { key: "site-attendant" } }
    assert.equal(landingOf({ ...OFFICE, ...attendant }), "/check-in")
    assert.equal(landingOf({ ...DRIVER, ...attendant }), "/driver")
    assert.equal(landingOf({ ...PROVIDER, ...attendant }), "/service-provider-workspace")
    assert.equal(landingOf({ ...OFFICE, role: { key: "dispatcher" } }), "/operate")
    assert.equal(landingOf({ ...OFFICE, role: { key: null } }), "/operate")
    assert.equal(afterSignIn({ ...OFFICE, ...attendant }, null), "/check-in")
  })

  test("a provider's driver is a driver first: the phone is where the work is", () => {
    assert.equal(landingOf(PROVIDERS_DRIVER), "/driver")
  })

  test("an API from before Me.driver or Me.serviceProvider, which sends no such member at all, lands everyone on operations", () => {
    // The web can reach the Pilot before the API that answers `driver` is released.
    assert.equal(landingOf({} as typeof OFFICE), "/operate")
    assert.equal(landingOf({ driver: null } as typeof OFFICE), "/operate")
  })

  test("sign-in returns the person to where they were going, and lands them by /me when they were going nowhere of ours", () => {
    assert.equal(afterSignIn(OFFICE, "/routes?module=routes&record=r-1"), "/routes?module=routes&record=r-1")
    assert.equal(afterSignIn(DRIVER, "/operate"), "/operate", "a place asked for wins over the landing")
    assert.equal(afterSignIn(DRIVER, null), "/driver")
    assert.equal(afterSignIn(PROVIDER, null), "/service-provider-workspace")
    assert.equal(afterSignIn(PROVIDER, "/service-provider-workspace/routes"), "/service-provider-workspace/routes")
    assert.equal(afterSignIn(OFFICE, "https://elsewhere.example/operate"), "/operate")
  })
})

describe("returnPath", () => {
  test("is a path of this application, its query kept", () => {
    assert.equal(returnPath("/operate"), "/operate")
    assert.equal(returnPath("/customers?module=properties&record=p%201"), "/customers?module=properties&record=p%201")
  })

  test("is never another origin, however it is spelled", () => {
    for (const next of ["https://elsewhere.example/operate", "//elsewhere.example/operate", "/\\elsewhere.example", "\\\\elsewhere.example", "javascript:alert(1)", "operate"]) {
      assert.equal(returnPath(next), null, next)
    }
  })

  test("is never another origin once the parser has removed dot segments either", () => {
    // Each of these parses to the protocol-relative `//elsewhere.example/…`,
    // which a navigation would follow off-site.
    for (const next of ["/.//elsewhere.example/phish", "/..//elsewhere.example", "/%2e//elsewhere.example", "/%2E%2E//elsewhere.example", "/.\\/elsewhere.example", "/a/..//elsewhere.example"]) {
      assert.equal(returnPath(next), null, next)
      assert.equal(afterSignIn(OFFICE, next), "/operate", next)
    }
  })

  test("is never the sign-in page itself, nor the root, which is the landing already", () => {
    assert.equal(returnPath("/login"), null)
    assert.equal(returnPath("/login/"), null, "the trailing slash Next redirects away")
    assert.equal(returnPath("/login?next=%2Foperate"), null)
    assert.equal(returnPath("/"), null)
    assert.equal(returnPath(""), null)
    assert.equal(returnPath(null), null)
  })
})

describe("the sign-in gate", () => {
  const pilot = (state: Partial<GateState>): GateState => ({ configured: true, hydrated: true, signedIn: false, ...state })

  test("lets every page through when the adapter is off: fixture mode is as it was", () => {
    assert.equal(gateOf({ configured: false, hydrated: false, signedIn: false }, "/operate"), "show")
    assert.equal(gateOf({ configured: false, hydrated: true, signedIn: false }, "/operate"), "show")
  })

  test("on the Pilot, shows a page to a session, waits while the browser's session is unread, and sends an unsigned visitor to sign in", () => {
    assert.equal(gateOf(pilot({ signedIn: true }), "/operate"), "show")
    assert.equal(gateOf(pilot({ hydrated: false }), "/operate"), "wait")
    assert.equal(gateOf(pilot({}), "/operate"), "sign-in")
    assert.equal(gateOf(pilot({}), "/"), "sign-in")
  })

  test("never stands in front of a published project's public pages, which are anyone's (ADR-0010), and no page merely named like one", () => {
    assert.equal(gateOf(pilot({}), "/p/kystbyen/sorting"), "show")
    assert.equal(gateOf(pilot({ hydrated: false }), "/p/kystbyen/sorting"), "show")
    assert.equal(gateOf(pilot({}), "/portal"), "sign-in", "the citizen portal is a signed-in surface")
    assert.equal(gateOf(pilot({}), "/p"), "sign-in")
  })

  test("never stands in front of /login", () => {
    assert.equal(gateOf(pilot({}), "/login"), "show")
    assert.equal(gateOf(pilot({ hydrated: false }), "/login"), "show")
  })

  test("sends an unsigned visitor to /login carrying where they were going, and returns them there", () => {
    const target = signInTarget(null, "/operate?module=tickets")
    assert.equal(target, "/login?next=%2Foperate%3Fmodule%3Dtickets")
    const next = new URL(target, "https://waste.example").searchParams.get("next")
    assert.equal(afterSignIn(OFFICE, next), "/operate?module=tickets")
    assert.equal(signInTarget({ reason: "expired" }, "/fleet"), "/login?next=%2Ffleet", "a session nobody could refresh is a visitor who was on their way somewhere")
    assert.equal(signInTarget(null, "/"), "/login", "the root is the landing already")
  })

  test("after a sign-out or a refused account, sends to /login alone, so the next person lands by their own /me", () => {
    assert.equal(signInTarget({ reason: "signed-out" }, "/operate"), "/login")
    assert.equal(signInTarget({ reason: "refused", detail: "This account is deactivated", by: "auth" }, "/operate"), "/login")
  })

  test("only a visitor on the way somewhere carries next: /login drops the one in its address when a session ends there", () => {
    assert.equal(carriesNext(null), true)
    assert.equal(carriesNext({ reason: "expired" }), true)
    assert.equal(carriesNext({ reason: "signed-out" }), false)
    assert.equal(carriesNext({ reason: "refused", detail: "No active account in this company is bound to this login", by: "api" }), false)
  })
})
