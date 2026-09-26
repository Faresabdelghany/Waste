// How a test that needs the database finds it. Two URLs and two rules, both
// spelled by `@waste/tooling/database-under-test`: locally the test skips,
// visibly, when a variable is unset; in CI REQUIRE_DATABASE turns that skip
// into a failure, so CI can never pass by skipping.
//
// The boot test needs the owner (`DATABASE_ADMIN_URL`): it creates a database
// of its own, migrates it (so pg-boss's schema is there at the pinned
// version, as 0011 installs it) and drops it after, and runs pg-boss on that
// database as the owner — a login the worker role does not have on a fresh
// database until bootstrap gives it one, and giving it one there would reset
// a cluster-wide password under every other suite. What the worker role may
// and may not do is `packages/db`'s worker.test.ts's to prove; here the
// question is whether this process's wiring boots, schedules and runs. The
// owner URL is the local stack's by rule, so a hosted host is refused.
//
// The relay test (relay-outbox.test.ts) needs all three logins: the owner to
// create and migrate a database of its own, and the two application roles
// as the process runs them — the sweep as `wms_worker` on `WORKER_DATABASE_URL`,
// the stamp as `wms_api` on `DATABASE_URL` — since what it proves is that
// division of labour. A login is cluster-wide, so the two roles reach the
// fresh database with the passwords bootstrap gave them on the shared stack
// (the URLs' database name is swapped, `withDatabaseName`); the sweep is a
// cross-tenant read, and a relay on the shared database would stamp every
// other suite's events under it, which is why the relay never runs there.
//
// The probe tests need the API role (`DATABASE_URL`), as the process reads
// it, for the one check that asks the API role's pool to answer.
//
// The generation test needs all three: the owner to make and seed its
// database, the API role for the writes as the job makes them (fenced, under
// `withCompany`) and the worker role for the sweep as the cron makes it
// (across companies, writing nothing) — `WORKER_DATABASE_URL`, the process's
// own variable, loopback only like the owner's, since the test points both
// logins at a database of its own by name.
import { databaseUnderTest as variablesUnderTest, LOCAL_STACK_HINT } from "@waste/tooling/database-under-test"
import { isLocalHost } from "@waste/db/local-host"

export type DatabaseUnderTest = {
  /** A string reason when the database tests must be skipped, false when they can run. */
  skip: string | false
  url: string
}

/** The API role's URL, for a probe that asks its pool to answer, and for the job's fenced writes. */
export function databaseUnderTest(env: Readonly<Record<string, string | undefined>> = process.env): DatabaseUnderTest {
  const found = variablesUnderTest(["DATABASE_URL"], { hint: LOCAL_STACK_HINT, env })
  return { skip: found.skip, url: found.urls.DATABASE_URL }
}

/** The worker role's URL, for the sweep that reads across companies; same skip/fail rule, loopback only. */
export function workerUnderTest(env: Readonly<Record<string, string | undefined>> = process.env): DatabaseUnderTest {
  const found = variablesUnderTest(["WORKER_DATABASE_URL"], { hint: LOCAL_STACK_HINT, env })
  const url = found.urls.WORKER_DATABASE_URL
  if (!found.skip && !isLocalHost(url)) {
    throw new Error(`WORKER_DATABASE_URL points at ${new URL(url).hostname}: the worker role's URL is for the local stack only in a test`)
  }
  return { skip: found.skip, url }
}

/** The owner's URL, for the boot test that migrates a database of its own; same skip/fail rule, loopback only. */
export function ownerUnderTest(env: Readonly<Record<string, string | undefined>> = process.env): DatabaseUnderTest {
  const found = variablesUnderTest(["DATABASE_ADMIN_URL"], { hint: LOCAL_STACK_HINT, env })
  const url = found.urls.DATABASE_ADMIN_URL
  if (!found.skip && !isLocalHost(url)) {
    throw new Error(`DATABASE_ADMIN_URL points at ${new URL(url).hostname}: the owner's URL is for the local stack only`)
  }
  return { skip: found.skip, url }
}

export type RolesUnderTest = {
  skip: string | false
  /** The owner's, to create, migrate and drop the test's database. */
  adminUrl: string
  /** `wms_api`'s, the pool every write runs fenced on. */
  apiUrl: string
  /** `wms_worker`'s, the pool the sweep reads across tenants on and pg-boss runs on. */
  workerUrl: string
}

/** All three logins, for the relay test; same skip/fail rule, every one loopback only, since the test creates and drops a database beside them. */
export function rolesUnderTest(env: Readonly<Record<string, string | undefined>> = process.env): RolesUnderTest {
  const found = variablesUnderTest(["DATABASE_ADMIN_URL", "DATABASE_URL", "WORKER_DATABASE_URL"], { hint: LOCAL_STACK_HINT, env })
  const { DATABASE_ADMIN_URL: adminUrl, DATABASE_URL: apiUrl, WORKER_DATABASE_URL: workerUrl } = found.urls
  if (!found.skip) {
    for (const [name, url] of [
      ["DATABASE_ADMIN_URL", adminUrl],
      ["DATABASE_URL", apiUrl],
      ["WORKER_DATABASE_URL", workerUrl],
    ] as const) {
      if (!isLocalHost(url)) {
        throw new Error(`${name} points at ${new URL(url).hostname}: the relay test creates and drops a database, so it runs against the local stack only`)
      }
    }
  }
  return { skip: found.skip, adminUrl, apiUrl, workerUrl }
}

/** The same server and credentials, another database. */
export function withDatabaseName(url: string, name: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}
