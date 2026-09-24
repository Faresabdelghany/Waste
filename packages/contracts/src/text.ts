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
import * as z from "zod"

/** The longest a label may be. Generous for a name, far short of an essay. */
export const LABEL_MAX = 200

/** A name or a label a person typed: present, not only whitespace, at most 200 characters. Stored as it arrived. */
export const Label = z
  .string()
  .min(1)
  .max(LABEL_MAX)
  .refine((value) => value.trim().length > 0, { message: "Give something other than whitespace" })
export type Label = z.infer<typeof Label>
