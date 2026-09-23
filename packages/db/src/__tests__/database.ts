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

import { createDb } from "../client"
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
 * Creates a database with a unique name, runs `fn` against its URL, and drops
 * it afterwards whatever happened; the admin pool closes whatever happened
 * too, so a failing drop cannot keep the test process alive.
 */
export async function withFreshDatabase<T>(
  adminUrl: string,
  prefix: string,
  fn: (freshUrl: string, name: string) => Promise<T>,
): Promise<T> {
  const name = `${prefix}_${randomUUID().replaceAll("-", "")}`
  const admin = createDb(adminUrl, { max: 1 })
  try {
    await admin.sql.unsafe(`create database "${name}"`)
    try {
      return await fn(withDatabaseName(adminUrl, name), name)
    } finally {
      await admin.sql.unsafe(`drop database if exists "${name}" with (force)`)
    }
  } finally {
    await admin.close()
  }
}
