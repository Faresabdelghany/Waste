import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { BLANK_PROBLEM_TYPE, PROBLEM_MEDIA_TYPE, Problem, ProblemFieldError } from "../problem"

describe("Problem", () => {
  test("is a type, a title and the status, with an optional detail", () => {
    const body = { type: "about:blank", title: "Not Found", status: 404, detail: "No project 0192b3d4-5e6f-7a8b-9c0d-1e2f3a4b5c6d in this company" }
    assert.deepEqual(Problem.parse(body), body)
    assert.deepEqual(Problem.parse({ type: "about:blank", title: "Internal Server Error", status: 500 }), {
      type: "about:blank",
      title: "Internal Server Error",
      status: 500,
    })
  })

  test("carries the field errors of a 400, each a dotted path and a message", () => {
    const body = {
      type: "about:blank",
      title: "Bad Request",
      status: 400,
      detail: "The request body is invalid",
      errors: [
        { path: "name", message: "Too small: expected string to have >=1 characters" },
        { path: "projectIds.1", message: "Invalid UUID" },
        { path: "", message: "Invalid input: expected object, received string" },
      ],
    }
    assert.deepEqual(Problem.parse(body), body)
    assert.deepEqual(ProblemFieldError.parse({ path: "name", message: "Required" }), { path: "name", message: "Required" })
  })

  test("the generic type is about:blank and the media type is RFC 9457's", () => {
    assert.equal(BLANK_PROBLEM_TYPE, "about:blank")
    assert.equal(PROBLEM_MEDIA_TYPE, "application/problem+json")
  })

  test("refuses a status that is not an error, a missing member, an empty type or title, and a malformed error entry", () => {
    assert.equal(Problem.safeParse({ type: "about:blank", title: "OK", status: 200 }).success, false)
    assert.equal(Problem.safeParse({ type: "about:blank", title: "Bad Request", status: "400" }).success, false)
    assert.equal(Problem.safeParse({ type: "about:blank", title: "Bad Request" }).success, false)
    assert.equal(Problem.safeParse({ type: "", title: "Bad Request", status: 400 }).success, false)
    assert.equal(Problem.safeParse({ type: "about:blank", title: "", status: 400 }).success, false)
    assert.equal(Problem.safeParse({ type: "about:blank", title: "Bad Request", status: 400, errors: [{ path: "name" }] }).success, false)
    assert.equal(Problem.safeParse({ type: "about:blank", title: "Bad Request", status: 400, errors: [{ path: ["name"], message: "x" }] }).success, false)
  })

  test("drops a member it does not know, as every wire shape does", () => {
    assert.deepEqual(Problem.parse({ type: "about:blank", title: "Forbidden", status: 403, stack: "at ..." }), {
      type: "about:blank",
      title: "Forbidden",
      status: 403,
    })
  })
})
