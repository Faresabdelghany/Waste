// How a test that needs the database finds it: DATABASE_URL, the API's own
// role, exactly as server.ts reads it; nothing here needs the owner. Locally
// the test skips, visibly, when the variable is unset (the local stack is not
// running, or .env was not copied); in CI REQUIRE_DATABASE turns that skip
// into a failure, so CI can never pass by skipping. The database package asks
// a wider version of this question for its own suite (two roles, fresh
// databases, loopback only because its tests drop databases); the API's tests
// run `select 1` and nothing else, so this one is smaller and is not a copy.

const SKIP_REASON =
  "DATABASE_URL is not set: start the local stack with `pnpm db:start`, copy .env.example to .env, then `pnpm db:migrate` and `pnpm db:bootstrap`"

export type DatabaseUnderTest = {
  /** A string reason when the database tests must be skipped, false when they can run. */
  skip: string | false
  url: string
}

/** `REQUIRE_DATABASE` is on unless unset, empty, "0" or "false". */
const isRequired = (value: string | undefined): boolean =>
  value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false"

export function databaseUnderTest(env: Readonly<Record<string, string | undefined>> = process.env): DatabaseUnderTest {
  const url = env.DATABASE_URL ?? ""
  if (!url) {
    if (isRequired(env.REQUIRE_DATABASE)) {
      throw new Error("REQUIRE_DATABASE is set, but DATABASE_URL is not")
    }
    return { skip: SKIP_REASON, url }
  }
  return { skip: false, url }
}
