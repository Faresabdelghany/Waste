// How a database test finds its database. Locally the test skips, visibly,
// when the local stack is not running; in CI `REQUIRE_DATABASE` turns that
// skip into a failure, so CI can never pass by skipping. Two roles, two URLs:
// the owner (`DATABASE_ADMIN_URL`, `postgres`) runs migrations and creates
// specimen tables; the API role (`DATABASE_URL`, `wms_api`) is what the
// application sees.
//
// The tests migrate, create and drop whole databases and reset the API role's
// password, so they refuse any host that is not the local stack: a `.env`
// pointed at the hosted project for a one-off `pnpm db:migrate` must not turn
// `pnpm test` into a hosted incident.
import { randomUUID } from "node:crypto"

import { createDb } from "../client"
import { isLocalHost } from "../local-host"

const SKIP_REASON =
  "DATABASE_ADMIN_URL or DATABASE_URL is not set: start the local stack with `pnpm db:start`, copy .env.example to .env, then `pnpm db:migrate` and `pnpm db:bootstrap`"

export type DatabaseUnderTest = {
  /** A string reason when the database tests must be skipped, false when they can run. */
  skip: string | false
  adminUrl: string
  appUrl: string
}

/** `REQUIRE_DATABASE` is on unless unset, empty, "0" or "false". */
const isRequired = (value: string | undefined): boolean =>
  value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false"

export function databaseUnderTest(env: Readonly<Record<string, string | undefined>> = process.env): DatabaseUnderTest {
  const adminUrl = env.DATABASE_ADMIN_URL ?? ""
  const appUrl = env.DATABASE_URL ?? ""
  if (!adminUrl || !appUrl) {
    if (isRequired(env.REQUIRE_DATABASE)) {
      throw new Error(`REQUIRE_DATABASE is set, but ${!adminUrl ? "DATABASE_ADMIN_URL" : "DATABASE_URL"} is not`)
    }
    return { skip: SKIP_REASON, adminUrl, appUrl }
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
