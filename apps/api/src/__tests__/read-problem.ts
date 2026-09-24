// Every error body of the API is a Problem Details document (problem.ts, and
// the shape in @waste/contracts/problem). This is how a test reads one: the
// media type must be the problem one, the body must parse with the contracts'
// schema, its status must repeat the response's, and its type is the generic
// one until a client needs to tell problems apart.
import assert from "node:assert/strict"

import { BLANK_PROBLEM_TYPE, Problem } from "@waste/contracts/problem"

export async function readProblem(response: Response): Promise<Problem> {
  assert.match(response.headers.get("content-type") ?? "", /^application\/problem\+json/)
  const body = Problem.parse(await response.json())
  assert.equal(body.status, response.status)
  assert.equal(body.type, BLANK_PROBLEM_TYPE)
  return body
}
