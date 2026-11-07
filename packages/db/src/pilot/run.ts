// Which run of the protected workflow a backup, a login record or an
// artifact belongs to (Issue #152): a run id and its attempt, as Actions
// numbers them, and the commit the run checked out. A phase run outside the
// workflow — the restore rehearsal on the local stack — belongs to LOCAL_RUN.

/** One attempt of one workflow run, as a backup, a login record and an artifact's name carry it. */
export type RunRef = { id: string; attempt: string }

/** A commit as GitHub names it, and as a run's `head_sha` spells it. */
export const COMMIT_ID = /^[0-9a-f]{40}$/

/** The run of every phase outside the workflow: numbered like a run, so a login record taken locally parses as one. */
export const LOCAL_RUN: { run: RunRef; commit: string } = { run: { id: "0", attempt: "1" }, commit: "0".repeat(40) }
