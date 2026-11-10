// How a database test finds its database. Locally the test skips, visibly,
// when the local stack is not running; in CI `REQUIRE_DATABASE` turns that
// skip into a failure, so CI can never pass by skipping: that rule is
// `@waste/tooling/database-under-test`, spelled once for every package. Two
// roles, two URLs: the owner (`DATABASE_ADMIN_URL`, `postgres`) runs
// migrations and creates specimen tables; the API role (`DATABASE_URL`,
// `wms_api`) is what the application sees.
//
// The tests migrate, create and drop whole databases and reset the API role's
// password, so they refuse any host that is not the local stack: a `.env`
// pointed at the hosted project for a one-off `pnpm db:migrate` must not turn
// `pnpm test` into a hosted incident.
import { randomUUID } from "node:crypto"

import { databaseUnderTest as variablesUnderTest, LOCAL_STACK_HINT } from "@waste/tooling/database-under-test"

import { createDb, type Database } from "../client"
import { isLocalHost } from "../local-host"

export type DatabaseUnderTest = {
  /** A string reason when the database tests must be skipped, false when they can run. */
  skip: string | false
  adminUrl: string
  appUrl: string
}

export function databaseUnderTest(env: Readonly<Record<string, string | undefined>> = process.env): DatabaseUnderTest {
  const found = variablesUnderTest(["DATABASE_ADMIN_URL", "DATABASE_URL"], { hint: LOCAL_STACK_HINT, env })
  const { DATABASE_ADMIN_URL: adminUrl, DATABASE_URL: appUrl } = found.urls
  if (found.skip) {
    return { skip: found.skip, adminUrl, appUrl }
  }
  for (const [name, url] of [
    ["DATABASE_ADMIN_URL", adminUrl],
    ["DATABASE_URL", appUrl],
  ] as const) {
    if (!isLocalHost(url)) {
      throw new Error(
        `${name} points at ${new URL(url).hostname}: the database tests migrate, create and drop databases and reset the API role's password, so they run against the local stack only`,
      )
    }
  }
  return { skip: false, adminUrl, appUrl }
}

/** The same server and credentials, another database: for tests that want a fresh one. */
export function withDatabaseName(url: string, name: string): string {
  const parsed = new URL(url)
  parsed.pathname = `/${name}`
  return parsed.toString()
}

/**
 * The same server, database and password, another role. The Supabase CLI
 * gives every role of the local stack the one `[db] password`, so a test can
 * connect as the role a Supabase service uses (`supabase_auth_admin`, which
 * calls the access token hook) the way that service does, where the owner
 * cannot SET ROLE to it: its memberships are reserved to superusers.
 */
export function withUser(url: string, user: string): string {
  const parsed = new URL(url)
  parsed.username = user
  return parsed.toString()
}

/**
 * A test database's name: the file's prefix, the millisecond it was made
 * (`Date.now()` in base 36, eight characters until 2059) and six random hex
 * digits — the shape apps/worker's test databases take too, so either
 * package's sweep reads the other's stamp the same way — fitting Postgres's
 * 63 bytes beside any prefix of up to 47 and saying its own age.
 */
export function testDatabaseName(prefix: string, now: number = Date.now()): string {
  return `${prefix}_${now.toString(36)}_${randomUUID().replaceAll("-", "").slice(0, 6)}`
}

const TEST_DATABASE = /^waste_[a-z0-9_]*_([0-9a-z]{8})_[0-9a-f]{6}$/
/** How old a test database is before a later run may take it for abandoned: far past any file's budget. */
export const ABANDONED_AFTER_MS = 6 * 60 * 60 * 1000

/** This process's one sweep, which the first `freshDatabase` starts and every later one awaits. */
let swept: Promise<string[]> | undefined

/**
 * Drops the test databases a timed-out or killed run left on the stack: a name
 * `testDatabaseName` made, older than `ABANDONED_AFTER_MS`, with no session on
 * it. Safe beside concurrent runs: no run keeps a database that long, a
 * database with a session is left alone, and the drop is not forced, so one
 * that a session reaches in between is refused (55006) and left too. Names
 * of any other shape — the stack's own, an older run's — are never touched.
 * Answers the names it dropped.
 */
