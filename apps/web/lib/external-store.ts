// Minimal external store consumed via useSyncExternalStore.
//
// The localStorage-backed providers (business records, organization, asset
// management, commercial registries, app theme) previously held their state
// in provider useState and fanned it out through context values. Under
// streaming SSR that is unsound: the layout providers hydrate and run their
// effects while route segments are still waiting for their chunks, so the
// hydration setState invalidated every dehydrated segment that consumed the
// context — React discarded the segment's server HTML and re-rendered it,
// shifting every useId after the divergence (the intermittent radix
// aria-controls hydration-mismatch console errors, easiest to reproduce with
// a cold browser cache).
//
// With an external store the context carries only this stable handle, so the
// provider never re-renders on writes. Consumers subscribe through
// useSyncExternalStore, which hydrates every component against
// getServerSnapshot — exactly what the server rendered — and only flips it to
// the live snapshot after that component has hydrated. Updates reach only
// subscribed (already-hydrated) consumers, so dehydrated segments are never
// invalidated, no matter how late their chunks arrive.
export type ExternalStore<T> = {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => T
  getServerSnapshot: () => T
  set: (updater: T | ((current: T) => T)) => void
}

export function createExternalStore<T>(serverSnapshot: T): ExternalStore<T> {
  let state = serverSnapshot
  const listeners = new Set<() => void>()
  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => state,
    // Must return a referentially stable value — React compares it across
    // hydration renders.
    getServerSnapshot: () => serverSnapshot,
    set: (updater) => {
      const next =
        typeof updater === "function"
          ? (updater as (current: T) => T)(state)
          : updater
      if (Object.is(next, state)) return
      state = next
      for (const listener of [...listeners]) listener()
    },
  }
}
