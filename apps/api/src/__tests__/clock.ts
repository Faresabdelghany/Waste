// The one thing a test needs of the clock (Issue #97): to wait a stamp out.
// A row's `updated_at` is the transaction's `now()`, and the wire spells it
// at millisecond precision, so two requests answered inside one millisecond
// read the same instant and "the stamp moved" cannot be told from "it did
// not". A claim that the stamp moved waits the millisecond out first and
// then asserts `>`; a claim that is not about the stamp does not compare
// stamps at all. Five milliseconds, not one: the wait is against the
// database's clock as well as this process's.
//
// Not for users.test.ts or listen.test.ts, which time other things.

/** Resolves once the wire's next millisecond has surely begun. */
export const nextMillisecond = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 5))
