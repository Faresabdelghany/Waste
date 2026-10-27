// The local stack's start with one retry (Issue #437). `supabase start` and
// `supabase db start` pull their images first, and a registry's pull limit
// can fail the attempt part way, its own half-started containers left
// holding the ports (54322 first), so the CLI's next try fails on "address
// already in use" rather than on the pull. A failed start is therefore
// followed by one stop, which removes this project's containers and frees
// the ports, and one more start; a second failure is the command's.
//
// The stop keeps the data volume on a developer's machine, whatever was in
// it before the failed start, and drops it on CI (`--no-backup`), where the
// runner holds nothing a half-initialised volume could be worth keeping for.

/** Runs the Supabase CLI with these arguments and resolves to its exit code. */
export type SupabaseRunner = (args: readonly string[]) => Promise<number>

/** The stop run between the two starts: data kept locally, dropped on CI. */
export function stopArguments(ci: boolean): string[] {
  return ci ? ["stop", "--no-backup"] : ["stop"]
}

export type StartOutcome = { code: number; attempts: 1 | 2 }

export async function startWithOneRetry(run: SupabaseRunner, startArguments: readonly string[], options: { ci: boolean; log?: (line: string) => void }): Promise<StartOutcome> {
  const first = await run(startArguments)
  if (first === 0) return { code: 0, attempts: 1 }
  const log = options.log ?? console.error
  const stop = stopArguments(options.ci)
  log(`@waste/db: supabase ${startArguments.join(" ")} exited ${first}; running supabase ${stop.join(" ")} to free its ports, then one retry (#437)`)
  await run(stop)
  return { code: await run(startArguments), attempts: 2 }
}