export async function sweepAbandonedDatabases(admin: Database, now: number = Date.now()): Promise<string[]> {
  const idle = await admin.sql<{ name: string }[]>`
    select d.datname as name from pg_database d
    where not d.datistemplate and not exists (select 1 from pg_stat_activity a where a.datname = d.datname)`
  const dropped: string[] = []
  for (const { name } of idle) {
    const stamp = TEST_DATABASE.exec(name)?.[1]
    if (stamp === undefined || now - Number.parseInt(stamp, 36) < ABANDONED_AFTER_MS) continue
    try {
      await admin.sql.unsafe(`drop database if exists "${name}"`)
      dropped.push(name)
    } catch {
      // Someone reached it in between: it is not abandoned after all.
    }
  }
  return dropped
}

export type FreshDatabase = {
  url: string
  name: string
  /** Drops the database, whatever is connected to it, and closes the pool that created it. */
  drop(): Promise<void>
}

/**
 * Creates a database with a unique name, for a test file that wants one of its
 * own: `drop` it in `after`. The admin pool closes with the drop whatever
 * happened, so a failing drop cannot keep the test process alive.
 *
 * `template` names a database to copy instead of an empty one: a file whose
 * tests each want a migrated (and seeded) database of their own migrates one
 * once and copies it per test, a file copy where a migration runs every file
 * again. Postgres refuses the copy while anyone is connected to the template
 * (55006), and a pool closed a moment ago can leave its backend behind it for
 * longer than Postgres's own five seconds' wait under load: so the copy waits
 * until the template has no session, and asks again, for `TEMPLATE_WAIT_MS`.
 *
 * The name carries when it was made (`testDatabaseName`). A failed hook or test
 * still reaches `drop`, but a file the runner times out, or a run killed
 * outright, never does: so the first database a process makes sweeps the
 * stack of the ones such runs left (`sweepAbandonedDatabases`).
 */
export async function freshDatabase(adminUrl: string, prefix: string, { template }: { template?: string } = {}): Promise<FreshDatabase> {
  const name = testDatabaseName(prefix)
  const admin = createDb(adminUrl, { max: 1 })
  try {
    swept ??= sweepAbandonedDatabases(admin).catch(() => [])
    await swept
    if (template === undefined) await admin.sql.unsafe(`create database "${name}"`)
    else await copyTemplate(admin, name, template)
  } catch (error) {
    await admin.close()
    throw error
  }
  return {
    url: withDatabaseName(adminUrl, name),
    name,
    drop: async () => {
      try {
        await admin.sql.unsafe(`drop database if exists "${name}" with (force)`)
      } finally {
        await admin.close()
      }
    },
  }
}

/** How long a template copy waits, in all, for the template's last session to go. */
const TEMPLATE_WAIT_MS = 30_000
const OBJECT_IN_USE = "55006"

async function copyTemplate(admin: Database, name: string, template: string): Promise<void> {
  const deadline = Date.now() + TEMPLATE_WAIT_MS
  for (;;) {
    try {
      await admin.sql.unsafe(`create database "${name}" template "${template}"`)
      return
    } catch (error) {
      if ((error as { code?: unknown }).code !== OBJECT_IN_USE || Date.now() > deadline) throw error
    }
    // The condition the copy needs: no session on the template, as Postgres counts them.
    while (Date.now() <= deadline) {
      const [{ sessions }] = await admin.sql<{ sessions: number }[]>`select count(*)::int as sessions from pg_stat_activity where datname = ${template}`
      if (sessions === 0) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
}

/**
 * A database a file or a suite makes once — fresh, then `prepare`d (migrated,
 * seeded) — for its tests to read or to copy. `ready` is awaited by every test
 * that uses it, so where making it failed each test fails with that cause,
 * never on an undefined; a database that failed half-way is dropped at once.
 */
export function sharedDatabase(adminUrl: string, prefix: string, prepare: (url: string) => Promise<unknown>): { ready: () => Promise<FreshDatabase>; drop: () => Promise<void> } {
  let made: Promise<FreshDatabase> | undefined
  const ready = (): Promise<FreshDatabase> =>
    (made ??= (async () => {
      const fresh = await freshDatabase(adminUrl, prefix)
      try {
        await prepare(fresh.url)
      } catch (error) {
        await fresh.drop()
        throw error
      }
      return fresh
    })())
  return {
    ready,
    drop: async () => {
      await made?.then(
        (fresh) => fresh.drop(),
        () => undefined,
      )
    },
  }
}

export async function withFreshDatabase<T>(
  adminUrl: string,
  prefix: string,
  fn: (freshUrl: string, name: string) => Promise<T>,
  options: { template?: string } = {},
): Promise<T> {
  const fresh = await freshDatabase(adminUrl, prefix, options)
  try {
    return await fn(fresh.url, fresh.name)
  } finally {
    await fresh.drop()
  }
}
