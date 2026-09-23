// How a suite that needs a database finds it, and what it does when there is
// none. Locally the suite skips, visibly, with a hint that says how to start
// the local stack; in CI `REQUIRE_DATABASE` turns that skip into a failure, so
// CI can never pass by skipping. Each package names the variables it needs
// (the owner's URL, the API role's, or both) and adds its own checks after;
// what "required" means is spelled here once, so two suites cannot drift apart
// on the rule CI relies on.
//
// Not a database client: this module reads the environment and nothing else,
// and the packages that use it (`packages/db`, `apps/api`) have it as a
// devDependency like the purity gate.

/** The variable CI sets so that a database test may not skip. */
export const REQUIRE_DATABASE = "REQUIRE_DATABASE"

/** What to do when the local stack is not there; every skip reason ends with it. */
export const LOCAL_STACK_HINT =
  "start the local stack with `pnpm db:start`, copy .env.example to .env, then `pnpm db:migrate` and `pnpm db:bootstrap`"

export type DatabaseUnderTest<Name extends string> = {
  /** A string reason when the database tests must be skipped, false when they can run. */
  skip: string | false
  /** Each variable's value; an empty string where it is not set. */
  urls: Record<Name, string>
}

export type DatabaseUnderTestOptions = {
  /** How to get a database, appended to the skip reason. */
  hint: string
  env?: Readonly<Record<string, string | undefined>>
}

/** `REQUIRE_DATABASE` is on unless unset, empty, "0" or "false". */
export function isDatabaseRequired(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[REQUIRE_DATABASE]
  return value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false"
}

const spell = (names: readonly string[]) => `${names.join(" and ")} ${names.length === 1 ? "is" : "are"} not`

/**
 * Reads the named variables. All set: run. Some unset: skip with a reason
 * naming them and the hint, or throw naming them when the database is required.
 */
export function databaseUnderTest<Name extends string>(
  names: readonly Name[],
  { hint, env = process.env }: DatabaseUnderTestOptions,
): DatabaseUnderTest<Name> {
  const urls = Object.fromEntries(names.map((name) => [name, env[name] ?? ""])) as Record<Name, string>
  const missing = names.filter((name) => urls[name] === "")
  if (missing.length === 0) {
    return { skip: false, urls }
  }
  if (isDatabaseRequired(env)) {
    throw new Error(`${REQUIRE_DATABASE} is set, but ${spell(missing)}`)
  }
  return { skip: `${spell(missing)} set: ${hint}`, urls }
}
