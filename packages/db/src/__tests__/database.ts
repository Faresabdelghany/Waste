// How a database test finds its database. Locally the test skips, visibly,
// when the local stack is not running; in CI `REQUIRE_DATABASE` turns that
// skip into a failure, so CI can never pass by skipping. Two roles, two URLs:
// the owner (`DATABASE_ADMIN_URL`, `postgres`) runs migrations and creates
// specimen tables; the API role (`DATABASE_URL`, `wms_api`) is what the
// application sees.
const SKIP_REASON =
  "DATABASE_ADMIN_URL is not set: start the local stack with `pnpm db:start` and copy .env.example to .env"

export type DatabaseUnderTest = {
  /** A string reason when the database tests must be skipped, false when they can run. */
  skip: string | false
  adminUrl: string
  appUrl: string
}

export function databaseUnderTest(env: Readonly<Record<string, string | undefined>> = process.env): DatabaseUnderTest {
  const adminUrl = env.DATABASE_ADMIN_URL ?? ""
  const appUrl = env.DATABASE_URL ?? ""
  if (!adminUrl || !appUrl) {
    if (env.REQUIRE_DATABASE) {
      throw new Error(`REQUIRE_DATABASE is set, but ${!adminUrl ? "DATABASE_ADMIN_URL" : "DATABASE_URL"} is not`)
    }
    return { skip: SKIP_REASON, adminUrl, appUrl }
  }
  return { skip: false, adminUrl, appUrl }
}

/** The same server and credentials, another database: for tests that want a fresh one. */
export function withDatabaseName(url: string, name: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}
