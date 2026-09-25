// The one spelling of the text a person typed, shared by every module that
// takes one (Issue #70). `organisation.ts`, `access.ts` and `me.ts` each held
// their own `Label` before this file; three copies of a rule are three chances
// to drift, and `Me.user.fullName` had already drifted to a bare string.
//
// A label is present, not blank, and bounded. Blank is refused rather than
// trimmed away: the value the caller sent is the value the database stores, so
// trimming here would mean the resource answers something the body did not
// say. The bound is 200 characters — longer than any name, registration
// number or scope a person types, short enough that a body cannot carry a
// megabyte of text into a `text` column that has no length of its own.
//
// The Registry brought fields that are prose and not a name (Issue #78): a
// service address, a billing address, the conditions of getting into a Shared
// Collection Point, an internal note. `Paragraph` is the same rule with the
// bound a person's paragraph needs. Two schemas and not one taking a bound,
// because a field is one or the other and the schema should say which; the
// refusal is spelled once below, so a blank note and a blank name are refused
// in the same words.
import * as z from "zod"

/** The longest a label may be. Generous for a name, far short of an essay. */
export const LABEL_MAX = 200

/** The longest a paragraph may be. Room for an address, a condition or a note; still not a document. */
export const PARAGRAPH_MAX = 2000

/** The longest a key may be: a slug the rest of the system quotes, not a sentence. */
export const KEY_MAX = 50

const saysSomething = (value: string) => value.trim().length > 0
const somethingOtherThanWhitespace = { message: "Give something other than whitespace" }

/** A name or a label a person typed: present, not only whitespace, at most 200 characters. Stored as it arrived. */
export const Label = z.string().min(1).max(LABEL_MAX).refine(saysSomething, somethingOtherThanWhitespace)
export type Label = z.infer<typeof Label>

/** Prose a person typed — an address, a note, a condition: present, not only whitespace, at most 2000 characters. Stored as it arrived, newlines and all. */
export const Paragraph = z.string().min(1).max(PARAGRAPH_MAX).refine(saysSomething, somethingOtherThanWhitespace)
export type Paragraph = z.infer<typeof Paragraph>

/**
 * A lowercase slug: letters, digits and single hyphens, as `residual`,
 * `hard-plastic`, `rear-loader` — the stable key the rest of the system
 * quotes (a waste fraction's, a vehicle type's), held to the shape the
 * database holds it to (lowercase, unique per company) so two keys cannot
 * differ by case or spacing alone. One spelling for every key; `max` is
 * `KEY_MAX` unless a column says otherwise.
 */
export const Slug = (max = KEY_MAX) => z.string().max(max).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "a lowercase slug of letters, digits and single hyphens, such as food, hard-plastic or rear-loader")
