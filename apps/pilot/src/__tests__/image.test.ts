// The Node major and the processes' ports, against what the rest of the
// repository says they are. The image's Node is the major `.nvmrc` names,
// which CI installs (.github/actions/setup-workspace); it is also the major
// the bundles target, the floor of the root manifest's engines, and the major
// of every workspace's Node types. The image listens where the supervisor's
// defaults say (@waste/process/ports), and CI knocks on those ports. A
// Dockerfile, a workflow and a manifest cannot read the source, so this test
// holds them to it.
import assert from "node:assert/strict"
import { readdirSync, readFileSync } from "node:fs"
import { describe, test } from "node:test"

import { API_PORT, WORKER_PORT } from "@waste/process/ports"

import { BUNDLE_TARGET } from "../bundle"

/** A file of the repository: this one is apps/pilot/src/__tests__/image.test.ts. */
const read = (file: string): string => readFileSync(new URL(`../../../../${file}`, import.meta.url), "utf8")

const MAJOR = read(".nvmrc").trim()
const DOCKERFILE = read("apps/pilot/Dockerfile")

type Manifest = { name: string; engines?: { node?: string }; devDependencies?: Record<string, string> }
/** Every workspace's manifest, as pnpm-workspace.yaml's two globs find them. */
const WORKSPACES: Manifest[] = ["apps", "packages"].flatMap((folder) =>
  readdirSync(new URL(`../../../../${folder}`, import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      try {
        return [JSON.parse(read(`${folder}/${entry.name}/package.json`)) as Manifest]
      } catch {
        return []
      }
    }),
)

describe("the Node major", () => {
  test("is the image's, the bundles' target, the engines floor and every workspace's Node types: the one .nvmrc names", () => {
    assert.match(MAJOR, /^\d+$/, ".nvmrc names a major")
    assert.equal(/^ARG NODE_IMAGE=node:(\d+)-alpine$/m.exec(DOCKERFILE)?.[1], MAJOR, "the Dockerfile's image")
    assert.equal(BUNDLE_TARGET, `node${MAJOR}`)
    const root = JSON.parse(read("package.json")) as Manifest
    assert.equal(/^>=(\d+)\./.exec(root.engines?.node ?? "")?.[1], MAJOR, "the root manifest's engines")
    assert.ok(WORKSPACES.length >= 10, "the workspaces are found")
    assert.deepEqual(
      WORKSPACES.filter((manifest) => manifest.devDependencies?.["@types/node"] !== `^${MAJOR}`).map((manifest) => manifest.name),
      [],
      "a workspace on other Node types",
    )
  })
})

describe("the processes' ports", () => {
  test("are where the image listens, the API's the one it exposes", () => {
    assert.equal(/^\s+PORT=(\d+) \\$/m.exec(DOCKERFILE)?.[1], String(API_PORT))
    assert.equal(/^\s+WORKER_PORT=(\d+) \\$/m.exec(DOCKERFILE)?.[1], String(WORKER_PORT))
    assert.deepEqual(
      [...DOCKERFILE.matchAll(/^EXPOSE (\d+)$/gm)].map(([, port]) => Number(port)),
      [API_PORT],
    )
  })

  test("are the ones CI publishes and probes, and it knocks on no other", () => {
    const ci = read(".github/workflows/ci.yml")
    assert.match(ci, new RegExp(`--publish ${API_PORT}:${API_PORT} `), "the image's smoke test publishes the API's port")
    assert.match(ci, new RegExp(`http://127\\.0\\.0\\.1:${API_PORT}\\n\\s+http://127\\.0\\.0\\.1:${WORKER_PORT}\\n`), "the e2e lane waits on both processes")
    // Besides the two: the served web build (Next's 3000), the local stack's API and database, and the database nobody answers on.
    const known = new Set([API_PORT, WORKER_PORT, 3000, 54321, 54322, 1])
    assert.deepEqual(
      [...ci.matchAll(/127\.0\.0\.1:(\d+)/g)].map(([, port]) => Number(port)).filter((port) => !known.has(port)),
      [],
    )
  })
})
