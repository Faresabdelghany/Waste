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
import { KEY_MAX, LABEL_MAX, PARAGRAPH_MAX, saysSomething, SLUG_PATTERN, SLUG_SHAPE, SOMETHING_OTHER_THAN_WHITESPACE } from "@waste/domain/text"
import * as z from "zod"

const somethingOtherThanWhitespace = { message: SOMETHING_OTHER_THAN_WHITESPACE }

/** A name or a label a person typed: present, not only whitespace, at most `LABEL_MAX` characters. Stored as it arrived. */
export const Label = z.string().min(1).max(LABEL_MAX).refine(saysSomething, somethingOtherThanWhitespace)
export type Label = z.infer<typeof Label>

/** Prose a person typed — an address, a note, a condition: present, not only whitespace, at most `PARAGRAPH_MAX` characters. Stored as it arrived, newlines and all. */
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
export const Slug = (max = KEY_MAX) => z.string().max(max).regex(new RegExp(SLUG_PATTERN), SLUG_SHAPE)
