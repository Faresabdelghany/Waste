// The clock's timers, as the Driver App's controller and its location helper
// take them: the browser's in the page, a hand-moved set in the tests.
export type Timers = {
  set: (run: () => void, ms: number) => unknown
  clear: (handle: unknown) => void
}

export const BROWSER_TIMERS: Timers = {
  set: (run, ms) => globalThis.setTimeout(run, ms),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}
