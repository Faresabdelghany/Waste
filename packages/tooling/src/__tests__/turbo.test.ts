import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { describe, test } from "node:test"

import { turboTaskEnv } from "../turbo"

const turboJson = (tasks: object): URL => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "turbo-")), "turbo.json")
  writeFileSync(file, JSON.stringify({ tasks }))
  return pathToFileURL(file)
}

describe("turboTaskEnv", () => {
  test("reads a task's env list as turbo.json spells it", () => {
    assert.deepEqual(turboTaskEnv("@waste/api#dev", turboJson({ "@waste/api#dev": { env: ["PORT", "HOST"] } })), ["PORT", "HOST"])
  })

  test("refuses a task that is not there, or lists no env", () => {
    const file = turboJson({ dev: { cache: false } })
    assert.throws(() => turboTaskEnv("@waste/api#dev", file), /turbo\.json has no env list for @waste\/api#dev/)
    assert.throws(() => turboTaskEnv("dev", file), /no env list for dev/)
  })

  test("reads the repository's own file by default", () => {
    assert.ok(turboTaskEnv("@waste/web#build").includes("WASTE_API_ORIGIN"))
  })
})
