// The role table (src/roles.ts) against the migrations that create the roles:
// every role a migration creates and none drops is one the fingerprint
// records, so a role given BYPASSRLS on the Pilot is a line that differs.
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, test } from "node:test"

import { FINGERPRINT_ROLES } from "../fingerprint"
import { MIGRATIONS_FOLDER } from "../migrate"

/** The roles the migration files leave behind, read in the order they apply. */
function rolesTheMigrationsCreate(): string[] {
  const roles = new Set<string>()
  for (const file of readdirSync(MIGRATIONS_FOLDER).filter((name) => name.endsWith(".sql")).sort()) {
    for (const [, verb, name] of readFileSync(path.join(MIGRATIONS_FOLDER, file), "utf8").matchAll(/\b(CREATE|DROP) ROLE\s+(?:IF EXISTS\s+)?([a-z_][a-z0-9_]*)/gi)) {
      if (verb.toUpperCase() === "CREATE") roles.add(name)
      else roles.delete(name)
    }
  }
  return [...roles].sort()
}

describe("the database roles", () => {
  test("the fingerprint records every role the migrations create and keep, the public door's among them", () => {
    assert.deepEqual(rolesTheMigrationsCreate(), ["wms_api", "wms_public", "wms_worker"])
    assert.deepEqual([...FINGERPRINT_ROLES].sort(), rolesTheMigrationsCreate())
  })
})
