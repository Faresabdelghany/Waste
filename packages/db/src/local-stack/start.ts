// The local stack's start with one retry (Issue #437). `supabase start` and
// `supabase db start` pull their images first, and a registry's pull limit
// can fail the attempt part way, its own half-started containers left
// holding the ports (54322 first), so the CLI's next try fails on "address
// already in use" rather than on the pull. A failed start is therefore
// followed by one stop, which removes this project's containers and frees
// the ports, and one more start; a second failure is the command's.
//
// The stop keeps the database volume when there was one before the first
// attempt, so a developer's data survives a failed start. A volume the
// failed attempt created itself is dropped (`--no-backup`): Postgres may
// have initialised it before the CLI's own setup ran, and a retry that found
// it would take it as set up. A CI runner never has one, so it always drops.

/** Runs the Supabase CLI with these arguments and returns its exit code. */
export type SupabaseRunner = (args: readonly string[]) => number

export function startWithOneRetry(run: SupabaseRunner, startArguments: readonly string[], options: { volumeExisted: boolean; log?: (line: string) => void }): number {
  const first = run(startArguments)
  if (first === 0) return 0
  const log = options.log ?? console.error
  const stop = options.volumeExisted ? ["stop"] : ["stop", "--no-backup"]
  log(`@waste/db: supabase ${startArguments.join(" ")} exited ${first}; running supabase ${stop.join(" ")} to free its ports, then one retry (#437)`)
  run(stop)
  return run(startArguments)
}
