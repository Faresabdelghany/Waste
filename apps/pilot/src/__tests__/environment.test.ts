// The Pilot's environment, as README.md's step 3 lists it for the owner to set
// in Suga, names only variables some process declares: the supervisor's own,
// or a child's, which turbo.json's dev task lists exactly as the app's env.ts
// declares it (each app's env test holds that half).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { describe, test } from "node:test"

import { turboTaskEnv } from "@waste/tooling/turbo"

import { SUPERVISOR_VARIABLES } from "../config"

const README = readFileSync(new URL("../../README.md", import.meta.url), "utf8")

/** The first column of every table row that names a variable. */
const tabled = [...README.matchAll(/^\s*\| `([A-Z][A-Z0-9_]*)` \|/gm)].map(([, name]) => name)

describe("the Pilot's environment table", () => {
  test("lists variables, each once", () => {
    assert.ok(tabled.includes("DATABASE_URL") && tabled.includes("PILOT_MEMORY_LOG_SECONDS"), "the table is where the reader looks")
    assert.equal(new Set(tabled).size, tabled.length)
  })

  test("names only variables the supervisor, the API or the worker declares", () => {
    const declared = new Set<string>([...SUPERVISOR_VARIABLES, ...turboTaskEnv("@waste/api#dev"), ...turboTaskEnv("@waste/worker#dev")])
    assert.deepEqual(
      tabled.filter((name) => !declared.has(name)),
      [],
    )
  })
})
