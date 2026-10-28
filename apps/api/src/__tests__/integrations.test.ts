// The deployment's connections (#487): `GET /integrations` names the routing
// provider, the address register or none, and whether Storage is set up, as
// the composition root injected them, under `view` on
// `configure.integrations`; it calls none of them and names no key.
import assert from "node:assert/strict"
import { after, before, describe, test } from "node:test"

import { Integrations } from "@waste/contracts/integrations"
import { createDb, type Database } from "@waste/db/client"
import type { ProofStorage } from "@waste/db/storage"

import { FakeAddressRegister } from "../address-register/fake"
import { createApp } from "../app"
import { callingAs } from "./calls"
import { databaseUnderTest } from "./database"
import { dropTenant, grantRole, seedTenant, type Tenant } from "./tenant"
import { signingKeys, type SigningKeys } from "./tokens"

const database = databaseUnderTest()

/** A Storage the route must never call: it only says whether one is set up. */
const silentStorage: ProofStorage = {
  signUpload: () => Promise.reject(new Error("not the route's")),
  signReads: () => Promise.reject(new Error("not the route's")),
  remove: () => Promise.reject(new Error("not the route's")),
}

describe("GET /integrations", { skip: database.skip }, () => {
  let pool: Database
  let keys: SigningKeys
  let a: Tenant

  before(async () => {
    pool = createDb(database.url, { max: 4 })
    keys = await signingKeys()
    a = await seedTenant(pool)
    await grantRole(pool, a.companyId, a.roles.viewer.id, [{ moduleKey: "configure.integrations", actions: ["view"] }])
  })
  after(async () => {
    if (a) await dropTenant(pool, a.companyId)
    await pool?.close()
  })

  test("names the routing provider, the address register and Storage as the deployment was set up", async () => {
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, routing: { name: "openrouteservice" }, addressRegister: new FakeAddressRegister(), storage: silentStorage, log: () => {} })
    const response = await callingAs(app, keys, a.users.viewer, a.companyId)("/integrations")
    assert.equal(response.status, 200)
    assert.deepEqual(Integrations.parse(await response.json()), {
      routing: { provider: "openrouteservice" },
      addressRegister: { provider: "fake" },
      proofStorage: { configured: true },
    })
  })

  test("says so where the deployment names no register and holds no Storage key", async () => {
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, routing: { name: "fake" }, log: () => {} })
    const response = await callingAs(app, keys, a.users.olivia, a.companyId)("/integrations")
    assert.equal(response.status, 200)
    assert.deepEqual(Integrations.parse(await response.json()), { routing: { provider: "fake" }, addressRegister: null, proofStorage: { configured: false } })
  })

  test("is refused to a role that does not view the integrations", async () => {
    const app = createApp({ probe: pool, pool, verifier: keys.verifier, log: () => {} })
    assert.equal((await callingAs(app, keys, a.users.lars, a.companyId)("/integrations")).status, 403)
  })
})
