import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { after, describe, test } from "node:test"

import { readBuildInfo } from "../build-info"

const dir = mkdtempSync(path.join(tmpdir(), "waste-build-info-"))
after(() => rmSync(dir, { recursive: true, force: true }))
const COMMIT = "21e7e2c0c8f1b4d9a3e5f6a7b8c9d0e1f2a3b4c5"

describe("readBuildInfo (Issue #152)", () => {
  test("is null where the image wrote no build file: a checkout, or an image built without its commit", () => {
    assert.equal(readBuildInfo(path.join(dir, "absent.json")), null)
  })

  test("reads the commit the image's build wrote", () => {
    const file = path.join(dir, "build.json")
    writeFileSync(file, `${JSON.stringify({ commit: COMMIT })}\n`)
    assert.deepEqual(readBuildInfo(file), { commit: COMMIT })
  })

  test("refuses a build file that does not say one full commit, naming the file, so a broken image does not start", () => {
    for (const [name, text] of [
      ["short.json", JSON.stringify({ commit: COMMIT.slice(0, 7) })],
      ["empty.json", ""],
      ["other.json", JSON.stringify({ revision: COMMIT })],
    ] as const) {
      const file = path.join(dir, name)
      writeFileSync(file, text)
      assert.throws(() => readBuildInfo(file), new RegExp(`${name.replace(".", "\\.")} does not say which commit this image was built from`))
    }
  })
})
