import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { parseEnv } from "../env"

describe("parseEnv", () => {
  test("binds to localhost on 3001 when nothing is set", () => {
    assert.deepEqual(parseEnv({}), { HOST: "127.0.0.1", PORT: 3001 })
  })

  test("reads HOST and PORT from the process environment", () => {
    assert.deepEqual(parseEnv({ HOST: "0.0.0.0", PORT: "8080" }), { HOST: "0.0.0.0", PORT: 8080 })
  })

  test("treats an empty variable as not set", () => {
    assert.deepEqual(parseEnv({ HOST: "", PORT: "" }), { HOST: "127.0.0.1", PORT: 3001 })
  })

  test("carries nothing it does not know: the process environment is large", () => {
    assert.deepEqual(parseEnv({ PATH: "/usr/bin", HOME: "/home/api", PORT: "1" }), { HOST: "127.0.0.1", PORT: 1 })
  })

  test("refuses a port that is not a whole number in 1..65535 and names the variable", () => {
    for (const value of ["0", "65536", "abc", "80.5", " 80", "+80", "0x50"]) {
      assert.throws(() => parseEnv({ PORT: value }), (error: unknown) => error instanceof Error && /PORT/.test(error.message), value)
    }
  })
})
