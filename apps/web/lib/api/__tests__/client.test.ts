// The API client and the problem reader (Issue #81), against a scripted
// `fetch`: the token and the accept header on every request, a page walked
// to its end, a 201's `Location` handed back, a refusal thrown as the problem
// the API wrote, a network failure as a problem of status 0, and the sentence
// a person is shown.
import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { command, create, get, listAll, listPage, patch, PAGE_LIMIT_MAX, put, UNREACHABLE_STATUS, withQuery, type ApiClient } from "../client"
import { ApiProblem, genericProblem, isApiProblem, PROBLEM_MEDIA_TYPE, problemOf, problemSentence } from "../problem"

type Call = { url: string; init: RequestInit }

/** A `fetch` that answers from a script and records what it was asked. */
function scripted(answers: Array<(call: Call) => Response | Promise<Response>>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init }
    calls.push(call)
    const answer = answers.shift()
    if (!answer) throw new Error(`unexpected call to ${call.url}`)
    return answer(call)
  }) as typeof fetch
  return { fetch: fetchImpl, calls }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

const problem = (status: number, detail: string, errors?: { path: string; message: string }[]) =>
  new Response(JSON.stringify({ type: "about:blank", title: "Refused", status, detail, ...(errors ? { errors } : {}) }), {
    status,
    headers: { "content-type": PROBLEM_MEDIA_TYPE },
  })

const clientOver = (fetchImpl: typeof fetch): ApiClient => ({ baseUrl: "http://api.test", token: "t0k3n", fetch: fetchImpl })

describe("withQuery", () => {
  test("appends the given members and leaves the undefined ones out", () => {
    assert.equal(withQuery("/projects", { limit: 200, cursor: undefined }), "/projects?limit=200")
    assert.equal(withQuery("/projects"), "/projects")
    assert.equal(withQuery("/users", { projectId: "a b" }), "/users?projectId=a+b")
  })
})

