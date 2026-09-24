import assert from "node:assert/strict"
import { describe, test } from "node:test"

import { CASING } from "@waste/db/casing"
import { product } from "@waste/db/schema/catalogue"
import { QueryBuilder } from "drizzle-orm/pg-core"

import type { Principal } from "../auth/principal"
import { inProjects, projectIdsOf, requireProject } from "../auth/projects"
import { ProblemError } from "../problem"
import { testId } from "./tenant"

const copenhagen = testId()
const harbor = testId()

/** A principal is a big record and these three functions read one field of it, so a test builds only what they read. */
const principalWith = (projects: { id: string; name: string }[]): Principal =>
  ({ companyId: testId(), projects }) as Principal

const withProjects = principalWith([
  { id: copenhagen, name: "Copenhagen Central" },
  { id: harbor, name: "Harbor Commercial" },
])
const withNone = principalWith([])

/** What the fragment becomes in a statement, so a test reads the SQL and not the builder's internals. */
const rendered = (fragment: ReturnType<typeof inProjects>) =>
  new QueryBuilder({ casing: CASING }).select({ id: product.id }).from(product).where(fragment).toSQL()

/** The problem a call raised, since assert.throws does not hand it back. */
function refusal(call: () => void): ProblemError {
  try {
    call()
  } catch (error) {
    assert.ok(error instanceof ProblemError, `expected a problem, not ${String(error)}`)
    return error
  }
  return assert.fail("the call was expected to refuse")
}

describe("projectIdsOf", () => {
  test("is the ids of the projects the account works in, in the order the principal holds them", () => {
    assert.deepEqual(projectIdsOf(withProjects), [copenhagen, harbor])
  })

  test("is empty for an account that works in no project, such as a service provider's", () => {
    assert.deepEqual(projectIdsOf(withNone), [])
  })
})

describe("inProjects", () => {
  test("keeps a statement to the projects the account works in", () => {
    const { sql, params } = rendered(inProjects(product.projectId, withProjects))
    assert.match(sql, /"project_id" in \(\$1, \$2\)/)
    assert.deepEqual(params, [copenhagen, harbor])
  })

  test("keeps a statement to nothing at all when the account works in no project", () => {
    const { sql, params } = rendered(inProjects(product.projectId, withNone))
    assert.match(sql, /where false/)
    assert.deepEqual(params, [])
  })
})

describe("requireProject", () => {
  test("lets a project the account works in through", () => {
    assert.equal(requireProject(withProjects, harbor), undefined)
  })

  test("refuses a project the account does not work in with a 400 naming the field", () => {
    const raised = refusal(() => requireProject(withProjects, testId()))
    assert.equal(raised.status, 400)
    assert.equal(raised.body.detail, "The request body is invalid")
    assert.deepEqual(raised.body.errors, [{ path: "projectId", message: "Not a project this account works in" }])
  })

  test("refuses every project for an account that works in none: a service provider reaches nothing project-scoped", () => {
    assert.equal(refusal(() => requireProject(withNone, copenhagen)).status, 400)
  })

  test("names the field the caller gives it, and the query when that is where the id came from", () => {
    const nested = refusal(() => requireProject(withNone, copenhagen, "subscriptions.0.projectId"))
    assert.deepEqual(nested.body.errors?.map((error) => error.path), ["subscriptions.0.projectId"])
    const filtered = refusal(() => requireProject(withNone, copenhagen, "projectId", "query"))
    assert.equal(filtered.body.detail, "The request query is invalid")
  })
})
