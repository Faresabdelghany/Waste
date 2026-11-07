// A rule saying no to a command, as a fact of the domain: what was refused
// and why, in one sentence a person reads. Two reasons, and the domain
// knows no more of an answer than that: the records as they stand say
// otherwise (`conflict`), or a value the command was given will not do
// (`invalid`), which names the input it came in — the member of what the
// command was handed, never a path of some request. How a refusal is
// answered is each process's own: the API maps it to its problem in its
// error handler, a worker's job counts it or fails, a script prints it.
//
// A rule a caller needs the verdict of without an exception answers a
// `Refusal` as a value; `Refused` is the one throwable that carries it.

/** Why a rule refused, and what it says. */
export type Refusal = { reason: "conflict"; sentence: string } | { reason: "invalid"; input: string; sentence: string }

/** A refusal thrown: the one exception a rule says no with, its sentence the message. */
export class Refused extends Error {
  readonly refusal: Refusal

  constructor(refusal: Refusal) {
    super(refusal.sentence)
    this.name = "Refused"
    this.refusal = refusal
  }

  /** The records as they stand say otherwise. */
  static conflict(sentence: string): Refused {
    return new Refused({ reason: "conflict", sentence })
  }

  /** A value the command was given will not do, at the input it came in. */
  static invalid(input: string, sentence: string): Refused {
    return new Refused({ reason: "invalid", input, sentence })
  }
}