describe("the client", () => {
  test("every request carries the bearer token and asks for JSON", async () => {
    const { fetch, calls } = scripted([() => json({ id: "x" })])
    await get(clientOver(fetch), "/company")
    assert.equal(calls[0].url, "http://api.test/company")
    assert.equal(calls[0].init.method, "GET")
    const headers = calls[0].init.headers as Record<string, string>
    assert.equal(headers.authorization, "Bearer t0k3n")
    assert.equal(headers.accept, "application/json")
    assert.equal(headers["content-type"], undefined)
  })

  test("listPage asks for the API's maximum page and hands the page back as it came", async () => {
    const { fetch, calls } = scripted([() => json({ items: [{ id: 1 }], nextCursor: "c1" })])
    const page = await listPage(clientOver(fetch), "/projects")
    assert.deepEqual(page, { items: [{ id: 1 }], nextCursor: "c1" })
    assert.equal(calls[0].url, `http://api.test/projects?limit=${PAGE_LIMIT_MAX}`)
  })

  test("listAll walks the cursor to the last page and keeps the other query members on every call", async () => {
    const { fetch, calls } = scripted([
      () => json({ items: [1, 2], nextCursor: "c1" }),
      () => json({ items: [3], nextCursor: "c2" }),
      () => json({ items: [], nextCursor: null }),
    ])
    const items = await listAll(clientOver(fetch), "/users", { projectId: "p" })
    assert.deepEqual(items, [1, 2, 3])
    assert.deepEqual(
      calls.map((call) => call.url),
      [`http://api.test/users?limit=${PAGE_LIMIT_MAX}&projectId=p`, `http://api.test/users?limit=${PAGE_LIMIT_MAX}&projectId=p&cursor=c1`, `http://api.test/users?limit=${PAGE_LIMIT_MAX}&projectId=p&cursor=c2`],
    )
  })

  test("create sends the body as JSON and answers the 201's body with its Location", async () => {
    const { fetch, calls } = scripted([() => json({ id: "p1", name: "Aarhus" }, 201, { location: "/projects/p1" })])
    const created = await create(clientOver(fetch), "/projects", { name: "Aarhus" })
    assert.deepEqual(created, { body: { id: "p1", name: "Aarhus" }, location: "/projects/p1" })
    assert.equal(calls[0].init.method, "POST")
    assert.equal((calls[0].init.headers as Record<string, string>)["content-type"], "application/json")
    assert.equal(calls[0].init.body, JSON.stringify({ name: "Aarhus" }))
  })

  test("create without a Location answers null for it", async () => {
    const { fetch } = scripted([() => json({ id: "p1" }, 201)])
    const created = await create(clientOver(fetch), "/projects", {})
    assert.equal(created.location, null)
  })

  test("patch, put and command use their methods and answer the body", async () => {
    const { fetch, calls } = scripted([() => json({ a: 1 }), () => json({ b: 2 }), () => json({ c: 3 })])
    const client = clientOver(fetch)
    assert.deepEqual(await patch(client, "/projects/p1", { name: "x" }), { a: 1 })
    assert.deepEqual(await put(client, "/roles/r1/grants", { grants: [] }), { b: 2 })
    assert.deepEqual(await command(client, "/users/u1/deactivate"), { c: 3 })
    assert.deepEqual(
      calls.map((call) => call.init.method),
      ["PATCH", "PUT", "POST"],
    )
    assert.equal(calls[2].init.body, undefined)
  })

  test("a refusal is thrown as the problem the API wrote, fields keyed by path", async () => {
    const { fetch } = scripted([() => problem(400, "The request body is invalid", [{ path: "name", message: "Give something other than whitespace" }])])
    await assert.rejects(
      () => create(clientOver(fetch), "/projects", { name: " " }),
      (error: unknown) => {
        if (!isApiProblem(error)) throw error
        assert.equal(error.status, 400)
        assert.equal(error.problem.detail, "The request body is invalid")
        assert.deepEqual(error.fields, { name: "Give something other than whitespace" })
        assert.equal(error.message, "The request body is invalid — name: Give something other than whitespace")
        return true
      },
    )
  })

  test("a refusal whose body is not a problem is the status alone", async () => {
    const { fetch } = scripted([() => new Response("gateway timeout", { status: 504 })])
    await assert.rejects(
      () => get(clientOver(fetch), "/company"),
      (error: unknown) => {
        if (!isApiProblem(error)) throw error
        assert.equal(error.status, 504)
        assert.equal(error.problem.title, "HTTP 504")
        assert.equal(error.problem.detail, "gateway timeout")
        return true
      },
    )
  })

  test("a fetch that never reaches the API is a problem of status 0, never an HTTP status", async () => {
    const failing = (async () => {
      throw new TypeError("Failed to fetch")
    }) as typeof fetch
    await assert.rejects(
      () => get(clientOver(failing), "/company"),
      (error: unknown) => {
        if (!isApiProblem(error)) throw error
        assert.equal(error.status, UNREACHABLE_STATUS)
        assert.match(error.problem.detail ?? "", /did not answer \(Failed to fetch\)/)
        return true
      },
    )
  })
})

describe("the problem reader", () => {
  test("reads a problem body and drops malformed field errors", () => {
    assert.deepEqual(problemOf({ type: "about:blank", title: "Conflict", status: 409, detail: "taken", errors: [{ path: "name", message: "m" }, { nope: true }] }), {
      type: "about:blank",
      title: "Conflict",
      status: 409,
      detail: "taken",
      errors: [{ path: "name", message: "m" }],
    })
  })

  test("refuses what is not a problem", () => {
    assert.equal(problemOf(null), null)
    assert.equal(problemOf({ title: "x" }), null)
    assert.equal(problemOf({ type: "about:blank", title: "OK", status: 200 }), null)
  })

  test("a generic problem carries the reason phrase and the sentence names the body's root as body", () => {
    assert.equal(genericProblem(403).title, "Forbidden")
    assert.equal(problemSentence({ type: "about:blank", title: "Bad Request", status: 400, errors: [{ path: "", message: "Give at least one field to change" }] }), "Bad Request — body: Give at least one field to change")
    assert.equal(new ApiProblem(genericProblem(404, "No project x")).message, "No project x")
  })
})
