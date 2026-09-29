// What main.ts composes from the environment: the two children as their own
// images run them, the bundle where the image built one and the TypeScript
// source through tsx where it did not (a workstation), and the memory line's
// period.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { childSpecs, MAX_TIMER_SECONDS, memoryLogSeconds } from "../config"

const bundled = (path: string) => path.endsWith(".mjs")
const nothing = () => false

describe("childSpecs", () => {
  test("runs each app's bundle with plain node in its deploy directory: the host's PORT and HOST to the API, loopback 3002 to the worker", () => {
    const specs = childSpecs({ PORT: "8080" }, { exists: bundled, execPath: "/usr/bin/node" })
    assert.deepEqual(specs.api, {
      name: "api",
      command: "/usr/bin/node",
      args: ["src/server.mjs"],
      cwd: "/app/apps/api",
      env: { HOST: "0.0.0.0", PORT: "8080" },
    })
    assert.deepEqual(specs.worker, {
      name: "worker",
      command: "/usr/bin/node",
      args: ["src/main.mjs"],
      cwd: "/app/apps/worker",
      env: { HOST: "127.0.0.1", PORT: "3002" },
    })
  })

  test("takes the directories, the API's host and the worker's address from the environment where set", () => {
    const specs = childSpecs(
      { HOST: "::", PORT: "3001", WORKER_HOST: "0.0.0.0", WORKER_PORT: "3102", PILOT_API_DIR: "/repo/apps/api", PILOT_WORKER_DIR: "/repo/apps/worker" },
      { exists: bundled, execPath: "/usr/bin/node" },
    )
    assert.equal(specs.api.cwd, "/repo/apps/api")
    assert.deepEqual(specs.api.env, { HOST: "::", PORT: "3001" })
    assert.equal(specs.worker.cwd, "/repo/apps/worker")
    assert.deepEqual(specs.worker.env, { HOST: "0.0.0.0", PORT: "3102" })
  })

  test("without a bundle, runs the TypeScript source through tsx with the app's own tsconfig: a workstation", () => {
    const specs = childSpecs({ PILOT_API_DIR: "/repo/apps/api", PILOT_WORKER_DIR: "/repo/apps/worker" }, { exists: nothing, execPath: "/usr/bin/node" })
    assert.deepEqual(specs.api.args, ["--import", "tsx", "src/server.ts"])
    assert.deepEqual(specs.api.env, { HOST: "0.0.0.0", PORT: "3001", TSX_TSCONFIG_PATH: "/repo/apps/api/tsconfig.json" })
    assert.deepEqual(specs.worker.args, ["--import", "tsx", "src/main.ts"])
    assert.deepEqual(specs.worker.env, { HOST: "127.0.0.1", PORT: "3002", TSX_TSCONFIG_PATH: "/repo/apps/worker/tsconfig.json" })
  })

  test("asks whether the bundle exists by its full path", () => {
    const asked: string[] = []
    childSpecs({}, { exists: (path) => (asked.push(path), true), execPath: "/usr/bin/node" })
    assert.deepEqual(asked, ["/app/apps/api/src/server.mjs", "/app/apps/worker/src/main.mjs"])
  })
})

describe("memoryLogSeconds", () => {
  test("is the period in seconds where PILOT_MEMORY_LOG_SECONDS is a positive number Node's timers can take, and undefined — off — otherwise", () => {
    assert.equal(memoryLogSeconds({ PILOT_MEMORY_LOG_SECONDS: "60" }), 60)
    assert.equal(memoryLogSeconds({ PILOT_MEMORY_LOG_SECONDS: "0.5" }), 0.5)
    assert.equal(MAX_TIMER_SECONDS, 2_147_483)
    assert.equal(memoryLogSeconds({ PILOT_MEMORY_LOG_SECONDS: String(MAX_TIMER_SECONDS) }), MAX_TIMER_SECONDS)
    // Past the cap a setInterval would overflow to firing every millisecond: off instead.
    for (const value of [undefined, "", "0", "-5", "abc", "Infinity", "2147484", "9999999"]) {
      assert.equal(memoryLogSeconds({ PILOT_MEMORY_LOG_SECONDS: value }), undefined, String(value))
    }
  })
})
