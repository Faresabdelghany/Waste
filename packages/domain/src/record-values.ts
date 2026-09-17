// Reading the transitional BusinessRecord (prototype-record.ts): a display
// fact whose value is the em-dash placeholder is absent, a typed submitted
// value counts only when it is a non-blank string, and several records
// "agree" on a value only when every one of them carries the same one.
// These were private copies in a dozen modules before issue #58 hoisted them.

import type { SubmittedValue } from "./prototype-record"

/** The placeholder a fixture fact shows when it has nothing to say. */
export const EMPTY_FACT = "—"

/** A trimmed display fact, or undefined when blank, the placeholder, or not a string. */
export function cleanFact(value: string | boolean | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed && trimmed !== EMPTY_FACT ? trimmed : undefined
}

/** A trimmed typed value, or undefined when blank, missing, or not a string. */
export function typedString(values: Readonly<Record<string, SubmittedValue | undefined>> | undefined, key: string): string | undefined {
  const value = values?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * The one value every entry agrees on, or undefined when any entry is
 * missing, the entries disagree, or there are none. An empty string is a
 * value like any other — clean the entries first.
 */
export function uniform<T>(values: ReadonlyArray<T | undefined>): T | undefined {
  const first = values[0]
  if (first === undefined) return undefined
  return values.every((value) => value === first) ? first : undefined
}
