// The web build identifier a `start-route` carries as `appVersion` (Issue
// #145), where the deployment exposes one: the commit Vercel builds from, its
// system variable made public at build time; none on a local build.
import assert from "node:assert/strict"
import { test } from "node:test"

import { appVersionOf } from "../app-version"

test("is the deployment's commit, and nothing where the build was given none", () => {
  assert.equal(appVersionOf({ NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA: " 4584152e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a " }), "4584152e0c1d2b3a4f5e6d7c8b9a0f1e2d3c4b5a")
  assert.equal(appVersionOf({ NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA: "" }), null)
  assert.equal(appVersionOf({}), null)
})
