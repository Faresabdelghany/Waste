// What the Registry's suites assert over and over, spelled once (Issue #78):
// the issues a refusal produced, and the two rules resource.ts gives every
// write body — a create body refuses what the server owns, a patch refuses
// having nothing to change. Four suites had a copy each, and a copied
// assertion is a copy that can quietly stop asserting.
//
// Not a suite of its own: the runner takes `src/**/*.test.ts`, so this file is
// only ever imported. organisation.test.ts and access.test.ts keep their own
// `refusal` from Issue #70; they are not this context's and nothing here
// changes what they prove.
import assert from "node:assert/strict"

type Refused = { success: boolean; error?: { issues: readonly { path: readonly PropertyKey[]; message: string }[] } }

/** Anything with zod's `safeParse`, so a helper takes a resource, a write body or a list query without naming its type. */
export type Parseable = { safeParse: (value: unknown) => Refused }

/** Each issue a failed parse produced, as the API's 400 would spell it. */
export const refusal = (result: Refused) => {
  assert.equal(result.success, false)
  return (result.error?.issues ?? []).map((issue) => ({ path: issue.path.join("."), message: issue.message }))
}

/** A valid id and instant, so what the body is refused for is the member's name and never its value. */
const ID = "01a0d3a5-e5e0-7000-8000-000000000001"
const STAMP = "2026-09-24T13:41:00.000Z"

/** A create body says nothing the server owns; the strict object refuses each one by name. */
export const refusesWhatTheServerOwns = (schema: Parseable, body: object) => {
  for (const [key, value] of [
    ["id", ID],
    ["createdAt", STAMP],
    ["updatedAt", STAMP],
  ] as const) {
    const issues = refusal(schema.safeParse({ ...body, [key]: value }))
    assert.deepEqual(
      issues.map((issue) => issue.path),
      [""],
      key,
    )
    assert.match(issues[0].message, new RegExp(key))
  }
}

/** A patch with nothing in it is a client bug, not a no-op. */
export const refusesAnEmptyPatch = (schema: Parseable) => {
  assert.deepEqual(refusal(schema.safeParse({})), [{ path: "", message: "Give at least one field to change" }])
}
