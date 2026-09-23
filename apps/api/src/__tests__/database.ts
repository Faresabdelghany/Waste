// How a test that needs the database finds it: DATABASE_URL, the API's own
// role, exactly as server.ts reads it; nothing here needs the owner. Locally
// the test skips, visibly, when the variable is unset; in CI REQUIRE_DATABASE
// turns that skip into a failure, so CI can never pass by skipping. The rule
// is `@waste/tooling/database-under-test`, the same one `packages/db` applies
// to its two URLs; the API's tests run `select 1` and nothing else, so no
// loopback refusal here.
import { databaseUnderTest as variablesUnderTest, LOCAL_STACK_HINT } from "@waste/tooling/database-under-test"

export type DatabaseUnderTest = {
  /** A string reason when the database tests must be skipped, false when they can run. */
  skip: string | false
  url: string
}

export function databaseUnderTest(env: Readonly<Record<string, string | undefined>> = process.env): DatabaseUnderTest {
  const found = variablesUnderTest(["DATABASE_URL"], { hint: LOCAL_STACK_HINT, env })
  return { skip: found.skip, url: found.urls.DATABASE_URL }
}
