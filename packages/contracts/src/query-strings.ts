// What a query string spells: a number in decimal digits, read plainly, and a
// flag spelled `true` or `false`. A query string is text, and JavaScript's
// `Number` reads more than a person types — `0x10` as 16, `1e3` as 1000,
// ` 2 ` as 2, `true` as 1 — so nothing is coerced: a value of another
// spelling is refused rather than read as a value nobody asked for.
import { DECIMAL_PATTERN, DECIMAL_SHAPE, WHOLE_NUMBER_PATTERN } from "@waste/domain/requests"
import * as z from "zod"

/**
 * A whole number from a query string or a JSON body: a whole number, or a
 * string of decimal digits. `true`, `["25"]`, `"0x19"` and `"1e1"` are
 * refused rather than read as 1, 25, 25 and 10.
 */
export const QueryWhole = z.union([z.int(), z.string().regex(new RegExp(WHOLE_NUMBER_PATTERN)).transform(Number)])

/**
 * A decimal number from a query string, `12.5683` or `-0.5`, and nothing
 * looser — no exponent, no hex, no blank. A query built in code may carry the
 * number itself, which is read as the string it spells.
 */
export const QueryDecimal = z.preprocess((value) => (typeof value === "number" ? String(value) : value), z.string().regex(new RegExp(DECIMAL_PATTERN), { error: DECIMAL_SHAPE }).transform(Number))

/** A flag from a query string: `true` or `false`, exactly — not `1`, `yes` or `True`. */
export const QueryFlag = z.stringbool({ truthy: ["true"], falsy: ["false"], case: "sensitive" })
