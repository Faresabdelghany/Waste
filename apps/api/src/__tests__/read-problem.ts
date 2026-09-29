// Every error body of the API is a Problem Details document (problem.ts, and
// the shape in @waste/contracts/problem). This is how a test reads one: the
// media type must be the problem one, the body must parse with the contracts'
// schema, its status must repeat the response's, and its type is the generic
// one unless the test names the kind it expects — which only a test of the
// principal's two account refusals does (`NO_ACTIVE_ACCOUNT`, Issue #150), so
// every other refusal the suites read is held to `about:blank`.
import assert from "node:assert/strict"

import { BLANK_PROBLEM_TYPE, Problem, type ProblemKind } from "@waste/contracts/problem"

export async function readProblem(response: Response, kind?: ProblemKind): Promise<Problem> {
  assert.match(response.headers.get("content-type") ?? "", /^application\/problem\+json/)
  const body = Problem.parse(await response.json())
  assert.equal(body.status, response.status)
  assert.equal(body.type, kind?.type ?? BLANK_PROBLEM_TYPE)
  if (kind !== undefined) assert.equal(body.title, kind.title)
  return body
}
