// How a test that needs the database finds it: DATABASE_URL, the API's own
// role, exactly as server.ts reads it. Locally the test skips, visibly, when
// the variable is unset; in CI REQUIRE_DATABASE turns that skip into a
// failure, so CI can never pass by skipping. The rule is
// `@waste/tooling/database-under-test`, the same one `packages/db` applies to
// its two URLs.
//
// One proof needs the owner (`ownerUnderTest`, DATABASE_ADMIN_URL): that the
// principal lookup binds the claim to the tenant by itself and not through the
// tenant fence, which only a role that bypasses RLS can show. It reads and
// nothing else, but the owner URL is the local stack's by rule (packages/db),
// so a hosted host is refused here too.
import { databaseUnderTest as variablesUnderTest, LOCAL_STACK_HINT } from "@waste/tooling/database-under-test"
import { isLocalHost } from "@waste/db/local-host"

export type DatabaseUnderTest = {
  /** A string reason when the database tests must be skipped, false when they can run. */
  skip: string | false
  url: string
}

export function databaseUnderTest(env: Readonly<Record<string, string | undefined>> = process.env): DatabaseUnderTest {
  const found = variablesUnderTest(["DATABASE_URL"], { hint: LOCAL_STACK_HINT, env })
  return { skip: found.skip, url: found.urls.DATABASE_URL }
}

export type OwnerUnderTest = {
  skip: string | false
  url: string
}

/** The owner's URL, for the one test that must see through the fence; same skip/fail rule, loopback only. */
export function ownerUnderTest(env: Readonly<Record<string, string | undefined>> = process.env): OwnerUnderTest {
  const found = variablesUnderTest(["DATABASE_ADMIN_URL"], { hint: LOCAL_STACK_HINT, env })
  const url = found.urls.DATABASE_ADMIN_URL
  if (!found.skip && !isLocalHost(url)) {
    throw new Error(`DATABASE_ADMIN_URL points at ${new URL(url).hostname}: the owner's URL is for the local stack only`)
  }
  return { skip: found.skip, url }
}
