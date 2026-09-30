// Timers a test moves by hand: `advance` runs, in order of when they fall due,
// the callbacks the given milliseconds bring due, the way the browser's clock
// would, and `pending` says what is still set.
import type { Timers } from "../timers"

export type ManualTimers = Timers & {
  advance: (ms: number) => void
  /** The delays still set, in order of when they fall due. */
  pending: () => number[]
}

export function manualTimers(): ManualTimers {
  let now = 0
  let next = 1
  const set = new Map<number, { at: number; run: () => void }>()
  return {
    set: (run, ms) => {
      const handle = next++
      set.set(handle, { at: now + ms, run })
      return handle
    },
    clear: (handle) => {
      set.delete(handle as number)
    },
    advance: (ms) => {
      const until = now + ms
      for (;;) {
        const due = [...set.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0]
        if (due === undefined) break
        set.delete(due[0])
        now = due[1].at
        due[1].run()
      }
      now = until
    },
    pending: () => [...set.values()].map((timer) => timer.at - now).sort((a, b) => a - b),
  }
}
