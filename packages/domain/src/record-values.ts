// Reading the transitional BusinessRecord (prototype-record.ts) with one
// rule: a value is absent when it is blank, not a string, or the em-dash
// placeholder a fixture shows for "nothing" — whether it is a display fact
// or a typed submitted value — and several records "agree" on a value only
// when every one of them carries the same one. Issue #58 hoisted these from
// the private copies the map-planning and route-scheme modules carried; the
// readers with a different contract stay where they are and say so
// (validation.ts's stringValue keeps whitespace, service-frequencies'
// stringValue reads a bare value, groups.ts's optionalString reads unknown).

import type { SubmittedValue } from "./prototype-record"

/** The placeholder a fixture fact shows when it has nothing to say. */
export const EMPTY_FACT = "—"

/** A trimmed display fact, or undefined when blank, the placeholder, or not a string. */
export function cleanFact(value: string | boolean | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed && trimmed !== EMPTY_FACT ? trimmed : undefined
}

/** A trimmed typed value, or undefined when blank, missing, the placeholder, or not a string. */
export function typedString(values: Readonly<Record<string, SubmittedValue | undefined>> | undefined, key: string): string | undefined {
  return cleanFact(values?.[key])
}

/**
 * The one value every entry agrees on, or undefined when any entry is
 * missing, the entries disagree, or there are none. An empty string is a
 * value like any other — clean the entries first.
 */
export function uniform<T>(values: ReadonlyArray<T | undefined>): T | undefined {
  const [first] = values
  return first !== undefined && values.every((value) => value === first) ? first : undefined
}

/**
 * A comma between two digit groups is a thousands separator, not a list
 * separator: "Igloo · 2,500 L" is one item and "Residual, Organic" is two.
 */
const LIST_SEPARATOR = /,(?!\d{3}(?!\d))/

/**
 * The items of a stored list — a multiselect's picks, a rule's fractions or
 * container types — stored as one comma-separated string. Every item is
 * trimmed and a blank one dropped; a comma inside a number stays (issue #43:
 * "Four-wheel bin · 1,100 L", "Igloo · 2,500 L", "Underground · 5,000 L" and
 * "Wastewater tank · 3,000 L" are container types and used to split in two).
 */
export function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(LIST_SEPARATOR)
    .map((item) => item.trim())
    .filter(Boolean)
}
