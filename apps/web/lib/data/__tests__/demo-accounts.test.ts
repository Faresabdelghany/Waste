// The demo accounts of fixture mode's sign-in land where the Pilot lands the
// same kind of account (lib/api/landing.ts), so a sign-in without the API
// never opens on a page that only the API can fill.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { landingOf } from "../../api/landing"
import { DEMO_ACCOUNTS } from "../demo-accounts"

const homeOf = (id: string) => DEMO_ACCOUNTS.find((account) => account.id === id)?.homePath

describe("the demo accounts' homes", () => {
  test("the operator lands on operations and the provider's manager on its workspace, as on the Pilot", () => {
    assert.equal(homeOf("olivia-larsen"), landingOf({ driver: null, serviceProvider: null }))
    assert.equal(homeOf("lars-mikkelsen"), landingOf({ driver: null, serviceProvider: { id: "01a0d2a4-a280-7003-8000-000000000001", legalName: "NordRen ApS" } }))
  })
})
