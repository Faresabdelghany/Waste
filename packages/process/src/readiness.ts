// The bound every readiness probe answers within. A probe races its read
// against a timer, so /readyz answers in time whatever the thing it asks
// does: the read's own failure is one answer, the bound passing another. A
// read the bound overtook is left to settle on its own and its late failure
// absorbed, never cancelled (`@waste/db/probe` says why for the database).

/**
 * How long a probe waits for its answer. Two seconds is under the check
 * timeout of every common balancer and orchestrator default (Kubernetes 1 s
 * at 10 s intervals as shipped, most balancers 5 s), so an instance is judged
 * on this answer, not on a probe that timed out on the caller's side.
 */
export const CHECK_TIMEOUT_MS = 2_000

export type CheckOptions = {
  timeoutMs?: number
}

export async function bounded<T>(probe: Promise<T>, failed: T, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<T>((resolve) => {
    timer = setTimeout(resolve, timeoutMs, failed)
  })
  try {
    return await Promise.race([probe.then((value) => value, () => failed), bound])
  } finally {
    clearTimeout(timer)
  }
}
